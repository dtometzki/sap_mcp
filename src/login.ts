import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";

/**
 * Interactive login. Run once per machine (and again whenever the session expires).
 * A visible browser window is opened; sign in there, including MFA, then press Enter.
 * Credentials are optional — typing them into the browser yourself is the safer path,
 * because nothing is then read from the environment.
 */
async function main(): Promise<void> {
  const config = loadConfig();
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

main().catch((error: unknown) => {
  console.error("Login failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
