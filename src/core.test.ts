import assert from "node:assert/strict";
import test from "node:test";
import { buildUrl } from "./config.js";
import {
  coerceField,
  extractNoteId,
  isTransientError,
  mapCoveoResult,
  parseCoveoResponse,
} from "./notes.js";
import { looksLikeLoginPage } from "./session.js";

test("buildUrl encodes values and replaces repeated placeholders", () => {
  assert.equal(
    buildUrl("https://example.test/{query}?again={query}", { query: "HANA error 447" }),
    "https://example.test/HANA%20error%20447?again=HANA%20error%20447",
  );
  assert.throws(
    () => buildUrl("https://example.test/{missing}", {}),
    /placeholder \{missing\} has no value/,
  );
});

test("extractNoteId supports current and legacy SAP routes", () => {
  assert.equal(extractNoteId("https://me.sap.com/notes/1234567"), "1234567");
  assert.equal(extractNoteId("https://support.sap.com/knowledge/en/7654321"), "7654321");
  assert.equal(extractNoteId("https://example.test/?note_number=246810"), "246810");
  assert.equal(extractNoteId("https://me.sap.com/products"), undefined);
});

test("parseCoveoResponse accepts expected API fields", () => {
  const response = parseCoveoResponse({
    totalCount: 1,
    duration: 12,
    results: [
      {
        title: "1234567 - Example",
        clickUri: "https://launchpad.support.sap.com/#/notes/1234567",
        raw: { mh_id: "1234567", source: ["SAP-Note"] },
        score: 0.98,
      },
    ],
  });

  assert.equal(response.totalCount, 1);
  assert.equal(response.results[0]?.raw?.mh_id, "1234567");
});

test("parseCoveoResponse rejects silent schema changes", () => {
  assert.throws(() => parseCoveoResponse({ totalCount: 0 }), /Unexpected Coveo response schema/);
  assert.throws(
    () => parseCoveoResponse({ results: [{ raw: "not-an-object" }] }),
    /Unexpected Coveo response schema/,
  );
});

test("looksLikeLoginPage recognizes common identity-provider URLs", () => {
  assert.equal(looksLikeLoginPage("https://accounts.sap.com/saml2/idp/sso"), true);
  assert.equal(looksLikeLoginPage("https://me.sap.com/notes/2170696"), false);
});

const NOTE_URL_TEMPLATE = "https://me.sap.com/notes/{id}";

test("mapCoveoResult maps a Note result and cleans the title", () => {
  const hit = mapCoveoResult(
    {
      title: "1234567 - Example note title - SAP for Me",
      clickUri: "https://launchpad.support.sap.com/#/notes/1234567",
      raw: { mh_id: "1234567", source: ["SAP-Note"] },
    },
    NOTE_URL_TEMPLATE,
  );
  assert.deepEqual(hit, {
    id: "1234567",
    title: "Example note title",
    url: "https://me.sap.com/notes/1234567",
  });
});

test("mapCoveoResult accepts KBA sources and sapnotes clickUris", () => {
  assert.equal(
    mapCoveoResult(
      { title: "A KBA", raw: { mh_id: "7654321", source: "Knowledge-Base-Article" } },
      NOTE_URL_TEMPLATE,
    )?.id,
    "7654321",
  );
  assert.equal(
    mapCoveoResult(
      {
        title: "Via clickUri",
        clickUri: "https://me.sap.com/sapnotes/246810",
        raw: { mh_id: "246810", source: "Something-Else" },
      },
      NOTE_URL_TEMPLATE,
    )?.id,
    "246810",
  );
});

test("mapCoveoResult filters non-note results and missing ids", () => {
  // Blog post: has an id but the wrong source and no notes clickUri.
  assert.equal(
    mapCoveoResult(
      { title: "A blog post", raw: { mh_id: "1234567", source: "SAP-Blog" } },
      NOTE_URL_TEMPLATE,
    ),
    undefined,
  );
  // Documentation: no numeric note id at all.
  assert.equal(
    mapCoveoResult({ title: "Docs", raw: { source: "SAP-Note" } }, NOTE_URL_TEMPLATE),
    undefined,
  );
});

test("mapCoveoResult falls back to a generated title", () => {
  const hit = mapCoveoResult(
    { title: "", raw: { mh_id: "1234567", source: "SAP-Note" } },
    NOTE_URL_TEMPLATE,
  );
  assert.equal(hit?.title, "SAP Note 1234567");
});

test("coerceField normalizes scalars, arrays, and edge cases", () => {
  assert.equal(coerceField("hello"), "hello");
  assert.equal(coerceField(42), "42");
  assert.equal(coerceField(true), "true");
  assert.equal(coerceField(["single"]), "single");
  assert.equal(coerceField([123]), "123");
  assert.equal(coerceField([]), "");
  assert.equal(coerceField(null), "");
  assert.equal(coerceField(undefined), "");
  assert.equal(coerceField({ nested: true }), "");
});

test("isTransientError retries 5xx and network errors, not 4xx or logic errors", () => {
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 502")), true);
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 503")), true);
  assert.equal(isTransientError(new Error("net::ERR_CONNECTION_RESET")), true);
  assert.equal(isTransientError(new Error("fetch failed")), true);
  assert.equal(isTransientError(new Error("Coveo token request failed: HTTP 401")), false);
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 400")), false);
  assert.equal(isTransientError(new Error("Note 1234 returned no readable content")), false);
  assert.equal(isTransientError("not an error"), false);
});
