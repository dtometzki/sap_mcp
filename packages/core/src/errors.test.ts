import assert from "node:assert/strict";
import test from "node:test";
import { request } from "playwright";
import { PublicError, safeErrorMessage } from "./errors.js";
import { loadConfig } from "./config.js";
import { resetTokenCache, searchNotes } from "./notes.js";
import { fetchAttachmentList } from "./attachments.js";
import { SessionExpiredError, type SapSession } from "./session.js";
import { ToolRunner } from "./toolRunner.js";

const secretError = new Error(
  'apiRequestContext.post: ECONNRESET at https://me.sap.com/secret-path?token=URL_SECRET\n' +
  'Call log:\n - authorization: Bearer BEARER_SECRET\n - cookie: SESSION_SECRET\n' +
  ' - fill("PASSWORD_SECRET")',
);

function runner(reauthenticate?: () => Promise<void>): ToolRunner {
  return new ToolRunner({
    ensureSession: async () => {},
    saveState: async () => {},
    close: async () => {},
    resetTokenCache: () => {},
    reauthenticate,
  }, { idleTimeoutMs: 0, stateSaveIntervalMs: 0 });
}

test("only explicit application errors retain their message, never causes or arbitrary thrown values", () => {
  assert.equal(safeErrorMessage(new PublicError("HTTP 503", { cause: secretError })), "HTTP 503");
  for (const value of [secretError, new Error("PASSWORD_SECRET"), "SESSION_SECRET", { token: "BEARER_SECRET" }]) {
    assert.doesNotMatch(safeErrorMessage(value), /SECRET|secret-path|Call log/);
  }
  assert.match(safeErrorMessage(secretError), /Network request failed/);
});

test("invalid configuration names the setting without echoing secret URL values", () => {
  const previous = process.env.SAP_COVEO_TOKEN_URL;
  process.env.SAP_COVEO_TOKEN_URL = "https://foreign.example/SECRET?token=URL_SECRET";
  try {
    assert.throws(loadConfig, (error: unknown) => {
      const message = safeErrorMessage(error);
      assert.match(message, /SAP_COVEO_TOKEN_URL/);
      assert.doesNotMatch(message, /SECRET|foreign\.example/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.SAP_COVEO_TOKEN_URL;
    else process.env.SAP_COVEO_TOKEN_URL = previous;
  }
});

test("a real Playwright request failure does not leak headers or URL tokens to MCP", async () => {
  const context = await request.newContext();
  try {
    const result = await runner().execute(
      () => context.post("http://127.0.0.1:1/secret-path?token=URL_SECRET", {
        headers: { authorization: "Bearer BEARER_SECRET", cookie: "session=SESSION_SECRET" },
        timeout: 500,
      }),
      () => "unexpected success",
    );
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0]!.text, /SECRET|secret-path|authorization|cookie|Call log/i);
  } finally {
    await context.dispose();
  }
});

test("automatic login errors cannot write password fill logs to stderr", async (t) => {
  const captured: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    captured.push(chunk.toString());
    return true;
  });
  const result = await runner(async () => { throw secretError; }).execute(
    async () => { throw new SessionExpiredError(); }, String,
  );
  assert.equal(result.isError, true);
  assert.match(captured.join(""), /automatic login failed/);
  assert.doesNotMatch(captured.join(""), /SECRET|secret-path|fill\(|Call log/);
});

test("search and attachment fallback logs and composed MCP errors stay free of secrets", async (t) => {
  const captured: string[] = [];
  t.mock.method(console, "error", (text: string) => { captured.push(text); });
  // Both the primary call and fallback fail with a realistic library diagnostic.
  const session = {
    request: () => ({ get: async () => { throw new Error("PASSWORD_SECRET"); } }),
    withOpenPage: async () => { throw secretError; },
  } as unknown as SapSession;
  const config = loadConfig();
  resetTokenCache();
  for (const operation of [
    () => searchNotes(session, config, "hana", 1),
    () => fetchAttachmentList(session, config, "1234567"),
  ]) {
    const result = await runner().execute(operation, String);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0]!.text, /SECRET|secret-path|Call log/);
  }
  assert.equal(captured.length, 2);
  assert.doesNotMatch(captured.join(""), /SECRET|secret-path|Call log/);
});
