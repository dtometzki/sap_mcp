import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { MfaRequiredError } from "./autoLogin.js";
import { AccessDeniedError, SessionExpiredError } from "./session.js";
import { ToolRunner, type ToolRunnerDeps } from "./toolRunner.js";

function createDeps(overrides: Partial<ToolRunnerDeps> = {}) {
  const calls: string[] = [];
  const deps: ToolRunnerDeps = {
    ensureSession: async () => {
      calls.push("ensure");
    },
    saveState: async () => {
      calls.push("save");
    },
    close: async () => {
      calls.push("close");
    },
    resetTokenCache: () => {
      calls.push("reset");
    },
    ...overrides,
  };
  return { deps, calls };
}

test("runSerialized executes queued operations strictly in order", async () => {
  const { deps } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const order: string[] = [];
  const first = runner.runSerialized(async () => {
    await sleep(30);
    order.push("first");
  });
  const second = runner.runSerialized(async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("runSerialized keeps the queue alive after a rejected operation", async () => {
  const { deps } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  await assert.rejects(
    runner.runSerialized(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await runner.runSerialized(async () => "ok"), "ok");
});

test("execute ensures the session, persists state, and formats the result", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => 42, (n) => `answer: ${n}`);
  assert.deepEqual(response, { content: [{ type: "text", text: "answer: 42" }] });
  assert.deepEqual(calls, ["ensure", "save"]);
});

test("execute with persistState:false never writes the state file", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => true, String, { persistState: false });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, ["ensure"]);
});

test("persistSessionState throttles rewrites to the configured interval", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  await runner.execute(async () => 1, String);
  await runner.execute(async () => 2, String);
  assert.equal(calls.filter((call) => call === "save").length, 1);

  // Interval 0 means "save every time" (the boundary where the throttle must not hold).
  const { deps: untracked, calls: alwaysSave } = createDeps();
  const runnerNoThrottle = new ToolRunner(untracked, { idleTimeoutMs: 0, stateSaveIntervalMs: 0 });
  await runnerNoThrottle.execute(async () => 1, String);
  await runnerNoThrottle.execute(async () => 2, String);
  assert.equal(alwaysSave.filter((call) => call === "save").length, 2);
});

test("execute recovers from SessionExpiredError: close + token reset, clear message", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => {
    throw new SessionExpiredError();
  }, String);
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text, /npm run login/);
  assert.ok(calls.includes("close"));
  assert.ok(calls.includes("reset"));
  // A non-expiry error in the same runner must not have torn down anything before.
});

test("execute re-logins and retries once on SessionExpiredError when reauthenticate is set", async () => {
  const { deps, calls } = createDeps({
    reauthenticate: async () => {
      calls.push("reauth");
    },
  });
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  let attempts = 0;
  const response = await runner.execute(async () => {
    attempts += 1;
    if (attempts === 1) throw new SessionExpiredError();
    return "recovered";
  }, String);
  assert.equal(response.isError, undefined);
  assert.equal(response.content[0]!.text, "recovered");
  assert.equal(attempts, 2);
  // Dead context is dropped (reset + close) before the re-login, and the retry persists.
  assert.deepEqual(calls, ["ensure", "reset", "close", "reauth", "save"]);
});

test("execute surfaces the AutoLoginError when unattended re-login cannot recover", async () => {
  const { deps } = createDeps({
    reauthenticate: async () => {
      throw new MfaRequiredError();
    },
  });
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => {
    throw new SessionExpiredError();
  }, String);
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text, /multi-factor/);
});

test("execute leaves the session alone on AccessDeniedError", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => {
    throw new AccessDeniedError("Note 1234");
  }, String);
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text, /HTTP 403/);
  assert.equal(calls.includes("close"), false);
  assert.equal(calls.includes("reset"), false);
});

test("execute wraps unknown errors without tearing the session down", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  const response = await runner.execute(async () => {
    throw new Error("network hiccup");
  }, String);
  assert.equal(response.isError, true);
  assert.equal(response.content[0]!.text, "SAP portal request failed: network hiccup");
  // The session was ensured (as always), but neither saved nor closed: the error is
  // not an expiry, so the browser stays warm for the next tool call.
  assert.deepEqual(calls, ["ensure"]);
});

test("scheduleIdleClose closes the session after the idle timeout", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 20, stateSaveIntervalMs: 60_000 });
  await runner.execute(async () => 1, String);
  assert.equal(calls.includes("close"), false);
  await sleep(80);
  assert.ok(calls.includes("close"));
});

test("idleTimeoutMs 0 never schedules an idle close", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  await runner.execute(async () => 1, String);
  await sleep(30);
  assert.equal(calls.includes("close"), false);
});

test("shutdown closes once and is idempotent", async () => {
  const { deps, calls } = createDeps();
  const runner = new ToolRunner(deps, { idleTimeoutMs: 0, stateSaveIntervalMs: 60_000 });
  await runner.shutdown(1_000);
  await runner.shutdown(1_000);
  assert.ok(calls.includes("close"));
  assert.ok(calls.includes("reset"));
  assert.equal(calls.filter((call) => call === "close").length, 1);
});
