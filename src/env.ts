import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env support without a runtime dependency.
 *
 * The MCP server is started by the MCP client (Claude Desktop, Cursor, ...), which
 * passes almost no environment of its own — so credentials and overrides have to come
 * from a file next to the installation. dotenv is deliberately not pulled in: the
 * parser below is ~40 lines, auditable, and a credentials path is the wrong place to
 * add third-party code.
 */

/** Real environment variables always win, so an MCP client's `env` block can override the file. */
export function applyEnv(values: Record<string, string>): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Parses dotenv syntax: `KEY=value`, optional `export ` prefix, `#` comments,
 * single/double quotes (escape sequences only inside double quotes).
 * Invalid lines are ignored rather than thrown on — a stray line must not stop the
 * server from starting.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      // Only double quotes interpret escapes; single quotes stay literal (as in dotenv).
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"');
      }
    } else {
      // Unquoted values end at an inline comment that is preceded by whitespace,
      // so a password containing '#' still survives.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[key] = value;
  }
  return result;
}

/** Package root (…/sap), resolved from dist/env.js at runtime and src/env.ts under ts-node. */
function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

/**
 * Candidate locations, first existing file wins:
 * SAP_ENV_FILE > <package root>/.env > <cwd>/.env. The package root comes first
 * because the MCP client usually starts the server with an unrelated cwd.
 */
export function envFileCandidates(): string[] {
  const explicit = process.env.SAP_ENV_FILE;
  const candidates = explicit ? [explicit] : [];
  candidates.push(join(packageRoot(), ".env"), join(process.cwd(), ".env"));
  return candidates;
}

/**
 * Warns (stderr, never stdout — stdout is the MCP protocol channel) when the file
 * holding the password is readable by other local users.
 */
function warnOnLoosePermissions(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `[sap-notes] warning: ${path} is mode ${mode.toString(8).padStart(3, "0")} — ` +
          `it contains credentials. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // Permission introspection is best-effort (Windows has no meaningful mode bits).
  }
}

/**
 * Loads the first .env found into process.env and returns its path, or undefined
 * when no file exists. Must be called before loadConfig().
 */
export function loadDotEnv(): string | undefined {
  for (const path of envFileCandidates()) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    warnOnLoosePermissions(path);
    applyEnv(parseDotEnv(content));
    return path;
  }
  return undefined;
}
