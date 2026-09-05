import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { chromium, type Browser } from "playwright";
import { randomUUID } from "node:crypto";
import { MAX_HISTORY, Vault, WebError } from "./web/vault.js";
import { WebService, type SapGateway, type SapStatus } from "./web/sap.js";
import { createWebServer, describeListenError, type WebServerOptions } from "./web/http.js";
import { renderNote } from "./web/markdown.js";
import { loadAppInfo, type AppInfo } from "./web/about.js";
import { SapSession, AccessDeniedError, SessionExpiredError, type SessionState, type SessionStore } from "./session.js";
import { loadConfig } from "./config.js";
import type { NoteHit } from "./notes.js";

const PASSWORD = "master test password 123";
const SECOND = "a different master password";
const SAP_PASSWORD = "SECRET-SAP-password";
const COOKIE_SECRET = "SECRET-cookie-value";
const storage: SessionState = { cookies: [{ name: "session", value: COOKIE_SECRET, domain: "me.sap.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] };
async function temporary() { const directory = await mkdtemp(join(tmpdir(), "sap-web-test-")); return { directory, path: join(directory, "vault.enc") }; }

// Actual production scrypt parameters, never substituted with a weaker KDF in tests.
test("vault encrypts all secrets, survives restart, rejects corruption and rotates the password", async () => {
  const { directory, path } = await temporary();
  try {
    const vault = new Vault(path);
    await vault.setup(PASSWORD);
    await vault.update(data => { data.credentials = { username: "S123", password: SAP_PASSWORD }; data.session = storage; data.history.push({ id: randomUUID(), query: "private incident search", limit: 10, count: 0, at: new Date().toISOString() }); });
    const first = await readFile(path, "utf8");
    for (const secret of [PASSWORD, SAP_PASSWORD, COOKIE_SECRET, "private incident search", "S123"]) assert.ok(!first.includes(secret));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(directory), ["vault.enc"]);
    await vault.update(() => undefined);
    assert.notEqual(first, await readFile(path, "utf8"));
    vault.lock(); assert.throws(() => vault.snapshot(), { code: "LOCKED" });
    const restarted = new Vault(path);
    await assert.rejects(restarted.unlock(SECOND), { code: "UNLOCK_FAILED" });
    assert.equal(restarted.unlocked, false);
    await restarted.unlock(PASSWORD);
    assert.equal(restarted.snapshot().credentials?.password, SAP_PASSWORD);
    assert.deepEqual(restarted.snapshot().session, storage);
    await assert.rejects(restarted.changePassword(SECOND, SECOND), { code: "UNLOCK_FAILED" });
    await restarted.changePassword(PASSWORD, SECOND); restarted.lock();
    await assert.rejects(restarted.unlock(PASSWORD), { code: "UNLOCK_FAILED" });
    await restarted.unlock(SECOND); assert.equal(restarted.snapshot().history.length, 1); restarted.lock();
    const valid = await readFile(path, "utf8");
    const envelope = JSON.parse(valid) as { tag: string; version: number };
    envelope.tag = (envelope.tag.startsWith("00") ? "ff" : "00") + envelope.tag.slice(2);
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(restarted.unlock(SECOND), { code: "UNLOCK_FAILED" });
    assert.equal(restarted.unlocked, false);
    envelope.tag = "aa"; await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(restarted.unlock(SECOND), { code: "UNLOCK_FAILED" });
    await writeFile(path, valid);
    await assert.rejects(restarted.setup(PASSWORD), { code: "EXISTS" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("vault serializes writes and lock invalidates queued work and an in-progress unlock", async () => {
  const { directory, path } = await temporary();
  try {
    const vault = new Vault(path); await vault.setup(PASSWORD);
    await Promise.all(Array.from({ length: 8 }, (_, index) => vault.update(data => { data.history.push({ id: randomUUID(), query: `query ${index}`, limit: 10, count: 1, at: new Date().toISOString() }); })));
    assert.equal(vault.snapshot().history.length, 8);
    const pending = vault.update(data => { data.history = []; }); vault.lock();
    await assert.rejects(pending, { code: "LOCKED" });
    const unlock = vault.unlock(PASSWORD); vault.lock(); await assert.rejects(unlock, { code: "LOCKED" });
    assert.equal(vault.unlocked, false);
    await vault.unlock(PASSWORD); assert.equal(vault.snapshot().history.length, 8);
    const malformed = new Vault(join(directory, "bad.enc")); await writeFile(malformed.path, "broken");
    await assert.rejects(malformed.unlock(PASSWORD), { code: "UNLOCK_FAILED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class FakeSap implements SapGateway {
  status: SapStatus = "unknown";
  calls: string[] = [];
  failure?: Error;
  waitForSearch?: Promise<void>;
  constructor(readonly store: SessionStore) {}
  async check() { if (this.failure) throw this.failure; this.status = "authenticated" as const; return this.status; }
  async search(query: string): Promise<NoteHit[]> {
    this.calls.push(query); await this.waitForSearch;
    if (this.failure) throw this.failure;
    return query === "zero" ? [] : [{ id: "2170696", title: "HANA <script>alert(1)</script>", url: "https://me.sap.com/notes/2170696" }];
  }
  async note(number: string) { if (this.failure) throw this.failure; return { id: number, title: "HANA troubleshooting", url: `https://me.sap.com/notes/${number}`, markdown: "# Symptom\n\nA **bold** solution.\n\n<script>alert(1)</script>\n\n![track](https://example.com/pixel)\n\n[unsafe](javascript:alert(1))" }; }
  async interactiveStart() { this.status = "interactive"; }
  async interactiveFinish() { this.status = "authenticated"; await this.store.save(storage); }
  async interactiveCancel() { this.status = "login_required"; }
  async close() { this.status = "unknown"; }
}
async function fixture(options: WebServerOptions = {}) {
  const temp = await temporary();
  const vault = new Vault(temp.path);
  const gateways: FakeSap[] = [];
  const service = new WebService(vault, store => { const gateway = new FakeSap(store); gateways.push(gateway); return gateway; });
  const server = createWebServer(service, options);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  const origin = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  async function request(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }) });
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0] ?? "";
    return response;
  }
  async function cleanup() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await service.lock(); await rm(temp.directory, { recursive: true, force: true }); }
  return { ...temp, origin, service, vault, server, request, gateways, cleanup };
}

test("HTTP API enforces authentication, host/origin protection and private no-store responses", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/")).status, 200);
    const about = await (await f.request("/api/about")).json() as AppInfo;
    assert.equal(about.name, "SAP Notes");
    assert.match(about.version, /^\d+\.\d+\.\d+/);
    assert.ok(about.commit); assert.match(about.commit.hash, /^[a-f0-9]{40,64}$/);
    assert.equal((await f.request("/api/about", "GET", undefined, { Origin: "https://evil.example" })).status, 403);
    assert.match(await (await f.request("/app.js")).text(), /unlock-form/);
    for (const path of ["/api/history", "/api/notes/2170696"]) assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request("/api/setup", "POST", { password: PASSWORD }, { Origin: "https://evil.example" })).status, 403);
    const wrongHost = await new Promise<number>(resolve => {
      const request = httpRequest(f.origin + "/api/state", { headers: { Host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await f.request("/api/setup", "POST", { password: PASSWORD }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await fetch(f.origin + "/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).status, 403);
    assert.equal((await f.request("/api/setup", "POST", { password: "short" })).status, 400);
    const setup = await f.request("/api/setup", "POST", { password: PASSWORD });
    assert.equal(setup.status, 200);
    assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    assert.equal(setup.headers.get("cache-control"), "no-store");
    assert.equal(setup.headers.get("access-control-allow-origin"), null);
    assert.match(setup.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal((await f.request("/api/credentials", "PUT", { username: "S123", password: SAP_PASSWORD })).status, 200);
    const state = await (await f.request("/api/state")).text(); assert.ok(!state.includes(SAP_PASSWORD)); assert.ok(state.includes("S123"));
    assert.equal((await f.request("/api/search", "POST", { query: "a" })).status, 400);
    assert.equal((await f.request("/api/search", "POST", { query: "hello", limit: 26 })).status, 400);
    assert.equal((await f.request("/api/notes/not-a-number")).status, 400);
    assert.equal((await f.request("/api/search", "POST", { query: "x".repeat(17000) })).status, 413);
    assert.equal((await f.request("/api/lock", "POST")).status, 200);
    assert.equal((await f.request("/api/history")).status, 401);
    assert.equal((await f.request("/api/unlock", "POST", { password: PASSWORD })).status, 200);
    assert.equal((await f.request("/api/history")).status, 200);
    assert.equal((await f.request("/api/history", "GET", undefined, { Cookie: "sap_web=wrong" })).status, 401);
    for (let index = 0; index < 3; index++) assert.equal((await f.request("/api/unlock", "POST", { password: SECOND })).status, 401);
    assert.equal((await f.request("/api/unlock", "POST", { password: SECOND })).status, 429);
  } finally { await f.cleanup(); }
});

test("search history records successes and zero hits, replays, filters and deletes; failures stay distinct", async () => {
  const f = await fixture();
  try {
    await f.request("/api/setup", "POST", { password: PASSWORD });
    await f.request("/api/search", "POST", { query: "HANA backup", limit: 5 });
    await f.request("/api/search", "POST", { query: "zero", limit: 25 });
    let history = await (await f.request("/api/history")).json() as { entries: { id: string; query: string; count: number; limit: number }[]; total: number };
    assert.equal(history.total, 2); assert.equal(history.entries[0]?.count, 0); assert.equal(history.entries[0]?.limit, 25);
    const filtered = await (await f.request("/api/history?q=hana")).json() as typeof history;
    assert.equal(filtered.total, 1);
    const entry = filtered.entries[0]; assert.ok(entry);
    await f.request("/api/search", "POST", { query: entry.query, limit: entry.limit });
    const gateway = f.gateways[0]; assert.ok(gateway);
    for (const [error, code, status] of [
      [new AccessDeniedError("Note"), "ACCESS_DENIED", 403],
      [new SessionExpiredError(), "LOGIN_REQUIRED", 409],
      [new WebError("MFA_REQUIRED", "MFA", 409), "MFA_REQUIRED", 409],
      [new Error(`network headers password ${SAP_PASSWORD} ${COOKIE_SECRET}`), "PORTAL_ERROR", 502],
    ] as const) {
      gateway.failure = error;
      const response = await f.request("/api/search", "POST", { query: "failed search" }); assert.equal(response.status, status);
      const text = await response.text(); assert.ok(text.includes(code)); assert.ok(!text.includes(SAP_PASSWORD)); assert.ok(!text.includes(COOKIE_SECRET));
    }
    gateway.failure = undefined;
    history = await (await f.request("/api/history")).json() as typeof history; assert.equal(history.total, 3);
    const note = await (await f.request("/api/notes/2170696")).json() as { html: string };
    assert.match(note.html, /<strong>bold<\/strong>/); assert.ok(!note.html.includes("<script>")); assert.ok(!note.html.includes("<img")); assert.ok(!note.html.includes('href="javascript:'));
    assert.equal((await f.request(`/api/history/${entry.id}`, "DELETE")).status, 200);
    assert.equal(f.vault.snapshot().history.length, 2);
    await f.request("/api/history", "DELETE"); assert.equal(f.vault.snapshot().history.length, 0);
    assert.deepEqual(f.vault.snapshot().session, undefined);
  } finally { await f.cleanup(); }
});

test("credential changes invalidate sessions; interactive login saves only encrypted state", async () => {
  const f = await fixture();
  try {
    await f.request("/api/setup", "POST", { password: PASSWORD });
    await f.request("/api/credentials", "PUT", { username: "S123", password: SAP_PASSWORD });
    await f.request("/api/sap/login/start", "POST"); assert.equal(f.service.status, "interactive");
    await f.request("/api/sap/login/finish", "POST"); assert.deepEqual(f.vault.snapshot().session, storage);
    assert.ok(!(await readFile(f.path, "utf8")).includes(COOKIE_SECRET));
    await f.request("/api/credentials", "PUT", { username: "S456", password: "changed" });
    assert.equal(f.vault.snapshot().session, undefined);
    await f.request("/api/sap/check", "POST"); assert.equal(f.gateways.length, 2);
    await f.request("/api/credentials", "DELETE"); assert.equal(f.vault.snapshot().credentials, undefined);
    await f.request("/api/password", "PUT", { current: PASSWORD, next: SECOND });
    await f.request("/api/lock", "POST");
    assert.equal((await f.request("/api/unlock", "POST", { password: SECOND })).status, 200);
  } finally { await f.cleanup(); }
});

test("locking during a pending SAP operation suppresses results, history and stale session saves", async () => {
  const f = await fixture();
  try {
    await f.request("/api/setup", "POST", { password: PASSWORD }); await f.request("/api/sap/check", "POST");
    const gateway = f.gateways[0]; assert.ok(gateway);
    let release!: () => void;
    gateway.waitForSearch = new Promise<void>(resolve => { release = resolve; });
    const search = f.request("/api/search", "POST", { query: "sensitive search" });
    while (!gateway.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    const locking = f.request("/api/lock", "POST");
    while (f.vault.unlocked) await new Promise(resolve => setTimeout(resolve, 5));
    release();
    const response = await search; assert.equal(response.status, 401); assert.ok(!(await response.text()).includes("HANA"));
    await locking;
    await assert.rejects(gateway.store.save(storage), { code: "LOCKED" });
    await f.request("/api/unlock", "POST", { password: PASSWORD }); assert.equal(f.vault.snapshot().history.length, 0);
  } finally { await f.cleanup(); }
});

test("safe Markdown keeps formatting but blocks raw HTML, script links and external images", () => {
  const html = renderNote('# Title\n\n**bold**\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[local](file:///etc/passwd)\n\n![pixel](https://tracker.example/pixel)\n\n[good](https://me.sap.com/notes/2170696)');
  assert.match(html, /<h1>Title<\/h1>/); assert.match(html, /<strong>bold<\/strong>/);
  assert.ok(!html.includes("<script>")); assert.ok(!html.includes("<img")); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('href="file:'));
  assert.match(html, /rel="noopener noreferrer"/);
});

async function browserOrSkip(t: { skip(message: string): void }): Promise<Browser | undefined> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) { if (process.env.CI) throw error; t.skip("Chromium cannot start in this environment"); return undefined; }
}

test("SapSession uses an injected state store without a plaintext file", async t => {
  const browser = await browserOrSkip(t); if (!browser) return; await browser.close();
  const temp = await temporary(); let saved: SessionState | undefined;
  const session = new SapSession({ ...loadConfig(), storageStatePath: join(temp.directory, "never-written.json") }, true, { load: async () => storage, save: async state => { saved = state; } });
  try {
    await session.start(); await session.saveState(); assert.ok(saved?.cookies.some(cookie => cookie.value === COOKIE_SECRET)); assert.deepEqual(await readdir(temp.directory), []);
  } finally { await session.close(); await rm(temp.directory, { recursive: true, force: true }); }
});

test("SapSession.saveState tightens a pre-existing, group-readable state directory", async t => {
  const browser = await browserOrSkip(t); if (!browser) return; await browser.close();
  const temp = await temporary();
  const loose = join(temp.directory, "state"); await mkdir(loose, { mode: 0o755 }); await chmod(loose, 0o755);
  const statePath = join(loose, "session.json"); await writeFile(statePath, JSON.stringify(storage), { mode: 0o644 });
  const session = new SapSession({ ...loadConfig(), storageStatePath: statePath }, true);
  try {
    await session.start(); await session.saveState();
    assert.equal((await stat(loose)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.ok((await readFile(statePath, "utf8")).includes(COOKIE_SECRET));
  } finally { await session.close(); await rm(temp.directory, { recursive: true, force: true }); }
});

test("browser acceptance flow and WebMCP contracts use the same visible application state", async t => {
  const browser = await browserOrSkip(t); if (!browser) return;
  const f = await fixture();
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const registry = new Map<string, { execute(value: unknown): Promise<unknown> }>();
    Object.assign(window, { testTools: registry });
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool: { name: string; execute(value: unknown): Promise<unknown> }) { registry.set(tool.name, tool); } } });
  });
  try {
    await page.goto(f.origin);
    await page.getByRole("heading", { name: "Deinen Tresor einrichten" }).waitFor();
    await page.getByRole("link", { name: "About", exact: true }).click();
    await page.locator("#about-details").waitFor();
    assert.equal(await page.locator("#about-name").textContent(), "SAP Notes");
    assert.match(await page.locator("#about-version").textContent() ?? "", /^\d+\.\d+\.\d+/);
    assert.match(await page.locator("#about-commit").textContent() ?? "", /^[a-f0-9]{12}$/);
    await page.keyboard.press("Escape");
    await page.locator("#about").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("link", { name: "About", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.locator("#master").fill(PASSWORD); await page.locator("#master-confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "Tresor anlegen" }).click();
    await page.getByRole("heading", { name: "Deine Einstellungen" }).waitFor();
    await page.locator("#username").fill("S123"); await page.locator("#sap-password").fill(SAP_PASSWORD);
    await page.getByRole("button", { name: "Verschlüsselt speichern" }).click();
    await page.waitForFunction(() => document.getElementById("connection")?.textContent === "SAP verbunden");
    await page.getByRole("button", { name: "Notes suchen", exact: true }).click();
    await page.locator("#query").fill("HANA backup"); await page.locator("#search-submit").click();
    await page.locator(".result").click(); await page.getByRole("heading", { name: "HANA troubleshooting" }).waitFor();
    assert.equal(await page.locator(".note-body strong").textContent(), "bold");
    assert.equal(await page.locator(".note-body img, .note-body script").count(), 0);
    await page.getByRole("button", { name: "Suchverlauf", exact: true }).click(); await page.locator(".history-query").waitFor();
    await page.locator(".history-query").click(); await page.locator(".result").waitFor();
    const result = await page.evaluate(async () => {
      const tools = (window as unknown as { testTools: Map<string, { execute(value: unknown): Promise<unknown> }> }).testTools;
      const search = tools.get("search_sap_notes"); const note = tools.get("open_sap_note");
      if (!search || !note) throw new Error("Tools not registered");
      const hits = await search.execute({ query: "zero", limit: 5 });
      const opened = await note.execute({ number: "2170696" });
      let rejected = false; try { await search.execute({ query: "x" }); } catch { rejected = true; }
      return { names: [...tools.keys()], hits, opened, rejected };
    });
    assert.equal(result.rejected, true); assert.deepEqual(result.hits, { hits: [] }); assert.deepEqual(result.names.sort(), ["open_sap_note", "search_sap_notes"]);
    assert.equal(await page.locator("#query").inputValue(), "zero");
    await page.getByRole("button", { name: "Sperren", exact: true }).click(); await page.getByRole("heading", { name: "Arbeitsbereich entsperren" }).waitFor();
    assert.equal(await page.locator("#sap-password").inputValue(), ""); assert.equal(await page.locator(".note-body").count(), 0);
    await page.locator("#master").fill(PASSWORD); await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await page.locator("#workspace").waitFor(); await page.getByRole("button", { name: "Suchverlauf", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".history-query").length === 3);
    assert.deepEqual(errors, []);
  } finally { await page.close(); await browser.close(); await f.cleanup(); }
});

test("a delayed authenticated request body cannot mutate a newly unlocked session", async () => {
  const f = await fixture();
  try {
    const setup = await f.request("/api/setup", "POST", { password: PASSWORD });
    const cookie = setup.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
    let sendRemainder!: () => void;
    const received = new Promise<void>(resolve => f.server.once("request", () => resolve()));
    const delayed = new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.origin + "/api/credentials", { method: "PUT", headers: { Origin: f.origin, Cookie: cookie, "Content-Type": "application/json" } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("error", reject);
      request.write('{"username":"STALE",');
      sendRemainder = () => request.end('"password":"stale-secret"}');
    });
    await received;
    await f.request("/api/lock", "POST");
    await f.request("/api/unlock", "POST", { password: PASSWORD });
    sendRemainder();
    assert.equal(await delayed, 401);
    assert.equal(f.vault.snapshot().credentials, undefined);
  } finally { await f.cleanup(); }
});

test("vault caps the search history at MAX_HISTORY, newest first, and shrinks an oversized vault on unlock", async () => {
  const { directory, path } = await temporary();
  try {
    const vault = new Vault(path); await vault.setup(PASSWORD);
    const entry = (index: number) => ({ id: randomUUID(), query: `query ${index}`, limit: 10, count: 1, at: new Date().toISOString() });
    await vault.update(data => { for (let index = 0; index < MAX_HISTORY + 25; index++) data.history.unshift(entry(index)); });
    assert.equal(vault.snapshot().history.length, MAX_HISTORY);
    assert.equal(vault.history[0]?.query, `query ${MAX_HISTORY + 24}`);
    assert.equal(vault.username, undefined);
    await vault.update(data => { data.credentials = { username: "S123", password: SAP_PASSWORD }; });
    assert.equal(vault.username, "S123");
    vault.lock(); assert.throws(() => vault.username, { code: "LOCKED" }); assert.throws(() => vault.history, { code: "LOCKED" });
    await vault.unlock(PASSWORD); assert.equal(vault.history.length, MAX_HISTORY);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("idle lock signs every browser session out; the unauthenticated state poll does not keep it alive", async () => {
  const f = await fixture({ idleLockMs: 300 });
  try {
    await f.request("/api/setup", "POST", { password: PASSWORD });
    await f.request("/api/credentials", "PUT", { username: "S123", password: SAP_PASSWORD });
    // Authenticated traffic re-arms the timer.
    for (let index = 0; index < 3; index++) { await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await f.request("/api/history")).status, 200); }
    // Polling /api/state alone must not: it runs before authentication.
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) { await f.request("/api/state"); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(f.vault.unlocked, false);
    assert.equal(f.service.status, "unknown");
    assert.equal((await f.request("/api/history")).status, 401);
    const state = await (await f.request("/api/state")).json() as { unlocked: boolean; username?: string };
    assert.equal(state.unlocked, false); assert.equal(state.username, undefined);
    assert.equal((await f.request("/api/unlock", "POST", { password: PASSWORD })).status, 200);
    assert.equal((await f.request("/api/history")).status, 200);
  } finally { await f.cleanup(); }
});

test("a busy or forbidden port is reported by name; other listen errors stay masked", () => {
  const busy = describeListenError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 3210);
  assert.ok(busy instanceof WebError); assert.equal(busy.code, "PORT_IN_USE"); assert.match(busy.message, /3210/);
  const forbidden = describeListenError(Object.assign(new Error("listen EACCES"), { code: "EACCES" }), 80);
  assert.ok(forbidden instanceof WebError); assert.equal(forbidden.code, "PORT_FORBIDDEN");
  const other = new Error("cookie secret in message"); assert.equal(describeListenError(other, 3210), other);
});

test("About retains the app version when Git metadata is unavailable", async () => {
  const { directory } = await temporary();
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "9.8.7" }));
    assert.deepEqual(await loadAppInfo(directory), { name: "SAP Notes", version: "9.8.7", commit: null });
    await writeFile(join(directory, ".git"), "gitdir: /nonexistent/about-test-repository");
    assert.deepEqual(await loadAppInfo(directory), { name: "SAP Notes", version: "9.8.7", commit: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("desktop workspace fits the viewport and long notes reflow without horizontal scrolling", async t => {
  const browser = await browserOrSkip(t); if (!browser) return;
  const f = await fixture();
  const page = await browser.newPage();
  try {
    const setup = await f.request("/api/setup", "POST", { password: PASSWORD });
    const token = setup.headers.get("set-cookie")?.split(";")[0]?.slice("sap_web=".length); assert.ok(token);
    await page.context().addCookies([{ name: "sap_web", value: token, url: f.origin }]);
    await f.service.check();
    const gateway = f.gateways[0]; assert.ok(gateway);
    gateway.note = async number => ({ id: number, title: "A technical note with a long identifier " + "PARAMETER_".repeat(30), url: `https://me.sap.com/notes/${number}`,
      markdown: "# Solution\n\n" + "A detailed instruction for the affected system.\n\n".repeat(40) + "```sql\n" + "SELECT_LONG_PARAMETER_".repeat(40) + "\n```\n\n| Parameter | Value | Description |\n| --- | --- | --- |\n| " + "VERY_LONG_IDENTIFIER_".repeat(25) + " | enabled | " + "Long description ".repeat(30) + " |" });
    for (const [width, height] of [[1440, 900], [1024, 768], [900, 650]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.goto(f.origin); await page.locator("#workspace").waitFor();
      const empty = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewportHeight: innerHeight, viewportWidth: innerWidth, aboutBottom: document.getElementById("about-link")!.getBoundingClientRect().bottom }));
      assert.ok(empty.height <= empty.viewportHeight + 1, `empty ${width}x${height}: page height ${empty.height}`);
      assert.ok(empty.width <= empty.viewportWidth + 1);
      assert.ok(empty.aboutBottom <= empty.viewportHeight);
      await page.locator("#query").fill("2170696"); await page.locator("#search-submit").click();
      await page.locator(".note-body table").waitFor();
      const filled = await page.evaluate(() => {
        const note = document.querySelector<HTMLElement>(".note")!;
        return { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewportHeight: innerHeight, viewportWidth: innerWidth, aboutBottom: document.getElementById("about-link")!.getBoundingClientRect().bottom, noteScrollable: note.scrollHeight > note.clientHeight, overflowing: [...document.querySelectorAll<HTMLElement>(".note, .note-body, .note-body pre, .note-body table")].some(element => element.scrollWidth > element.clientWidth + 1) };
      });
      assert.ok(filled.height <= filled.viewportHeight + 1, `filled ${width}x${height}: page height ${filled.height}`);
      assert.ok(filled.width <= filled.viewportWidth + 1);
      assert.ok(filled.aboutBottom <= filled.viewportHeight);
      assert.ok(filled.noteScrollable);
      assert.equal(filled.overflowing, false);
    }
    for (const width of [320, 390, 720, 820]) {
      await page.setViewportSize({ width, height: 640 });
      const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(dimensions.content <= dimensions.viewport + 1, `mobile width ${width}: content ${dimensions.content}`);
    }
  } finally { await page.close(); await browser.close(); await f.cleanup(); }
});
