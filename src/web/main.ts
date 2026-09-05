import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { loadConfig, expandHomePath, intFromEnv } from "../config.js";
import { loadDotEnv, scrubCredentialsFromEnv } from "../env.js";
import { safeErrorMessage } from "../errors.js";
import { Vault, WebError } from "./vault.js";
import { BrowserSapGateway, WebService } from "./sap.js";
import { createWebServer, describeListenError } from "./http.js";

async function main(): Promise<void> {
  loadDotEnv();
  // Explicitly exclude legacy credentials from web configuration and browser environment.
  scrubCredentialsFromEnv();
  const config = { ...loadConfig(), username: undefined, password: undefined, autoLoginEnabled: true };
  const port = intFromEnv("SAP_WEB_PORT", 3210, 1, 65535);
  const idleLockMs = intFromEnv("SAP_WEB_IDLE_LOCK_MS", 30 * 60_000, 0);
  const directory = resolve(expandHomePath(process.env.SAP_WEB_DATA_DIR ?? join(homedir(), ".sap-notes-web")));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "server.lock");
  const acquire = async () => {
    try { return await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new WebError("ALREADY_RUNNING", "Sperrdatei prüfen: server.lock im Web-Datenverzeichnis.");
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          // Two starters may clean up the same stale lock; the loser must get the same
          // readable message instead of a raw EEXIST from the second exclusive open.
          await rm(lockPath, { force: true });
          try { return await open(lockPath, "wx", 0o600); }
          catch (retry) { if ((retry as NodeJS.ErrnoException).code !== "EEXIST") throw retry; }
        }
      }
      throw new WebError("ALREADY_RUNNING", "Für dieses Datenverzeichnis läuft bereits eine App.");
    }
  };
  const lockFile = await acquire();
  await lockFile.writeFile(String(process.pid));
  const vault = new Vault(join(directory, "vault.enc"));
  const service = new WebService(vault, (store, credentials) => new BrowserSapGateway(config, store, credentials));
  const server = createWebServer(service, { idleLockMs });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return; stopping = true;
    server.close();
    await service.lock();
    server.closeAllConnections();
    await lockFile.close(); await rm(lockPath, { force: true });
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  try {
    await new Promise<void>((resolveStart, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveStart); });
    console.log(`SAP Notes: http://127.0.0.1:${port}`);
  } catch (error) { await shutdown(); throw describeListenError(error, port); }
}
main().catch((error: unknown) => {
  console.error(error instanceof WebError ? error.message : safeErrorMessage(error));
  process.exitCode = 1;
});
