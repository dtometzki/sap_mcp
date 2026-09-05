import assert from "node:assert/strict";
import test from "node:test";
import { readAttachmentBytes, downloadAttachmentBytes } from "./attachments.js";
import { loadConfig } from "./config.js";
import { AccessDeniedError, SessionExpiredError, type SapSession } from "./session.js";

test("memory downloads preserve binary data and enforce declared and actual size limits", async () => {
  const signal = new AbortController().signal;
  const payload = new Uint8Array([80, 75, 3, 4, 0, 255]);
  let touches = 0;
  assert.deepEqual(await readAttachmentBytes(new Response(payload), signal, () => touches++, 6), Buffer.from(payload));
  assert.equal(touches, 1);
  await assert.rejects(readAttachmentBytes(new Response(payload, { headers: { "content-length": "100" } }), signal, () => {}, 6), /size limit/);
  await assert.rejects(readAttachmentBytes(new Response(payload, { headers: { "content-length": "1" } }), signal, () => {}, 5), /size limit/);
});

test("memory downloads cancel a stalled stream on lock or client disconnect", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readAttachmentBytes(response, controller.signal, () => {});
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("browser transfer resolves exact note attachments, scopes cookies and rejects portal errors", async () => {
  const config = loadConfig();
  const fileName = "SQLStatements.zip";
  const url = "https://me.sap.com/attachment/collection";
  const session = {
    request: () => ({ get: () => Promise.resolve({
      url: () => config.noteDetailApiUrlTemplate.replace("{id}", "1969700"),
      status: () => 200, ok: () => true, headers: () => ({}), dispose: () => Promise.resolve(),
      json: () => Promise.resolve({ Attachments: [{ FileName: fileName, URL: url }] }),
    }) }),
    cookieHeader: (target: string) => { assert.equal(target, url); return Promise.resolve("SAP-session=fixture"); },
  } as unknown as SapSession;
  const original = globalThis.fetch;
  let status = 200;
  let calls = 0;
  let contentType = "application/zip";
  globalThis.fetch = async (input, init) => {
    calls++; assert.equal(input, url); assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("cookie"), "SAP-session=fixture");
    return new Response("PK\x03\x04", { status, headers: { "content-type": contentType } });
  };
  const signal = new AbortController().signal;
  try {
    const result = await downloadAttachmentBytes(session, config, "1969700", fileName, signal);
    assert.equal(result.fileName, fileName); assert.equal(result.data.toString(), "PK\x03\x04");
    await assert.rejects(downloadAttachmentBytes(session, config, "1969700", "SQLStatements", signal), /no longer available/);
    assert.equal(calls, 1);
    status = 403; await assert.rejects(downloadAttachmentBytes(session, config, "1969700", fileName, signal), AccessDeniedError);
    status = 401; await assert.rejects(downloadAttachmentBytes(session, config, "1969700", fileName, signal), SessionExpiredError);
    status = 200; contentType = "text/html";
    await assert.rejects(downloadAttachmentBytes(session, config, "1969700", fileName, signal), /HTML page/);
  } finally { globalThis.fetch = original; }
});
