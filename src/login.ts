import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";
import { envKeysFromFile, loadDotEnv, scrubPasswordFromEnv } from "./env.js";
import {
  credentialsFromConfig,
  fillLoginForm,
  waitForLoginResult,
  MfaRequiredError,
} from "./autoLogin.js";
import { isAllowedLoginUrl } from "./urls.js";

/**
 * Interactive login. Run once per machine (and again whenever the session expires).
 *
 * With SAPUSER/SAPPASSWORD in .env the form is filled and submitted automatically; the
 * browser window stays visible so anything that needs a human (MFA above all) can be
 * completed by hand. Without credentials it behaves exactly as before: type everything
 * into the browser yourself.
 */
async function main(): Promise<void> {
  const envFile = loadDotEnv();
  const config = loadConfig();
  const credentials = credentialsFromConfig(config);
  // Name the actual source, so a stale .env is not blamed for a shell export (or vice versa).
  const fromFile = envKeysFromFile().has("SAPPASSWORD") || envKeysFromFile().has("SAP_PASSWORD");
  scrubPasswordFromEnv(); // before the visible browser is launched
  const session = new SapSession(config, false);
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    await session.start({ allowMissingState: true, ignoreStoredState: true });
    const page = await session.newPage();
    await page.goto(config.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    if (!isAllowedLoginUrl(page.url())) {
      throw new Error(
        `The browser left the SAP domain (${page.url()}). Aborting so credentials are not ` +
          `typed on a foreign page. Check SAP_PROBE_URL.`,
      );
    }

    let needsManualStep = true;
    if (credentials) {
      const source = fromFile && envFile !== undefined ? envFile : "the process environment";
      console.log(`Signing in as ${credentials.username} with the credentials from ${source}...`);
      try {
        await fillLoginForm(page, config, credentials);
        await waitForLoginResult(page, config);
        needsManualStep = false;
        console.log("Automatic login completed.");
      } catch (error) {
        console.log(
          error instanceof MfaRequiredError
            ? "\nMFA required — please complete it in the browser window."
            : `\nAutomatic login could not finish: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (config.username) {
      // Best-effort prefill; the SAP identity provider changes field ids over time,
      // so failure here is not fatal — the user simply types the credentials.
      await page
        .fill(config.loginUserSelector, config.username, { timeout: 10_000 })
        .catch(() => undefined);
    }

    if (needsManualStep) {
      console.log("\nA browser window is open.");
      console.log("Sign in with your S-user (including MFA) until you see the SAP Note.");
      await rl.question("\nPress Enter here once you are logged in... ");
    }

    console.log("\nChecking the session (this can take a few seconds)...");
    if (!(await session.isAuthenticated())) {
      throw new Error("Still not authenticated — the portal keeps redirecting to the login page.");
    }

    await session.saveState();
    console.log(`\nSession saved to ${config.storageStatePath} (mode 0600).`);
    console.log("The MCP server can now run headless.");
    if (config.autoLoginEnabled) {
      console.log(
        "Automatic re-login is enabled: when this session expires, the server signs in " +
          "again by itself (unless MFA is requested).",
      );
    }
  } finally {
    rl.close();
    await session.close();
  }
}

main().catch((error: unknown) => {
  console.error("Login failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
