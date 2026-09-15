import assert from "node:assert/strict";
import test from "node:test";
import type { Browser, BrowserContext } from "playwright";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeBrowser(): {
  browser: Pick<Browser, "newContext" | "close">;
  closed: { browser: number; context: number };
} {
  const closed = { browser: 0, context: 0 };
  const context = {
    setDefaultNavigationTimeout: () => undefined,
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

test("close waits for an in-flight start and closes the launched browser", async () => {
  const launch = deferred<Pick<Browser, "newContext" | "close">>();
  const { browser, closed } = fakeBrowser();
  const session = new SapSession(
    loadConfig(),
    true,
    undefined,
    () => launch.promise,
  );
  const started = session.start({ allowMissingState: true, ignoreStoredState: true });
  const closing = session.close();
  launch.resolve(browser);
  await closing;
  await started;
  assert.equal(closed.browser, 1);
  assert.equal(closed.context, 0);
});

test("close after a finished start closes context and browser once", async () => {
  const { browser, closed } = fakeBrowser();
  const session = new SapSession(loadConfig(), true, undefined, async () => browser);
  await session.start({ allowMissingState: true, ignoreStoredState: true });
  await session.close();
  await session.close();
  assert.equal(closed.context, 1);
  assert.equal(closed.browser, 1);
});
