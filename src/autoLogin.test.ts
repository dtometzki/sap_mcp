import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { loadConfig, type Config } from "./config.js";
import { AutoLoginError, MfaRequiredError, fillLoginForm, waitForLoginResult } from "./autoLogin.js";

/**
 * Drives the login flow against a local stand-in for the SAP identity provider.
 *
 * The form logic is the one part of the automatic login that cannot be checked against
 * the real portal in CI (that would need credentials and would count against SAP's
 * logon attempts), so the two-step form, the MFA abort and the rejected-password path
 * are exercised against fixtures that mimic the IdP's shape.
 */

const USER = "S0001234567";
const PASSWORD = "correct horse";

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// novalidate: an S-user is not a valid e-mail address, and the browser would
// otherwise block the submit of a type="email" field before it ever navigates.
const USER_FORM = page(
  "Sign in",
  `<form method="GET" action="/login/password" novalidate>
     <input id="j_username" name="j_username" type="email" />
     <button id="logOnFormSubmit" type="submit">Continue</button>
   </form>`,
);

function passwordForm(target: string, error = "", notice = ""): string {
  return page(
    "Password",
    `${error === "" ? "" : `<div id="logonMessageText">${error}</div>`}
     ${notice === "" ? "" : `<div role="alert">${notice}</div>`}
     <form method="GET" action="${target}" novalidate>
       <input id="j_password" name="j_password" type="password" />
       <button id="logOnFormSubmit" type="submit">Sign in</button>
     </form>`,
  );
}

const MFA_FORM = page(
  "Verification",
  `<input id="otp" name="otp" autocomplete="one-time-code" />`,
);

/** `outcome` decides what a correct password leads to: the portal, or an MFA prompt. */
type Outcome = "portal" | "mfa" | "reject" | "banner" | "banner-stuck";

function startIdp(outcome: Outcome): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.writeHead(200, { "content-type": "text/html" });

    if (url.pathname === "/login") return response.end(USER_FORM);
    if (url.pathname === "/login/password") {
      // Successful sign-in lands on the portal host so waitForLoginResult sees
      // a non-IdP URL — same split as the real accounts.sap.com → me.sap.com hop.
      const target = outcome === "mfa" ? "/login/mfa" : "https://me.sap.com/notes/2170696";
      // Generic banners (cookie hint, maintenance notice) sit next to a working form.
      const notice = outcome.startsWith("banner") ? "We use cookies on this site." : "";
      return response.end(passwordForm(target, "", notice));
    }
    if (url.pathname === "/login/mfa") return response.end(MFA_FORM);
    if (url.pathname === "/notes/2170696") {
      // A wrong password sends the user back to the form with the IdP's error banner.
      if (outcome === "reject" || url.searchParams.get("j_password") !== PASSWORD) {
        return response.end(passwordForm("/notes/2170696", "Wrong credentials"));
      }
      // The IdP stays on the form with only a generic message: no verdict, just stuck.
      if (outcome === "banner-stuck") {
        return response.end(passwordForm("/notes/2170696", "", "Service temporarily unavailable"));
      }
      return response.end(page("SAP Note", "<main>SAP Note 2170696</main>"));
    }
    response.end(page("Not found", "missing"));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function testConfig(): Config {
  return { ...loadConfig(), loginStepTimeoutMs: 5_000 };
}

/**
 * Serves the local IdP fixture under the real SAP hostnames so fillLoginForm's
 * allowlist (https://*.sap.com) accepts the page — the same hosts the production
 * auto-login types into after SAP_PROBE_URL redirects to accounts.sap.com.
 */
async function routeSapHostsToFixture(page: Page, origin: string): Promise<void> {
  const handler = async (route: Route): Promise<void> => {
    const incoming = new URL(route.request().url());
    const mapped = `${origin}${incoming.pathname}${incoming.search}`;
    const response = await fetch(mapped);
    await route.fulfill({
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "text/html" },
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  await page.route("https://accounts.sap.com/**", handler);
  await page.route("https://me.sap.com/**", handler);
}

async function withIdp(
  outcome: Outcome,
  fn: (browser: Browser, origin: string) => Promise<void>,
): Promise<void> {
  const server = await startIdp(outcome);
  const browser = await chromium.launch({ headless: true });
  try {
    await fn(browser, baseUrl(server));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function openSapLogin(browser: Browser, origin: string): Promise<Page> {
  const tab = await (await browser.newContext()).newPage();
  await routeSapHostsToFixture(tab, origin);
  await tab.goto("https://accounts.sap.com/login");
  return tab;
}

// Playwright's browser binary may be missing (fresh clone without `playwright install`);
// the rest of the offline suite must stay runnable in that case.
const chromiumAvailable = await chromium
  .launch({ headless: true })
  .then(async (browser) => {
    await browser.close();
    return true;
  })
  .catch(() => false);

test(
  "fillLoginForm completes the two-step form and waitForLoginResult confirms the portal",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("portal", async (browser, origin) => {
      const tab = await openSapLogin(browser, origin);
      await fillLoginForm(tab, testConfig(), { username: USER, password: PASSWORD });
      await waitForLoginResult(tab, testConfig());
      assert.match(tab.url(), /^https:\/\/me\.sap\.com\/notes\/2170696/);
    });
  },
);

test(
  "an MFA prompt aborts the automatic login permanently",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("mfa", async (browser, origin) => {
      const tab = await openSapLogin(browser, origin);
      await fillLoginForm(tab, testConfig(), { username: USER, password: PASSWORD });
      const error = await waitForLoginResult(tab, testConfig()).catch((e: unknown) => e);
      assert.ok(error instanceof MfaRequiredError);
      assert.equal(error.permanent, true);
    });
  },
);

test(
  "rejected credentials surface the portal's message and are not retried",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("reject", async (browser, origin) => {
      const tab = await openSapLogin(browser, origin);
      await fillLoginForm(tab, testConfig(), { username: USER, password: "wrong" });
      const error = await waitForLoginResult(tab, testConfig()).catch((e: unknown) => e);
      assert.ok(error instanceof AutoLoginError);
      assert.match(error.message, /Wrong credentials/);
      assert.equal(error.permanent, true);
    });
  },
);

test(
  "a missing login form fails fast instead of hanging",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("portal", async (browser, origin) => {
      const tab = await (await browser.newContext()).newPage();
      await routeSapHostsToFixture(tab, origin);
      await tab.goto("https://me.sap.com/notes/2170696");
      const config = { ...testConfig(), loginStepTimeoutMs: 1_000 };
      await assert.rejects(
        fillLoginForm(tab, config, { username: USER, password: PASSWORD }),
        /No login form found/,
      );
    });
  },
);

test(
  "fillLoginForm refuses to type credentials on a non-SAP host",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("portal", async (browser, origin) => {
      const tab = await (await browser.newContext()).newPage();
      await tab.goto(`${origin}/login`);
      await assert.rejects(
        fillLoginForm(tab, testConfig(), { username: USER, password: PASSWORD }),
        /non-SAP host/,
      );
    });
  },
);

test(
  "a generic banner next to the form does not abort a login that succeeds",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("banner", async (browser, origin) => {
      const tab = await openSapLogin(browser, origin);
      await fillLoginForm(tab, testConfig(), { username: USER, password: PASSWORD });
      await waitForLoginResult(tab, testConfig());
      assert.match(tab.url(), /^https:\/\/me\.sap\.com\/notes\/2170696/);
    });
  },
);

test(
  "a stuck login with only a generic banner is reported but not marked permanent",
  { skip: chromiumAvailable ? false : "Chromium not installed" },
  async () => {
    await withIdp("banner-stuck", async (browser, origin) => {
      const tab = await openSapLogin(browser, origin);
      const config = { ...testConfig(), loginStepTimeoutMs: 2_000 };
      await fillLoginForm(tab, config, { username: USER, password: PASSWORD });
      const error = await waitForLoginResult(tab, config).catch((e: unknown) => e);
      assert.ok(error instanceof AutoLoginError);
      assert.match(error.message, /did not complete/);
      assert.match(error.message, /Service temporarily unavailable/);
      assert.equal(error.permanent, false);
    });
  },
);
