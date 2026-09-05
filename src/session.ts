import { PublicError } from "./errors.js";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { buildUrl, type Config } from "./config.js";
import { assertAllowedPageUrl, isAllowedApiUrl, isAllowedLoginUrl } from "./urls.js";

export class SessionExpiredError extends PublicError {
  constructor() {
    super(
      "SAP session is missing or expired. Run `npm run login` on the machine hosting " +
        "this MCP server to sign in interactively (S-user + MFA), then simply retry " +
        "the tool call — the server picks up the new session without a restart.",
    );
    this.name = "SessionExpiredError";
  }
}

/**
 * HTTP 403 from the portal: the session is fine, the S-user simply lacks the
 * authorization. Kept distinct from SessionExpiredError so the server neither tears the
 * browser down nor tells the user to log in again — no login can fix an authorization
 * gap — and so the callers skip their "the portal must have changed" DOM fallbacks.
 */
export class AccessDeniedError extends PublicError {
  constructor(subject: string) {
    super(
      `${subject}: the SAP portal denied access (HTTP 403). The session is valid, but your ` +
        `S-user is most likely not authorized for this content.`,
    );
    this.name = "AccessDeniedError";
  }
}

/** Hosts of the SAP identity provider; a redirect there means we are logged out. */
const LOGIN_HOSTS = ["accounts.sap.com", "accounts.sap.cn"];

/**
 * Path segments of the identity provider's endpoints.
 *
 * Matched against the PATH ONLY, never the query string: "logon" and "signin" are
 * everyday SAP vocabulary (SAP Logon, logon groups, saplogon.ini, single sign-on), so
 * a substring match over the whole URL flags legitimate searches and downloads as an
 * expired session — which used to tear down a perfectly healthy browser context.
 */
const LOGIN_PATH_PATTERN = /\/(saml2|oauth2|sso|signin|logon|login)(\/|$)/i;

/** Login forms are sometimes rendered at the original portal URL without a redirect. */
const LOGIN_FORM_SELECTOR = [
  "input[type='password']",
  "form[action*='login' i]",
  "form[action*='signin' i]",
  "form[action*='saml' i]",
].join(", ");

export function looksLikeLoginPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (LOGIN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return true;
  return LOGIN_PATH_PATTERN.test(parsed.pathname);
}

/**
 * Turns an HTTP status into the right error.
 *
 * 401 means "not authenticated" — the session really is gone. 403 means "authenticated
 * but not authorized", which for SAP Notes usually means the S-user lacks the relevant
 * authorization; reporting that as an expired session sends the user into a login loop
 * that cannot fix anything. The login-page heuristic is only consulted for responses
 * that already failed, so a successful download is never misread as a logout.
 */
export function assertNotLoggedOut(
  status: number,
  url: string,
  subject: string,
  ok: boolean,
): void {
  if (status === 401) throw new SessionExpiredError();
  if (status === 403) throw new AccessDeniedError(subject);
  if (!ok && looksLikeLoginPage(url)) throw new SessionExpiredError();
}

/** Creates `path` (and parents) and forces owner-only access, including on an existing dir. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** Note used by the session probe when SAP_PROBE_URL carries no note number. */
const DEFAULT_PROBE_NOTE_ID = "2170696";

/** Note number of the probe page, so the API probe asks for the same document. */
export function probeNoteId(probeUrl: string): string {
  try {
    const match = /\/(\d{4,10})(?:[/?#]|$)/.exec(new URL(probeUrl).pathname);
    return match?.[1] ?? DEFAULT_PROBE_NOTE_ID;
  } catch {
    return DEFAULT_PROBE_NOTE_ID;
  }
}

export type ProbeVerdict = "authenticated" | "expired" | "unknown";

/**
 * Reads the note-detail API response of the session probe. Only unambiguous answers
 * count; everything else ("unknown") falls back to rendering the probe page, so a
 * reshaped API can never turn a valid session into a login loop — or vice versa.
 */
export function interpretProbeResponse(
  status: number,
  contentType: string,
  location: string | undefined,
  finalUrl: string,
): ProbeVerdict {
  if (status === 401) return "expired";
  if (status >= 300 && status < 400) {
    if (!location) return "unknown";
    try {
      return isAllowedLoginUrl(new URL(location, finalUrl).href) ? "expired" : "unknown";
    } catch {
      return "unknown";
    }
  }
  if (status === 200) {
    if (/json/i.test(contentType) && !looksLikeLoginPage(finalUrl)) return "authenticated";
    if (/text\/html/i.test(contentType) && looksLikeLoginPage(finalUrl)) return "expired";
  }
  return "unknown";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Browser close failed", { cause: value });
}

/**
 * Whether the state file exists AND is readable as a Playwright storage state.
 *
 * A truncated file (the write is not atomic in every Playwright version, and the server
 * rewrites it periodically) would otherwise make newContext() throw something that is not
 * a SessionExpiredError — the server's recovery path would not fire and every tool call
 * would fail until the file is deleted by hand. Treating it as "no session" instead
 * produces the actionable `npm run login` message and heals on the next login.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation for the Playwright storage-state fields used by Chromium. */
export function isUsableStorageState(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    return false;
  }

  const cookiesAreValid = value.cookies.every(
    (cookie) =>
      isRecord(cookie) &&
      typeof cookie.name === "string" &&
      typeof cookie.value === "string" &&
      typeof cookie.domain === "string" &&
      typeof cookie.path === "string" &&
      typeof cookie.expires === "number" &&
      typeof cookie.httpOnly === "boolean" &&
      typeof cookie.secure === "boolean" &&
      typeof cookie.sameSite === "string" &&
      ["Strict", "Lax", "None"].includes(cookie.sameSite),
  );
  const originsAreValid = value.origins.every(
    (origin) =>
      isRecord(origin) &&
      typeof origin.origin === "string" &&
      Array.isArray(origin.localStorage) &&
      origin.localStorage.every(
        (entry) =>
          isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string",
      ),
  );
  return cookiesAreValid && originsAreValid;
}

async function hasUsableState(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isUsableStorageState(parsed);
  } catch {
    return false;
  }
}

/** Options for SapSession.start(); the defaults are the server's read-only behaviour. */
export interface StartOptions {
  /**
   * Launch even when no usable state file exists. Only the login flows set this: a
   * headless server without a session must keep failing with SessionExpiredError,
   * because a browser without cookies cannot answer a single tool call.
   */
  allowMissingState?: boolean;
  /**
   * Start from an empty cookie jar instead of the stored state. Used by the login
   * flows so a half-expired session cannot leave the identity provider in a state
   * where neither the login form nor the portal is shown.
   */
  ignoreStoredState?: boolean;
}

export type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Injectable persistence; web sessions never pass through a plaintext file. */
export interface SessionStore {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
}

/**
 * Owns the Playwright browser and the authenticated context.
 * One instance per process; the MCP server keeps it alive between tool calls
 * so the SAP backend does not see a login storm.
 */
export class SapSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  /** Memoized so concurrent callers share one launch instead of racing two browsers. */
  private startPromise: Promise<void> | undefined;

  constructor(
    private readonly config: Config,
    private readonly headless: boolean,
    private readonly store?: SessionStore,
  ) {}

  /**
   * Opens the browser and restores the saved session. Throws if no state file exists.
   * Safe to call concurrently and repeatedly; a failed start can be retried.
   */
  start(options: StartOptions = {}): Promise<void> {
    this.startPromise ??= this.doStart(options).catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async doStart({ allowMissingState, ignoreStoredState }: StartOptions): Promise<void> {
    if (this.context) return;

    const stored = !ignoreStoredState && this.store ? await this.store.load() : undefined;
    const hasState = !ignoreStoredState && (this.store
      ? stored !== undefined && isUsableStorageState(stored)
      : await hasUsableState(this.config.storageStatePath));
    if (!hasState && this.headless && !allowMissingState) {
      throw new SessionExpiredError();
    }

    this.browser = await chromium.launch({ headless: this.headless });
    try {
      this.context = await this.browser.newContext({
        storageState: hasState ? (this.store ? stored : this.config.storageStatePath) : undefined,
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        // Tool downloads go through fetchAllowedAttachment, not the browser.
        acceptDownloads: false,
      });
    } catch (error) {
      // Do not leak the browser process if the context (e.g. corrupt state file) fails.
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
      throw error;
    }
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
  }

  /**
   * Navigates and lets late-rendering SPA content settle.
   * Throws SessionExpiredError if the portal redirects to the identity provider.
   */
  async open(url: string): Promise<Page> {
    if (!this.context) throw new Error("Session not started");
    assertAllowedPageUrl(url, "navigation");

    const page = await this.context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      assertAllowedPageUrl(page.url(), "navigation");
      if (response?.status() === 401) {
        throw new SessionExpiredError();
      }
      if (response?.status() === 403) {
        throw new AccessDeniedError("Portal page");
      }
      await page
        .waitForLoadState("networkidle", { timeout: this.config.networkIdleTimeoutMs })
        .catch(() => {
          // The portal keeps polling connections open; a timeout here is expected
          // and harmless as long as the DOM is already rendered.
        });
      // Wait for a plausible content container instead of a blind sleep; proceeds
      // immediately once the SPA renders, falls back to the timeout otherwise.
      await page
        .waitForSelector("main, article, [role='main'], .sapMPage, #content", {
          timeout: this.config.renderSettleMs,
        })
        .catch(() => undefined);

      const hasVisibleLoginForm = await page
        .locator(LOGIN_FORM_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false);
      if (looksLikeLoginPage(page.url()) || hasVisibleLoginForm) {
        throw new SessionExpiredError();
      }
      return page;
    } catch (error) {
      if (!page.isClosed()) await page.close();
      throw error;
    }
  }

  /**
   * Persists cookies + localStorage with owner-only permissions.
   *
   * Written to a temp file and renamed, because the server rewrites this file every few
   * minutes while it runs: Playwright's own storageState({ path }) is a plain writeFile,
   * so a process kill mid-write leaves a truncated session and forces a fresh login.
   * rename() is atomic within a filesystem, so readers only ever see a complete file.
   * The temp file is created with mode 0600, closing the window in which a newly created
   * state file was readable by other local users.
   */
  async saveState(): Promise<void> {
    if (!this.context) throw new Error("Session not started");
    if (this.store) {
      await this.store.save(await this.context.storageState());
      return;
    }
    const target = this.config.storageStatePath;
    // Also tightens a pre-existing directory; mkdir's mode only applies when creating.
    await ensurePrivateDirectory(dirname(target));

    const state = await this.context.storageState();
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    // rename() keeps the target's previous mode when it already existed.
    await chmod(target, 0o600);
  }

  /**
   * Reports whether the stored session still authenticates.
   *
   * Asks the note-detail JSON API first: one cookie-authenticated request instead of
   * rendering the portal SPA (which costs the networkidle timeout plus settle time on
   * every probe — auto-login, `sap_session_status`, the web app's check). The page
   * probe remains the fallback for every answer the API does not settle unambiguously.
   */
  async isAuthenticated(): Promise<boolean> {
    const verdict = await this.probeViaApi().catch((): ProbeVerdict => "unknown");
    if (verdict !== "unknown") return verdict === "authenticated";
    return this.probeViaPage();
  }

  private async probeViaApi(): Promise<ProbeVerdict> {
    if (!this.context) throw new Error("Session not started");
    const url = buildUrl(this.config.noteDetailApiUrlTemplate, {
      id: probeNoteId(this.config.sessionProbeUrl),
    });
    if (!isAllowedApiUrl(url)) return "unknown";
    const response = await this.context.request.get(url, {
      headers: { accept: "application/json" },
      timeout: this.config.apiTimeoutMs,
      maxRedirects: 0,
    });
    try {
      const headers = response.headers();
      const finalUrl = response.url();
      if (finalUrl && !isAllowedApiUrl(finalUrl)) return "unknown";
      return interpretProbeResponse(
        response.status(),
        headers["content-type"] ?? "",
        headers.location,
        finalUrl,
      );
    } finally {
      await response.dispose().catch(() => undefined);
    }
  }

  private async probeViaPage(): Promise<boolean> {
    try {
      const page = await this.open(this.config.sessionProbeUrl);
      await page.close();
      return true;
    } catch (error) {
      if (error instanceof SessionExpiredError) return false;
      throw error;
    }
  }

  /**
   * Opens a page, runs the callback, and always closes the page again.
   * Every tool call that renders a portal page must go through here so a
   * callback error can never leak an open page (and its browser resources).
   */
  async withOpenPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.open(url);
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  /** Exposes a raw page for the interactive login flow. */
  async newPage(): Promise<Page> {
    if (!this.context) throw new Error("Session not started");
    return this.context.newPage();
  }

  /**
   * Node-side HTTP client that shares the context's cookies (for same-origin SAP calls)
   * but is not subject to browser CORS — used to hit the Coveo token endpoint and the
   * Coveo search API directly, without rendering a page.
   */
  request(): APIRequestContext {
    if (!this.context) throw new Error("Session not started");
    return this.context.request;
  }

  /**
   * Cookie header for a direct Node-side request to the given URL.
   *
   * BrowserContext.cookies(url) applies the browser's domain/path/secure rules before
   * returning cookies, so callers never forward the complete SAP cookie jar to a host
   * merely because it appeared in a redirect.
   */
  async cookieHeader(url: string): Promise<string> {
    if (!this.context) throw new Error("Session not started");
    const cookies = await this.context.cookies(url);
    return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.startPromise = undefined;

    let closeError: Error | undefined;
    try {
      await context?.close();
    } catch (error) {
      closeError = toError(error);
    }
    try {
      await browser?.close();
    } catch (error) {
      closeError ??= toError(error);
    }
    if (closeError) throw closeError;
  }
}
