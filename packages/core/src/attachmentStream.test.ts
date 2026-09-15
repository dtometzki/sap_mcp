import assert from "node:assert/strict";
import test from "node:test";
import { limitResponseBody, openAttachmentStream } from "./attachments.js";
import { loadConfig } from "./config.js";
import { AccessDeniedError, SessionExpiredError, type SapSession } from "./session.js";

async function drain(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(value));
  }
}

test("limited response bodies enforce the byte cap while streaming", async () => {
  const payload = new Uint8Array(8);
  const response = new Response(payload);
  let settled = 0;
  const stream = limitResponseBody(response, new AbortController().signal, () => {}, 4, () => settled++);
  await assert.rejects(drain(stream), /size limit/);
  assert.equal(settled, 1);
});

test("limited response bodies settle the watchdog when the consumer cancels", async () => {
  let cancelled = false;
  let settled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const stream = limitResponseBody(response, new AbortController().signal, () => {}, 4, () => settled++);
  await stream.cancel();
  assert.equal(cancelled, true);
  assert.equal(settled, 1);
});

test("streamed transfer resolves exact note attachments, scopes cookies and rejects portal errors", async () => {
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
  const open = (name: string) => openAttachmentStream(session, config, "1969700", name, signal);
  try {
    const result = await open(fileName);
    assert.equal(result.fileName, fileName);
    assert.equal(result.contentType, contentType);
    assert.equal((await drain(result.body)).toString(), "PK\x03\x04");
    const byCase = await open(fileName.toUpperCase());
    assert.equal(byCase.fileName, fileName);
    await byCase.body.cancel();
    await assert.rejects(open("missing.zip"), /no attachment matching/);
    assert.equal(calls, 2);
    status = 403; await assert.rejects(open(fileName), AccessDeniedError);
    status = 401; await assert.rejects(open(fileName), SessionExpiredError);
    status = 200; contentType = "text/html";
    await assert.rejects(open(fileName), /HTML page/);
  } finally { globalThis.fetch = original; }
});
