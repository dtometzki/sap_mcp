import assert from "node:assert/strict";
import test from "node:test";
import type { Browser, BrowserContext } from "playwright";
import { loadConfig } from "./config.js";
import { cookieHeaderFromState, SapSession, type ApiContext, type SessionState } from "./session.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeApi(): { api: ApiContext; closed: { api: number } } {
  const closed = { api: 0 };
  const api: ApiContext = {
    get: async () => { throw new Error("unused"); },
    post: async () => { throw new Error("unused"); },
    storageState: async () => ({ cookies: [] }),
    dispose: async () => { closed.api += 1; },
  };
  return { api, closed };
}

function fakeBrowser(): {
  browser: Pick<Browser, "newContext" | "close">;
  closed: { browser: number; context: number };
} {
  const closed = { browser: 0, context: 0 };
  const context = {
    setDefaultNavigationTimeout: () => undefined,
    cookies: async () => [],
    storageState: async () => ({ cookies: [], origins: [] }),
    newPage: async () => { throw new Error("unused"); },
    close: async () => {
      closed.context += 1;
    },
  };
  const browser = {
    newContext: async () => context as unknown as BrowserContext,
    close: async () => {
      closed.browser += 1;
    },
  };
  return { browser, closed };
}

test("close waits for an in-flight start and disposes the API context", async () => {
  const launch = deferred<ApiContext>();
  const { api, closed } = fakeApi();
  const session = new SapSession(
    loadConfig(),
    true,
    undefined,
    async () => { throw new Error("browser must not start"); },
    () => launch.promise,
  );
  const started = session.start({ allowMissingState: true, ignoreStoredState: true });
  const closing = session.close();
  launch.resolve(api);
  await closing;
  await started;
  assert.equal(closed.api, 1);
});

test("start does not launch Chromium; closeBrowser drops it and close disposes the API", async () => {
  const { browser, closed } = fakeBrowser();
  const { api, closed: apiClosed } = fakeApi();
  let browsers = 0;
  const session = new SapSession(
    loadConfig(),
    true,
    undefined,
    async () => { browsers += 1; return browser; },
    async () => api,
  );
  await session.start({ allowMissingState: true, ignoreStoredState: true });
  assert.equal(browsers, 0);
  await session.closeBrowser();
  assert.equal(closed.browser, 0);
  await session.newPage().catch(() => undefined);
  assert.equal(browsers, 1);
  await session.closeBrowser();
  assert.equal(closed.browser, 1);
  assert.equal(closed.context, 1);
  await session.close();
  await session.close();
  assert.ok(apiClosed.api >= 1);
  assert.equal(closed.browser, 1);
});

test("cookieHeaderFromState matches domain, path, secure and expiry", () => {
  const state: SessionState = {
    cookies: [
      { name: "a", value: "1", domain: ".sap.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "b", value: "2", domain: "me.sap.com", path: "/backend", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "c", value: "3", domain: "me.sap.com", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "d", value: "4", domain: "evil.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ],
    origins: [],
  };
  const header = cookieHeaderFromState(state, "https://me.sap.com/backend/raw/x");
  assert.match(header, /a=1/);
  assert.match(header, /b=2/);
  assert.doesNotMatch(header, /c=3/);
  assert.doesNotMatch(header, /d=4/);
  assert.equal(cookieHeaderFromState(state, "http://me.sap.com/"), "");
});
