import { chmod, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { Config } from "./config.js";

export class SessionExpiredError extends Error {
  constructor() {
    super(
      "SAP session is missing or expired. Run `npm run login` on the machine hosting " +
        "this MCP server to sign in interactively (S-user + MFA), then retry.",
    );
    this.name = "SessionExpiredError";
  }
}

/** Markers that indicate the portal bounced us to the identity provider. */
const LOGIN_URL_MARKERS = ["accounts.sap.com", "/saml2/", "/oauth2/", "signin", "logon"];

/** Login forms are sometimes rendered at the original portal URL without a redirect. */
const LOGIN_FORM_SELECTOR = [
  "input[type='password']",
  "form[action*='login' i]",
  "form[action*='signin' i]",
  "form[action*='saml' i]",
].join(", ");

export function looksLikeLoginPage(url: string): boolean {
  const lower = url.toLowerCase();
  return LOGIN_URL_MARKERS.some((marker) => lower.includes(marker));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  ) {}

  /**
   * Opens the browser and restores the saved session. Throws if no state file exists.
   * Safe to call concurrently and repeatedly; a failed start can be retried.
   */
  start(): Promise<void> {
    this.startPromise ??= this.doStart().catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.context) return;

    const hasState = await fileExists(this.config.storageStatePath);
    if (!hasState && this.headless) {
      throw new SessionExpiredError();
    }

    this.browser = await chromium.launch({ headless: this.headless });
    try {
      this.context = await this.browser.newContext({
        storageState: hasState ? this.config.storageStatePath : undefined,
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
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

    const page = await this.context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (response?.status() === 401) {
        throw new SessionExpiredError();
      }
      if (response?.status() === 403) {
        throw new Error("SAP portal denied access to the requested page (HTTP 403).");
      }
      await page
        .waitForLoadState("networkidle", { timeout: this.config.networkIdleTimeoutMs })
        .catch(() => {
          // The portal keeps polling connections open; a timeout here is expected
          // and harmless as long as the DOM is already rendered.
        });
      await page.waitForTimeout(this.config.renderSettleMs);

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

  /** Persists cookies + localStorage with owner-only permissions. */
  async saveState(): Promise<void> {
    if (!this.context) throw new Error("Session not started");
    await mkdir(dirname(this.config.storageStatePath), { recursive: true, mode: 0o700 });
    await this.context.storageState({ path: this.config.storageStatePath });
    await chmod(this.config.storageStatePath, 0o600);
  }

  /** Loads the probe page and reports whether the stored session still authenticates. */
  async isAuthenticated(): Promise<boolean> {
    try {
      const page = await this.open(this.config.sessionProbeUrl);
      await page.close();
      return true;
    } catch (error) {
      if (error instanceof SessionExpiredError) return false;
      throw error;
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

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.startPromise = undefined;

    let closeError: unknown;
    try {
      await context?.close();
    } catch (error) {
      closeError = error;
    }
    try {
      await browser?.close();
    } catch (error) {
      closeError ??= error;
    }
    if (closeError) throw closeError;
  }
}
