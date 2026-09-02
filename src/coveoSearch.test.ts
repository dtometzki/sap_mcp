import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  CoveoTokenRejectedError,
  isTransientError,
  resetTokenCache,
  searchNotes,
  searchNotesViaDom,
} from "./notes.js";
import type { NoteHit } from "./notes.js";
import type { SapSession } from "./session.js";

/**
 * Exercises the token-renewal path of the Coveo search with a scripted request context:
 * a token that Coveo rejects must be fetched fresh exactly once, and a second rejection
 * must surface instead of looping.
 */

interface Scripted {
  status: number;
  body: unknown;
}

function fakeResponse(url: string, { status, body }: Scripted) {
  return {
    url: () => url,
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    dispose: () => Promise.resolve(),
  };
}

function noteResult(id: string) {
  return { title: `${id} - Note ${id}`, raw: { mh_id: id, source: "SAP-Note" } };
}

/**
 * `tokens` are handed out per token request, `searches` per search POST (in order).
 * `domHits` scripts the DOM fallback: undefined = it must not run at all.
 */
function fakeSession(tokens: string[], searches: Scripted[], domHits?: NoteHit[]) {
  const calls = { token: 0, search: 0, bearers: [] as string[], dom: 0 };
  const config = loadConfig();
  const session = {
    request: () => ({
      get: () => {
        const token = tokens[calls.token] ?? "exhausted";
        calls.token += 1;
        return Promise.resolve(fakeResponse(config.coveoTokenUrl, { status: 200, body: { token } }));
      },
      post: (_url: string, init: { headers: Record<string, string> }) => {
        calls.bearers.push(init.headers.authorization ?? "");
        const scripted = searches[calls.search] ?? { status: 500, body: {} };
        calls.search += 1;
        return Promise.resolve(fakeResponse(config.coveoSearchUrl, scripted));
      },
    }),
    withOpenPage: (_url: string, fn: (page: unknown) => Promise<NoteHit[]>) => {
      calls.dom += 1;
      if (!domHits) return Promise.reject(new Error("DOM fallback must not run"));
      return fn({
        $$eval: () =>
          Promise.resolve(domHits.map((hit) => ({ href: hit.url, text: `${hit.id} - ${hit.title}` }))),
      });
    },
  } as unknown as SapSession;
  return { session, config, calls };
}

test("a rejected Coveo token is renewed once and the search continues", async () => {
  resetTokenCache();
  const { session, config, calls } = fakeSession(
    ["stale", "fresh"],
    [
      { status: 401, body: {} },
      { status: 200, body: { results: [noteResult("1234567")], totalCount: 1 } },
    ],
  );
  const hits = await searchNotes(session, config, "hana", 10);
  assert.deepEqual(hits.map((hit) => hit.id), ["1234567"]);
  assert.equal(calls.token, 2);
  assert.deepEqual(calls.bearers, ["Bearer stale", "Bearer fresh"]);
});

test("a second token rejection is reported instead of retried forever", async () => {
  resetTokenCache();
  const { session, config, calls } = fakeSession(
    ["stale", "fresh", "never"],
    [
      { status: 403, body: {} },
      { status: 403, body: {} },
    ],
  );
  // searchNotes falls back to the DOM scrape (stubbed to fail loudly); the reported
  // error must carry BOTH the rejection and the fallback failure, and no third token
  // may be requested.
  await assert.rejects(
    searchNotes(session, config, "hana", 10),
    /HTTP 403.*DOM fallback must not run/,
  );
  assert.equal(calls.token, 2);
  assert.equal(calls.search, 2);
});

test("CoveoTokenRejectedError carries the status and is not transient", () => {
  const error = new CoveoTokenRejectedError(401);
  assert.equal(error.name, "CoveoTokenRejectedError");
  assert.match(error.message, /HTTP 401/);
  assert.equal(isTransientError(error), false);
});

test("searchNotesViaDom stays reachable as the documented fallback", () => {
  assert.equal(typeof searchNotesViaDom, "function");
});

test("an empty DOM fallback after a Coveo failure is reported as an error, not as no hits", async () => {
  resetTokenCache();
  const { session, config, calls } = fakeSession(["t"], [{ status: 500, body: {} }], []);
  await assert.rejects(
    searchNotes(session, config, "hana", 10),
    /Search failed: .*HTTP 500.*found nothing either/,
  );
  assert.equal(calls.dom, 1);
});

test("a DOM fallback with hits still answers when Coveo is down", async () => {
  resetTokenCache();
  const { session, config } = fakeSession(["t"], [{ status: 500, body: {} }], [
    { id: "1234567", title: "Fallback note", url: "https://me.sap.com/notes/1234567" },
  ]);
  const hits = await searchNotes(session, config, "hana", 10);
  assert.deepEqual(hits, [
    { id: "1234567", title: "Fallback note", url: "https://me.sap.com/notes/1234567" },
  ]);
});

test("HTTP 429 counts as transient, other 4xx do not", () => {
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 429")), true);
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 404")), false);
});
