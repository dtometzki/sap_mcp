import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadDotEnv, scrubCredentialsFromEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";
import { credentialsFromConfig, performAutoLogin } from "./autoLogin.js";
import { fetchNote, resetTokenCache, searchNotes, wrapUntrustedPortalContent } from "./notes.js";
import {
  downloadAttachment,
  fetchAttachmentList,
  formatAttachmentDownload,
  formatAttachmentList,
} from "./attachments.js";
import { ToolRunner } from "./toolRunner.js";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../package.json") as { version: string };

const MAX_RESULTS = 25;

// Must run before loadConfig(): MCP clients start the server with a bare environment,
// so SAPUSER/SAPPASSWORD and the URL overrides come from the .env file next to the install.
loadDotEnv();

const config = loadConfig();
// The password now lives in `config` only: keep it out of the environment that the
// headless Chromium (and any other child process) would otherwise inherit.
scrubCredentialsFromEnv();
const session = new SapSession(config, true);
const credentials = config.autoLoginEnabled ? credentialsFromConfig(config) : undefined;

/**
 * Non-interactive re-login for the ToolRunner's recovery path. Undefined when no
 * credentials are configured, which keeps the previous behaviour (report the expiry and
 * let the user run `npm run login`) completely unchanged.
 */
const reauthenticate = credentials
  ? async (): Promise<void> => {
      process.stderr.write("[sap-notes] session expired — attempting automatic login...\n");
      await performAutoLogin(config, credentials, true);
      process.stderr.write("[sap-notes] automatic login succeeded.\n");
    }
  : undefined;

/**
 * Lazily started so the browser only launches on the first real tool call.
 * SapSession.start() is idempotent and concurrency-safe, so no extra flag needed.
 */
function ensureSession(): Promise<void> {
  return session.start();
}

/** Persist refreshed cookies at most this often; see ToolRunner.persistSessionState(). */
const STATE_SAVE_INTERVAL_MS = 5 * 60_000;

const runner = new ToolRunner(
  {
    ensureSession,
    saveState: () => session.saveState(),
    close: () => session.close(),
    resetTokenCache,
    reauthenticate,
  },
  {
    idleTimeoutMs: config.idleTimeoutMs,
    stateSaveIntervalMs: STATE_SAVE_INTERVAL_MS,
    autoLoginCooldownMs: config.autoLoginCooldownMs,
  },
);

const server = new McpServer({ name: "sap-notes", version: pkgVersion });

server.registerTool(
  "sap_notes_search",
  {
    title: "Search SAP Notes",
    description:
      "Full-text search for SAP Notes and Knowledge Base Articles in the authenticated SAP " +
      "support portal. Returns note numbers, titles and URLs. Use sap_note_get for the content.",
    inputSchema: {
      query: z
        .string()
        .trim()
        .min(2)
        .max(500)
        .describe("Search terms, e.g. 'HANA backup failed error 447'"),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    },
  },
  async ({ query, limit }) =>
    runner.execute(
      () => searchNotes(session, config, query, limit),
      (hits) =>
        hits.length === 0
          ? `No notes found for: ${query}`
          : // Titles come from the portal too — same trust boundary as the note body.
            wrapUntrustedPortalContent(
              "search results",
              hits.map((hit) => `${hit.id} — ${hit.title}\n${hit.url}`).join("\n\n"),
            ),
    ),
);

const NOTE_NUMBER_SCHEMA = z.string().regex(/^\d{4,10}$/, "Note number must be 4-10 digits");

server.registerTool(
  "sap_note_get",
  {
    title: "Get SAP Note",
    description:
      "Fetch the full content of a single SAP Note or KBA by its number, as Markdown " +
      "(symptom, reason, solution, validity, references).",
    inputSchema: {
      number: NOTE_NUMBER_SCHEMA,
    },
  },
  async ({ number }) =>
    runner.execute(
      () => fetchNote(session, config, number),
      (note) =>
        wrapUntrustedPortalContent(
          `SAP Note ${note.id}`,
          `# ${note.id} — ${note.title}\n\nSource: ${note.url}\n\n${note.markdown}`,
        ),
    ),
);

server.registerTool(
  "sap_note_attachments",
  {
    title: "List SAP Note Attachments",
    description:
      "List the file attachments of a SAP Note or KBA (file name and size). " +
      "Use sap_note_attachment_get to download one. While a new note version is in " +
      "preparation, the portal may hide attachments (KBA 3453681).",
    inputSchema: {
      number: NOTE_NUMBER_SCHEMA,
    },
  },
  async ({ number }) =>
    runner.execute(
      () => fetchAttachmentList(session, config, number),
      (attachments) =>
        attachments.length === 0
          ? formatAttachmentList(number, attachments)
          : // File names are portal-supplied strings, not something the client should act on.
            wrapUntrustedPortalContent(
              "attachment list",
              formatAttachmentList(number, attachments),
            ),
    ),
);

server.registerTool(
  "sap_note_attachment_get",
  {
    title: "Download SAP Note Attachment",
    description:
      "Download one attachment of a SAP Note or KBA to disk " +
      "(SAP_ATTACHMENT_DIR, default ~/Downloads/sap-notes/<note>/). " +
      "Text attachments (.txt, .sql, .csv, ...) are additionally returned inline.",
    inputSchema: {
      number: NOTE_NUMBER_SCHEMA,
      fileName: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "File name as listed by sap_note_attachments (case-insensitive, substring is " +
            "enough if unique). May be omitted when the note has exactly one attachment.",
        ),
    },
  },
  async ({ number, fileName }) =>
    runner.execute(
      () => downloadAttachment(session, config, number, fileName),
      formatAttachmentDownload,
    ),
);

server.registerTool(
  "sap_session_status",
  {
    title: "SAP Session Status",
    description:
      "Check whether the stored SAP session is still authenticated. " +
      "Use this to proactively detect an expired session before running searches.",
    inputSchema: {},
  },
  async () =>
    runner.execute(
      async () => {
        const authenticated = await session.isAuthenticated();
        if (!authenticated) {
          // Drop the dead context here, because returning false is not an error and so
          // never reaches the runner's recovery path. Without this the server would keep
          // using the expired cookie jar instead of re-reading session.json on the next call.
          resetTokenCache();
          // Already inside the serialized queue — close directly, do not re-enqueue.
          await session.close().catch(() => undefined);
        }
        return authenticated;
      },
      (authenticated) =>
        authenticated
          ? "SAP session is valid and authenticated."
          : credentials
            ? "SAP session is expired. The next tool call will attempt an automatic login " +
              "with the credentials from .env; run `npm run login` if that fails (e.g. MFA)."
            : "SAP session is expired. Run `npm run login` to re-authenticate.",
      { persistState: false },
    ),
);

const SHUTDOWN_TIMEOUT_MS = 5_000;
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // Close the MCP transport first so no new requests arrive.
  await server.close().catch(() => undefined);
  // Waits for queued work, then closes the browser (bounded by its own timeout).
  await runner.shutdown(SHUTDOWN_TIMEOUT_MS);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The MCP client may disappear without sending a signal (crash, some Windows hosts).
// stdin closing is the reliable cross-platform sign that the client is gone; without
// this, a running Playwright browser would keep an orphaned process alive.
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
