import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, type Config } from "./config.js";
import { SapSession, looksLikeLoginPage } from "./session.js";
import {
  credentialsFromEnv,
  loginSelectorsFromEnv,
  submitLoginForm,
  type LoginCredentials,
} from "./autologin.js";

/**
 * Interactive login. Run once per machine (and again whenever the session expires).
 * A visible browser window is opened; sign in there, including MFA, then press Enter.
 * Credentials are optional — typing them into the browser yourself is the safer path,
 * because nothing is then read from the environment.
 */
async function interactiveLogin(config: Config): Promise<void> {
  const session = new SapSession(config, false);
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    await session.start();
    const page = await session.newPage();
    await page.goto(config.sessionProbeUrl, { waitUntil: "domcontentloaded" });

    if (config.username) {
      // Best-effort prefill; the SAP identity provider changes field ids over time,
      // so failure here is not fatal — the user simply types the credentials.
      await page
        .fill("input[type='email'], input[name='j_username'], #j_username", config.username, {
          timeout: 10_000,
        })
        .catch(() => undefined);
    }

    console.log("\nA browser window is open.");
    console.log("Sign in with your S-user (including MFA) until you see the SAP Note.");
    await rl.question("\nPress Enter here once you are logged in... ");

    console.log("\nChecking the session (this can take a few seconds)...");
    if (!(await session.isAuthenticated())) {
      throw new Error("Still not authenticated — the portal keeps redirecting to the login page.");
    }

    await session.saveState();
    console.log(`\nSession saved to ${config.storageStatePath} (mode 0600).`);
    console.log("The MCP server can now run headless.");
  } finally {
    rl.close();
    await session.close();
  }
}

/**
 * Non-interactive login for an S-user WITHOUT MFA. Reads SAP_USERNAME/SAP_PASSWORD
 * (typically provided as secrets), signs in headless and persists the session, so an
 * unattended agent can obtain a session without a visible browser. A second factor
 * cannot be satisfied here — use the interactive flow if the account enforces MFA.
 */
async function automatedLogin(config: Config, credentials: LoginCredentials): Promise<void> {
  // headless, and allowed to start without an existing session because we are
  // about to create one.
  const session = new SapSession(config, true, true);

  try {
    await session.start();
    const page = await session.newPage();
    await page.goto(config.sessionProbeUrl, { waitUntil: "domcontentloaded" });

    const selectors = loginSelectorsFromEnv();
    const onLoginPage =
      looksLikeLoginPage(page.url()) ||
      (await page
        .locator(selectors.password)
        .first()
        .isVisible()
        .catch(() => false)) ||
      (await page
        .locator(selectors.username)
        .first()
        .isVisible()
        .catch(() => false));

    if (onLoginPage) {
      console.log("Signing in as", credentials.username, "(headless, no MFA)...");
      await submitLoginForm(page, credentials, selectors, config.navigationTimeoutMs);
      // Wait for the identity provider to hand control back to the portal.
      await page
        .waitForURL((url) => !looksLikeLoginPage(url.href), {
          timeout: config.navigationTimeoutMs,
        })
        .catch(() => undefined);
    } else {
      console.log("Existing session is already authenticated; refreshing stored state.");
    }

    console.log("Checking the session (this can take a few seconds)...");
    if (!(await session.isAuthenticated())) {
      throw new Error(
        "Automated login did not result in an authenticated session. Check SAP_USERNAME / " +
          "SAP_PASSWORD, confirm the account has no MFA, or run `npm run login` interactively.",
      );
    }

    await session.saveState();
    console.log(`\nSession saved to ${config.storageStatePath} (mode 0600).`);
    console.log("The MCP server can now run headless.");
  } finally {
    await session.close();
  }
}

/**
 * Chooses the login flow: when SAP_USERNAME and SAP_PASSWORD are both set, an
 * unattended headless login runs; otherwise the interactive visible-browser flow.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const credentials = credentialsFromEnv();
  if (credentials) {
    await automatedLogin(config, credentials);
  } else {
    await interactiveLogin(config);
  }
}

main().catch((error: unknown) => {
  console.error("Login failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
