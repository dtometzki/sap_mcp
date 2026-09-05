import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AccessDeniedError, SessionExpiredError } from "../session.js";
import { credentialsSchema, masterSchema, WebError, locked } from "./vault.js";
import { type WebService } from "./sap.js";
import { renderNote } from "./markdown.js";
import { loadAppInfo } from "./about.js";

const searchSchema = z.object({ query: z.string().trim().min(2).max(500), limit: z.number().int().min(1).max(25).default(10) }).strict();
const numberSchema = z.string().regex(/^\d{4,10}$/);
const authSchema = z.object({ password: masterSchema }).strict();
const passwordSchema = z.object({ current: masterSchema, next: masterSchema }).strict();
const MAX_BODY = 16 * 1024;
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new WebError("CONTENT_TYPE", "JSON-Anfrage erforderlich.", 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY) throw new WebError("TOO_LARGE", "Anfrage zu groß.", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new WebError("INVALID_INPUT", "Ungültiges JSON."); }
}
function errorBody(error: unknown): WebError {
  if (error instanceof WebError) return error;
  if (error instanceof z.ZodError) return new WebError("INVALID_INPUT", "Bitte die Eingaben prüfen.");
  if (error instanceof AccessDeniedError) return new WebError("ACCESS_DENIED", "Dein SAP-Konto hat keine Berechtigung für diesen Inhalt.", 403);
  if (error instanceof SessionExpiredError) return new WebError("LOGIN_REQUIRED", "Bitte SAP-Zugangsdaten hinterlegen oder die SAP-Anmeldung abschließen.", 409);
  return new WebError("PORTAL_ERROR", "Die Anfrage konnte nicht abgeschlossen werden. Bitte erneut versuchen.", 502);
}
function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

/**
 * A refused port carries no credentials, but the generic safeErrorMessage() hides it —
 * and a local CLI that fails to start must say why. Only the listen error codes with a
 * known cause are named; everything else stays masked.
 */
export function describeListenError(error: unknown, port: number): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    return new WebError("PORT_IN_USE", `Port ${port} ist bereits belegt (z. B. durch eine noch laufende SAP-Notes-Web-App mit anderem Datenverzeichnis oder ein anderes Programm). Prozess beenden oder SAP_WEB_PORT ändern.`);
  }
  if (code === "EACCES") {
    return new WebError("PORT_FORBIDDEN", `Port ${port} darf von diesem Benutzer nicht geöffnet werden. SAP_WEB_PORT auf einen Wert ab 1024 setzen.`);
  }
  return error;
}

export interface WebServerOptions {
  /**
   * Lock the vault after this many milliseconds without an authenticated request.
   * An unlocked vault holds the SAP password and the session cookies in memory; a
   * forgotten tab must not keep them available indefinitely. The state poll of the
   * UI (/api/state) is unauthenticated and therefore never extends the timer.
   * 0 disables the idle lock.
   */
  idleLockMs?: number;
}

/** Fixed loopback host, authenticated API and same-origin JSON mutations (no CORS). */
export function createWebServer(service: WebService, options: WebServerOptions = {}) {
  const appInfo = loadAppInfo();
  // Observe an early read failure even if the About endpoint is never requested.
  void appInfo.catch(() => undefined);
  const sessions = new Set<string>();
  let generation = 0;
  let authBusy = false;
  let locking = false;
  let attempts: number[] = [];
  const idleLockMs = options.idleLockMs ?? 0;
  let idleTimer: NodeJS.Timeout | undefined;
  /** Same effect as POST /api/lock: every browser session is signed out at once. */
  async function lockAll(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    generation++; sessions.clear(); locking = true;
    try { await service.lock(); } finally { locking = false; }
  }
  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleLockMs <= 0) return;
    idleTimer = setTimeout(() => { void lockAll().catch(() => undefined); }, idleLockMs);
    idleTimer.unref();
  }
  const assets = new Map([
    ["/", { url: new URL("../../web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
    ["/app.css", { url: new URL("../../web/app.css", import.meta.url), type: "text/css; charset=utf-8" }],
    ["/app.js", { url: new URL("./client.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ]);
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { code: "INTERNAL_ERROR", message: "Die Anfrage konnte nicht verarbeitet werden." });
      else response.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.on("close", () => { if (idleTimer) clearTimeout(idleTimer); });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const address = server.address();
    if (!address || typeof address === "string") { response.end(); return; }
    const host = `127.0.0.1:${address.port}`;
    const origin = `http://${host}`;
    let authenticated = false;
    const started = generation;
    try {
      if (request.headers.host !== host) throw new WebError("FORBIDDEN", "Ungültiger Host.", 403);
      if (request.headers.origin && request.headers.origin !== origin) throw new WebError("FORBIDDEN", "Fremder Ursprung ist nicht erlaubt.", 403);
      if (request.headers["sec-fetch-site"] === "cross-site") throw new WebError("FORBIDDEN", "Fremder Ursprung ist nicht erlaubt.", 403);
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new WebError("FORBIDDEN", "Ungültige Adresse.", 403);
      if (method !== "GET" && request.headers.origin !== origin) throw new WebError("FORBIDDEN", "Ursprungsprüfung fehlgeschlagen.", 403);
      const path = url.pathname;
      const asset = assets.get(path);
      if (method === "GET" && asset) {
        const file = await readFile(asset.url);
        response.writeHead(200, { "Content-Type": asset.type }); response.end(file); return;
      }
      if (path === "/api/about" && method === "GET") {
        json(response, 200, await appInfo); return;
      }
      const cookie = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("sap_web="))?.slice(8);
      const hasSession = (): boolean => cookie !== undefined && sessions.has(cookie) && service.vault.unlocked && !locking;
      const valid = hasSession();
      if (path === "/api/state" && method === "GET") {
        const exists = await service.vault.exists();
        const unlocked = hasSession();
        json(response, 200, { exists, unlocked, ...(unlocked ? { username: service.vault.username, sap: service.status } : {}) }); return;
      }
      if ((path === "/api/setup" || path === "/api/unlock") && method === "POST") {
        const { password } = authSchema.parse(await body(request));
        const now = Date.now(); attempts = attempts.filter(time => time > now - 60_000);
        if (authBusy || locking || attempts.length >= 5) throw new WebError("RATE_LIMIT", "Bitte eine Minute warten und erneut versuchen.", 429);
        attempts.push(now); authBusy = true;
        try {
          if (path === "/api/setup") await service.vault.setup(password);
          else await service.vault.unlock(password);
          if (generation !== started || locking) throw locked();
          const token = randomBytes(32).toString("hex");
          if (sessions.size >= 32) sessions.clear();
          sessions.add(token);
          touchIdle();
          response.setHeader("Set-Cookie", `sap_web=${token}; Path=/; HttpOnly; SameSite=Strict`);
          json(response, 200, { unlocked: true });
        } finally { authBusy = false; }
        return;
      }
      if (!path.startsWith("/api/")) throw new WebError("NOT_FOUND", "Nicht gefunden.", 404);
      if (!valid) throw locked();
      authenticated = true;
      touchIdle();
      const authorizedBody = async (): Promise<unknown> => {
        const value = await body(request);
        // A slow request body must not survive lock/unlock or password rotation.
        if (generation !== started || !hasSession()) throw locked();
        return value;
      };
      if (path === "/api/lock" && method === "POST") {
        await authorizedBody();
        await lockAll();
        response.setHeader("Set-Cookie", "sap_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        json(response, 200, { unlocked: false }); return;
      }
      let result: unknown;
      if (path === "/api/search" && method === "POST") {
        const input = searchSchema.parse(await authorizedBody());
        result = { hits: await service.search(input.query, input.limit) };
      } else if (path.startsWith("/api/notes/") && method === "GET") {
        const note = await service.note(numberSchema.parse(path.slice("/api/notes/".length)));
        result = { ...note, html: renderNote(note.markdown) };
      } else if (path === "/api/credentials" && (method === "PUT" || method === "DELETE")) {
        const input = await authorizedBody();
        await service.credentials(method === "PUT" ? credentialsSchema.parse(input) : undefined);
        result = { saved: method === "PUT" };
      } else if (path === "/api/password" && method === "PUT") {
        const input = passwordSchema.parse(await authorizedBody());
        const now = Date.now(); attempts = attempts.filter(time => time > now - 60_000);
        if (attempts.length >= 5) throw new WebError("RATE_LIMIT", "Bitte eine Minute warten und erneut versuchen.", 429);
        attempts.push(now);
        await service.run(() => service.vault.changePassword(input.current, input.next));
        // Keep this browser signed in, invalidate other browser sessions.
        sessions.clear(); if (cookie) sessions.add(cookie);
        result = { changed: true };
      } else if (path === "/api/sap/check" && method === "POST") {
        await authorizedBody(); result = { sap: await service.check() };
      } else if (path.startsWith("/api/sap/login/") && method === "POST") {
        const action = z.enum(["start", "finish", "cancel"]).parse(path.slice("/api/sap/login/".length));
        await authorizedBody(); await service.interactive(action); result = { sap: service.status };
      } else if (path === "/api/history" && method === "GET") {
        const query = z.string().max(500).parse(url.searchParams.get("q") ?? "").toLocaleLowerCase("de");
        const offset = z.coerce.number().int().min(0).parse(url.searchParams.get("offset") ?? 0);
        const entries = service.vault.history.filter(entry => entry.query.toLocaleLowerCase("de").includes(query));
        result = { entries: entries.slice(offset, offset + 50), total: entries.length };
      } else if ((path === "/api/history" || path.startsWith("/api/history/")) && method === "DELETE") {
        await authorizedBody();
        const id = path === "/api/history" ? undefined : z.string().uuid().parse(path.slice("/api/history/".length));
        await service.run(() => service.vault.update(data => { data.history = id ? data.history.filter(entry => entry.id !== id) : []; }));
        result = { deleted: true };
      } else throw new WebError("NOT_FOUND", "Nicht gefunden.", 404);
      if (generation !== started || !service.vault.unlocked || !cookie || !sessions.has(cookie)) throw locked();
      json(response, 200, result);
    } catch (error) {
      const safe = authenticated && (generation !== started || !service.vault.unlocked) ? locked() : errorBody(error);
      json(response, safe.status, { code: safe.code, message: safe.message });
    }
  }
  return server;
}
