import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

export interface AppInfo {
  name: string;
  version: string;
  commit: { hash: string; subject: string; date: string } | null;
}
const execute = promisify(execFile);
const packageSchema = z.object({ version: z.string().min(1) });

/** Snapshot of the running checkout; archives without .git still show the version. */
export async function loadAppInfo(root = fileURLToPath(new URL("../../", import.meta.url))): Promise<AppInfo> {
  const pkg = packageSchema.parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown);
  let commit: AppInfo["commit"] = null;
  try {
    // Do not accidentally report a parent repository when running an exported archive.
    await stat(join(root, ".git"));
    const { stdout } = await execute("git", ["--no-pager", "log", "-1", "--format=%H%x00%s%x00%cI"], {
      cwd: root, timeout: 2000, maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const [hash, subject, date] = stdout.trimEnd().split("\0");
    if (hash && /^[a-f0-9]{40,64}$/.test(hash) && subject !== undefined && date && Number.isFinite(Date.parse(date))) {
      commit = { hash, subject, date };
    }
  } catch { /* No Git executable, no commits, or no repository: metadata stays optional. */ }
  return { name: "SAP Notes", version: pkg.version, commit };
}
