import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { request, type APIRequestContext, type APIResponse } from "playwright";
import { rejectApiRedirect } from "./api.js";
import { fetchAttachmentList } from "./attachments.js";
import { loadConfig } from "./config.js";
import { resetTokenCache, searchNotes } from "./notes.js";
import { SessionExpiredError, type SapSession } from "./session.js";

test("API login redirects signal expiry without exposing the Location", () => {
  for (const location of ["https://accounts.sap.com/login?token=SECRET", "https://accounts.sap.cn/login"]) {
    const response = {
      status: () => 302,
      headers: () => ({ location }),
      url: () => "https://me.sap.com/backend/test",
    } as unknown as APIResponse;
    assert.throws(() => rejectApiRedirect(response), SessionExpiredError);
  }
});

test("foreign, malformed and missing redirect locations fail closed", () => {
  for (const location of ["http://127.0.0.1/admin", "https://campaign.sap.com/login", "https://accounts.sap.com:8443/login", "http://[", ""]) {
    const response = {
      status: () => 307,
      headers: () => ({ location }),
      url: () => "https://me.sap.com/backend/test",
    } as unknown as APIResponse;
    assert.throws(() => rejectApiRedirect(response), /API redirect refused \(HTTP 307\)/);
  }
});

/**
 * Map only the initial SAP/Coveo URL to a loopback fixture. The actual Playwright
 * HTTP client still handles redirects, headers and bodies. If a production call
 * forgets maxRedirects: 0, the local /sink receives the forbidden follow-up.
 */
test("token, search and detail calls never follow HTTP redirects", async (t) => {
  t.mock.method(console, "error", () => {});
  let phase = "token";
  let redirectStatus = 302;
  let sinkRequests = 0;
  let origin = "";
  const server = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? "/", origin).pathname;
    incoming.resume();
    if (path === "/sink") {
      sinkRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"results":[],"token":"unexpected"}');
    } else if (path === `/${phase}`) {
      response.writeHead(redirectStatus, { location: `${origin}/sink?token=SECRET` });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"token":"DUMMY_BEARER"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const context = await request.newContext();
  try {
    const adapt = async (method: "get" | "post", url: string, options: Parameters<APIRequestContext["get"]>[1]) => {
      const result = await context[method](`${origin}${new URL(url).pathname}`, options);
      return {
        url: () => url,
        status: () => result.status(),
        ok: () => result.ok(),
        headers: () => result.headers(),
        json: () => result.json() as Promise<unknown>,
        dispose: () => result.dispose(),
      };
    };
    const session = {
      request: () => ({
        get: (url: string, options: Parameters<APIRequestContext["get"]>[1]) => adapt("get", url, options),
        post: (url: string, options: Parameters<APIRequestContext["post"]>[1]) => adapt("post", url, options),
      }),
      withOpenPage: async () => [],
    } as unknown as SapSession;
    const config = {
      ...loadConfig(),
      coveoTokenUrl: "https://me.sap.com/token",
      coveoSearchUrl: "https://example.org.coveo.com/search",
      noteDetailApiUrlTemplate: "https://me.sap.com/detail",
    };
    for (phase of ["token", "search", "detail"]) {
      for (redirectStatus of [301, 302, 303, 307, 308]) {
        resetTokenCache();
        const operation = phase === "detail"
          ? fetchAttachmentList(session, config, "1234567")
          : searchNotes(session, config, "hana", 1);
        await assert.rejects(operation, /API redirect refused/);
        assert.equal(sinkRequests, 0, `${phase}: HTTP ${redirectStatus} must not reach the sink`);
      }
    }
  } finally {
    await context.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
