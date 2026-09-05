import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath, intFromEnv } from "../config.js";

/**
 * Shared by the server (main.ts) and the background launcher (daemon.ts): both must
 * agree on the port and the data directory, otherwise `web:stop` would look for the
 * lock file of a server that runs somewhere else.
 */
export function webPort(): number {
  return intFromEnv("SAP_WEB_PORT", 3210, 1, 65535);
}

export function webDataDirectory(): string {
  return resolve(expandHomePath(process.env.SAP_WEB_DATA_DIR ?? join(homedir(), ".sap-notes-web")));
}

export function webLockPath(directory = webDataDirectory()): string {
  return join(directory, "server.lock");
}

export function webLogPath(directory = webDataDirectory()): string {
  return join(directory, "web.log");
}

/** PID from a server.lock, or undefined when the file is missing or malformed. */
export function parseLockPid(content: string): number | undefined {
  const pid = Number(content.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether a process with this PID exists (EPERM counts as alive: it exists, just not ours). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
