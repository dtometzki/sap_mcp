import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Only recognize our explicit workspace layout, never an unrelated parent repository. */
export function applicationWorkspaceRoot(appRoot: string): string | undefined {
  const root = resolve(appRoot, "../..");
  if (dirname(appRoot) !== join(root, "packages")) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; workspaces?: unknown };
    if (manifest.name === "sap-notes-mcp" && Array.isArray(manifest.workspaces) && manifest.workspaces.includes("packages/*")) return root;
  } catch { /* Standalone installations have no workspace. */ }
  return undefined;
}

export function applicationEnvDirectories(entryUrl: string): string[] {
  const appRoot = fileURLToPath(new URL("../", entryUrl)).replace(/\/$/, "");
  const workspace = applicationWorkspaceRoot(appRoot);
  return [...new Set([appRoot, ...(workspace ? [workspace] : []), process.cwd()])];
}

/** Imports expose run() without starting another process or reading configuration. */
export function isEntrypoint(entryUrl: string): boolean {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(entryUrl); }
  catch { return false; }
}
