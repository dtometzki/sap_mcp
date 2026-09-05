import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { AutoLoginError, MfaRequiredError, fillLoginForm, performAutoLogin, type Credentials } from "../autoLogin.js";
import { SapSession, SessionExpiredError, type SessionStore } from "../session.js";
import { fetchNote, searchNotes, resetTokenCache, type NoteDetail, type NoteHit } from "../notes.js";
import { ToolRunner } from "../toolRunner.js";
import { fetchAttachmentList, downloadAttachmentBytes, type AttachmentBytes, type NoteAttachment } from "../attachments.js";
import { assertAllowedPageUrl } from "../urls.js";
import { Vault, WebError, locked } from "./vault.js";

export type SapStatus = "unknown" | "authenticated" | "login_required" | "mfa_required" | "login_failed" | "interactive";
export interface SapGateway {
  status: SapStatus;
  check(): Promise<SapStatus>;
  search(query: string, limit: number): Promise<NoteHit[]>;
  note(number: string): Promise<NoteDetail>;
  attachments(number: string): Promise<Omit<NoteAttachment, "url">[]>;
  download(number: string, fileName: string, signal: AbortSignal): Promise<AttachmentBytes>;
  interactiveStart(): Promise<void>;
  interactiveFinish(): Promise<void>;
  interactiveCancel(): Promise<void>;
  close(): Promise<void>;
}

export class BrowserSapGateway implements SapGateway {
  status: SapStatus = "unknown";
  private readonly session: SapSession;
  private readonly runner: ToolRunner;
  private readonly abort = new AbortController();
  private interactive?: SapSession;
  private interactiveTimer?: NodeJS.Timeout;
  private loginError?: unknown;
  constructor(private readonly config: Config, private readonly store: SessionStore, private readonly credentials?: Credentials) {
    this.session = new SapSession(config, true, store);
    this.runner = new ToolRunner({
      ensureSession: async () => {
        this.abort.signal.throwIfAborted();
        await this.session.start();
        this.abort.signal.throwIfAborted();
      },
      saveState: () => this.session.saveState(), close: () => this.session.close(), resetTokenCache,
      reauthenticate: credentials ? async () => {
        try {
          await performAutoLogin(config, credentials, true, store, this.abort.signal);
          this.loginError = undefined; this.status = "authenticated";
        } catch (error) {
          this.loginError = error;
          this.status = error instanceof MfaRequiredError ? "mfa_required" : "login_failed";
          throw error;
        }
      } : undefined,
    }, { idleTimeoutMs: config.idleTimeoutMs, stateSaveIntervalMs: 5 * 60_000, autoLoginCooldownMs: config.autoLoginCooldownMs });
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.abort.signal.throwIfAborted();
    if (this.interactive) throw new WebError("INTERACTIVE_LOGIN", "Bitte die offene SAP-Anmeldung abschließen.", 409);
    try {
      const value = await this.runner.executeValue(operation);
      this.abort.signal.throwIfAborted();
      this.status = "authenticated";
      return value;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        if (this.loginError instanceof MfaRequiredError) throw new WebError("MFA_REQUIRED", "SAP benötigt eine Bestätigung. Bitte die SAP-Anmeldung abschließen.", 409);
        if (this.loginError instanceof AutoLoginError) throw new WebError("LOGIN_FAILED", "Automatische Anmeldung fehlgeschlagen. Zugangsdaten prüfen oder die SAP-Anmeldung im Browser abschließen.", 409);
        this.status = "login_required";
      }
      throw error;
    }
  }
  async check(): Promise<SapStatus> {
    if (this.interactive) return "interactive";
    await this.run(async () => {
      if (!await this.session.isAuthenticated()) throw new SessionExpiredError();
    });
    return this.status;
  }
  search(query: string, limit: number): Promise<NoteHit[]> { return this.run(() => searchNotes(this.session, this.config, query, limit)); }
  note(number: string): Promise<NoteDetail> { return this.run(() => fetchNote(this.session, this.config, number)); }
  attachments(number: string): Promise<Omit<NoteAttachment, "url">[]> {
    return this.run(async () => (await fetchAttachmentList(this.session, this.config, number)).map(({ fileName, sizeBytes }) => ({ fileName, sizeBytes })));
  }
  download(number: string, fileName: string, signal: AbortSignal): Promise<AttachmentBytes> {
    return this.run(() => downloadAttachmentBytes(this.session, this.config, number, fileName, AbortSignal.any([signal, this.abort.signal])));
  }
  async interactiveStart(): Promise<void> {
    this.abort.signal.throwIfAborted();
    if (this.interactive) return;
    await this.session.close();
    resetTokenCache();
    const browser = new SapSession(this.config, false, this.store);
    this.interactive = browser;
    this.status = "interactive";
    this.interactiveTimer = setTimeout(() => { void this.interactiveCancel().catch(() => undefined); }, 5 * 60_000);
    this.interactiveTimer.unref();
    try {
      await browser.start({ allowMissingState: true, ignoreStoredState: true });
      this.abort.signal.throwIfAborted();
      if (this.interactive !== browser) throw new WebError("LOGIN_TIMEOUT", "SAP-Anmeldung abgelaufen.", 409);
      const page = await browser.newPage();
      await page.goto(this.config.sessionProbeUrl, { waitUntil: "domcontentloaded" });
      assertAllowedPageUrl(page.url(), "interactive login");
      if (this.credentials) {
        // Leave the visible browser open for MFA or manual corrections; do not repeat automatically.
        await fillLoginForm(page, this.config, this.credentials).catch(() => undefined);
      }
      this.abort.signal.throwIfAborted();
      if (this.interactive !== browser) throw new WebError("LOGIN_TIMEOUT", "SAP-Anmeldung abgelaufen.", 409);
    } catch (error) {
      await browser.close().catch(() => undefined);
      await this.interactiveCancel();
      throw error;
    }
  }
  async interactiveFinish(): Promise<void> {
    const browser = this.interactive;
    if (!browser) throw new WebError("LOGIN_REQUIRED", "Zuerst die SAP-Anmeldung öffnen.", 409);
    if (!await browser.isAuthenticated()) throw new WebError("MFA_REQUIRED", "Die Anmeldung im SAP-Fenster ist noch nicht abgeschlossen.", 409);
    this.abort.signal.throwIfAborted();
    if (this.interactive !== browser) throw new WebError("LOGIN_TIMEOUT", "SAP-Anmeldung abgelaufen.", 409);
    await browser.saveState();
    await this.interactiveCancel();
    this.status = "authenticated";
    this.loginError = undefined;
  }
  async interactiveCancel(): Promise<void> {
    clearTimeout(this.interactiveTimer);
    this.interactiveTimer = undefined;
    const browser = this.interactive; this.interactive = undefined;
    if (browser) { this.status = "login_required"; await browser.close().catch(() => undefined); }
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.interactiveCancel();
    await this.session.close().catch(() => undefined);
    await this.runner.shutdown(5000);
    // Also close a browser whose asynchronous launch finished after cancellation.
    await this.session.close().catch(() => undefined);
  }
}

export type GatewayFactory = (store: SessionStore, credentials?: Credentials) => SapGateway;
/** Serializes all web SAP operations and account changes; lock invalidates immediately. */
export class WebService {
  private gateway?: SapGateway;
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly vault: Vault, private readonly factory: GatewayFactory) {}
  get status(): SapStatus { return this.gateway?.status ?? "unknown"; }
  private assert(epoch: number): void { if (this.epoch !== epoch || !this.vault.unlocked) throw locked(); }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const task = this.queue.then(async () => {
      this.assert(epoch);
      const value = await fn();
      this.assert(epoch);
      return value;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  private sap(): SapGateway {
    if (!this.gateway) {
      const epoch = this.epoch;
      this.gateway = this.factory({
        load: () => { this.assert(epoch); return Promise.resolve(this.vault.snapshot().session); },
        save: async (state) => {
          this.assert(epoch);
          await this.vault.update(data => { this.assert(epoch); data.session = state; });
        },
      }, this.vault.snapshot().credentials);
    }
    return this.gateway;
  }
  check(): Promise<SapStatus> { return this.run(() => this.sap().check()); }
  search(query: string, limit: number): Promise<NoteHit[]> {
    return this.run(async () => {
      const epoch = this.epoch;
      const hits = await this.sap().search(query, limit);
      this.assert(epoch);
      await this.vault.update(data => { data.history.unshift({ id: randomUUID(), query, limit, count: hits.length, at: new Date().toISOString() }); });
      return hits;
    });
  }
  note(number: string): Promise<NoteDetail> { return this.run(() => this.sap().note(number)); }
  attachments(number: string): Promise<Omit<NoteAttachment, "url">[]> { return this.run(() => this.sap().attachments(number)); }
  download(number: string, fileName: string, signal: AbortSignal): Promise<AttachmentBytes> {
    return this.run(() => { signal.throwIfAborted(); return this.sap().download(number, fileName, signal); });
  }
  credentials(credentials?: Credentials): Promise<void> {
    return this.run(async () => {
      const epoch = this.epoch;
      await this.gateway?.close(); this.gateway = undefined;
      this.assert(epoch);
      await this.vault.update(data => { data.credentials = credentials; delete data.session; });
    });
  }
  interactive(action: "start" | "finish" | "cancel"): Promise<void> {
    return this.run(async () => {
      const gateway = this.sap();
      if (action === "start") await gateway.interactiveStart();
      if (action === "cancel") await gateway.interactiveCancel();
      if (action === "finish") {
        await gateway.interactiveFinish();
        // A fresh runner also clears permanent automatic-login suppression after successful MFA.
        await gateway.close(); this.gateway = undefined;
      }
    });
  }
  async lock(): Promise<void> {
    this.epoch++;
    this.vault.lock();
    const gateway = this.gateway; this.gateway = undefined;
    await gateway?.close();
    await this.queue;
    await this.vault.settled();
  }
}
