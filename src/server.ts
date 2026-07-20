import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SapSession, SessionExpiredError } from "./session.js";
import { fetchNote, resetTokenCache, searchNotes } from "./notes.js";
import {
  downloadAttachment,
  fetchAttachmentList,
  type AttachmentDownload,
  type NoteAttachment,
} from "./attachments.js";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../package.json") as { version: string };

const MAX_RESULTS = 25;

/** Persist refreshed cookies at most this often; see persistSessionState(). */
const STATE_SAVE_INTERVAL_MS = 5 * 60_000;

const config = loadConfig();
const session = new SapSession(config, true);

/**
 * Lazily started so the browser only launches on the first real tool call.
 * SapSession.start() is idempotent and concurrency-safe, so no extra flag needed.
 */
function ensureSession(): Promise<void> {
  return session.start();
}

/**
 * SAP calls share one authenticated browser context and are deliberately serialized.
 * This keeps concurrent MCP clients from creating request bursts against the portal.
 */
let requestQueue: Promise<void> = Promise.resolve();

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(operation);
  requestQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

let lastStateSaveMs = 0;

/**
 * The portal rotates/extends cookies while the session is used, but the browser
 * context is volatile — without writing the state back, the stored session dies at
 * the ORIGINAL cookie expiry. Throttled and best-effort: a failed save must never
 * fail the tool call that triggered it. Called from inside the serialized queue.
 */
async function persistSessionState(): Promise<void> {
  const now = Date.now();
  if (now - lastStateSaveMs < STATE_SAVE_INTERVAL_MS) return;
  lastStateSaveMs = now;
  await session.saveState().catch(() => undefined);
}

/**
 * An idle headless Chromium holds roughly 200 MB of RAM. Close the session after a
 * period of inactivity; start() is lazy and idempotent, so the next tool call simply
 * relaunches the browser and re-reads the stored session state.
 */
let idleTimer: NodeJS.Timeout | undefined;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (config.idleTimeoutMs <= 0) return; // 0 disables the idle shutdown
  idleTimer = setTimeout(() => {
    // Enqueue via the request queue so we never close mid-operation.
    runSerialized(() => session.close()).catch(() => undefined);
  }, config.idleTimeoutMs);
  idleTimer.unref(); // the timer alone must not keep the process alive
}

/**
 * On session expiry, drop the stale browser context: the next call then re-reads
 * session.json from disk, so a fresh `npm run login` is picked up WITHOUT
 * restarting the MCP server. Serialized to avoid racing queued operations.
 */
async function recoverFromError(error: unknown): Promise<void> {
  if (error instanceof SessionExpiredError) {
    resetTokenCache();
    await runSerialized(() => session.close()).catch(() => undefined);
  }
}

function toErrorText(error: unknown): string {
  if (error instanceof SessionExpiredError) return error.message;
  if (error instanceof Error) return `SAP portal request failed: ${error.message}`;
  return "SAP portal request failed with an unknown error.";
}

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Shared wrapper for every tool call: serializes access, ensures the session,
 * persists refreshed cookies, handles errors, and reschedules the idle timer.
 */
async function executeTool<T>(
  operation: () => Promise<T>,
  format: (result: T) => string,
): Promise<ToolResponse> {
  try {
    const result = await runSerialized(async () => {
      await ensureSession();
      const value = await operation();
      await persistSessionState();
      return value;
    });
    return { content: [{ type: "text", text: format(result) }] };
  } catch (error) {
    await recoverFromError(error);
    return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
  } finally {
    scheduleIdleClose();
  }
}

const server = new McpServer({ name: "sap-notes", version: pkgVersion });

server.registerTool(
  "sap_notes_search",
  {
    title: "Search SAP Notes",
    description:
      "Full-text search for SAP Notes and Knowledge Base Articles in the authenticated SAP " +
      "support portal. Returns note numbers, titles and URLs. Use sap_note_get for the content.",
    inputSchema: {
      query: z.string().trim().min(2).describe("Search terms, e.g. 'HANA backup failed error 447'"),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    },
  },
  async ({ query, limit }) =>
    executeTool(
      () => searchNotes(session, config, query, limit),
      (hits) =>
        hits.length === 0
          ? `No notes found for: ${query}`
          : hits.map((hit) => `${hit.id} — ${hit.title}\n${hit.url}`).join("\n\n"),
    ),
);

server.registerTool(
  "sap_note_get",
  {
    title: "Get SAP Note",
    description:
      "Fetch the full content of a single SAP Note or KBA by its number, as Markdown " +
      "(symptom, reason, solution, validity, references).",
    inputSchema: {
      number: z.string().regex(/^\d{4,10}$/, "Note number must be 4-10 digits"),
    },
  },
  async ({ number }) =>
    executeTool(
      () => fetchNote(session, config, number),
      (note) => `# ${note.id} — ${note.title}\n\nSource: ${note.url}\n\n${note.markdown}`,
    ),
);

const NOTE_NUMBER_SCHEMA = z.string().regex(/^\d{4,10}$/, "Note number must be 4-10 digits");

function formatAttachmentList(number: string, attachments: NoteAttachment[]): string {
  if (attachments.length === 0) {
    return (
      `Note ${number} lists no attachments. If the note shows "A new version is in ` +
      `preparation", the portal hides attachments until the new version is released ` +
      `(see KBA 3453681).`
    );
  }
  const lines = attachments.map((attachment) => {
    const size = attachment.sizeBytes !== undefined ? ` (${attachment.sizeBytes} bytes)` : "";
    return `${attachment.fileName}${size}\n${attachment.url}`;
  });
  return `Note ${number} has ${attachments.length} attachment(s):\n\n${lines.join("\n\n")}`;
}

function formatAttachmentDownload(download: AttachmentDownload): string {
  const type = download.contentType ? `, ${download.contentType}` : "";
  const header = `Saved: ${download.filePath} (${download.bytes} bytes${type})`;
  if (download.text === undefined) return header;
  const truncated = download.textTruncated
    ? `\n\n[Output truncated — the complete file is on disk at ${download.filePath}]`
    : "";
  return `${header}\n\n--- ${download.attachment.fileName} ---\n${download.text}${truncated}`;
}

server.registerTool(
  "sap_note_attachments",
  {
    title: "List SAP Note Attachments",
    description:
      "List the file attachments of a SAP Note or KBA (file name, size, download URL). " +
      "Use sap_note_attachment_get to download one. While a new note version is in " +
      "preparation, the portal may hide attachments (KBA 3453681).",
    inputSchema: {
      number: NOTE_NUMBER_SCHEMA,
    },
  },
  async ({ number }) =>
    executeTool(
      () => fetchAttachmentList(session, config, number),
      (attachments) => formatAttachmentList(number, attachments),
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
        .optional()
        .describe(
          "File name as listed by sap_note_attachments (case-insensitive, substring is " +
            "enough if unique). May be omitted when the note has exactly one attachment.",
        ),
    },
  },
  async ({ number, fileName }) =>
    executeTool(
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
    executeTool(
      () => session.isAuthenticated(),
      (authenticated) =>
        authenticated
          ? "SAP session is valid and authenticated."
          : "SAP session is expired. Run `npm run login` to re-authenticate.",
    ),
);

const SHUTDOWN_TIMEOUT_MS = 5_000;
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  resetTokenCache();
  // Close the MCP transport first so no new requests arrive.
  await server.close().catch(() => undefined);
  // Do not let a hanging browser close keep the process alive forever.
  await Promise.race([
    requestQueue.then(() => session.close()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The MCP client may disappear without sending a signal (crash, some Windows hosts).
// stdin closing is the reliable cross-platform sign that the client is gone; without
// this, a running Playwright browser would keep an orphaned process alive.
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
