import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDotEnv, scrubCredentialsFromEnv } from "../env.js";
import { WebError } from "./vault.js";
import { parseLockPid, processAlive, webDataDirectory, webLockPath, webLogPath, webPort } from "./paths.js";

/**
 * Background launcher for the web app, so `npm run web` does not have to occupy a
 * terminal: `web:start` detaches the server (own session, output to web.log),
 * `web:stop` ends it via the PID in server.lock, `web:status` reports both.
 *
 * The server itself is unchanged: it still writes server.lock, still binds to
 * 127.0.0.1 only, and still locks the vault on SIGTERM.
 */

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function lockedPid(lockPath: string): Promise<number | undefined> {
  try {
    const pid = parseLockPid(await readFile(lockPath, "utf8"));
    return pid !== undefined && processAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Only a healthy server counts as started, not merely a spawned process. */
async function responds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/about`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export async function start(): Promise<void> {
  const port = webPort();
  const directory = webDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = webLockPath(directory);
  const running = await lockedPid(lockPath);
  if (running !== undefined) {
    console.log(`SAP Notes läuft bereits (PID ${running}): http://127.0.0.1:${port}`);
    return;
  }
  const logPath = webLogPath(directory);
  // 0600: the log never carries credentials, but it names notes and search terms.
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  await log.close();

  const deadline = Date.now() + START_TIMEOUT_MS;
  let exitCode: number | null | undefined;
  child.once("exit", (code) => { exitCode = code; });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) break;
    if (await responds(port)) {
      console.log(`SAP Notes gestartet (PID ${child.pid}): http://127.0.0.1:${port}`);
      console.log(`Protokoll: ${logPath} — beenden mit: npm run web:stop`);
      return;
    }
    await sleep(POLL_MS);
  }
  const tail = (await readFile(logPath, "utf8").catch(() => "")).trimEnd().split("\n").slice(-5).join("\n");
  throw new WebError(
    "START_FAILED",
    exitCode !== undefined
      ? `Der Server hat sich sofort beendet (Exit-Code ${exitCode}). Letzte Zeilen aus ${logPath}:\n${tail}`
      : `Der Server antwortet nach ${START_TIMEOUT_MS / 1000} s nicht auf Port ${port}. Siehe ${logPath}.`,
  );
}

export async function stop(): Promise<void> {
  const lockPath = webLockPath();
  const pid = await lockedPid(lockPath);
  if (pid === undefined) {
    console.log("SAP Notes läuft nicht (keine aktive server.lock).");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      console.log(`SAP Notes beendet (PID ${pid}); der Tresor ist gesperrt.`);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new WebError("STOP_FAILED", `Prozess ${pid} läuft nach ${STOP_TIMEOUT_MS / 1000} s noch. Manuell beenden: kill ${pid}`);
}

export async function status(): Promise<void> {
  const port = webPort();
  const pid = await lockedPid(webLockPath());
  if (pid === undefined) {
    console.log(`SAP Notes läuft nicht. Starten mit: npm run web:start (Port ${port})`);
    return;
  }
  const healthy = await responds(port);
  console.log(
    healthy
      ? `SAP Notes läuft (PID ${pid}): http://127.0.0.1:${port}`
      : `Prozess ${pid} hält server.lock, antwortet aber nicht auf Port ${port} (anderer SAP_WEB_PORT beim Start?).`,
  );
}

async function main(): Promise<void> {
  // The same .env the server reads, so SAP_WEB_PORT/SAP_WEB_DATA_DIR resolve identically.
  loadDotEnv();
  // The server reads .env itself; the S-user credentials must not travel via our environment.
  scrubCredentialsFromEnv();
  const command = process.argv[2];
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "status") return status();
  throw new WebError("USAGE", "Verwendung: node dist/web/daemon.js start|stop|status");
}

main().catch((error: unknown) => {
  console.error(error instanceof WebError ? error.message : "Der Befehl konnte nicht ausgeführt werden.");
  process.exitCode = 1;
});
