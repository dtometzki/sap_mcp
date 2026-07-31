import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";
import { fetchNote, resetTokenCache, searchNotes } from "./notes.js";
import {
  downloadAttachment,
  fetchAttachmentList,
  type AttachmentDownload,
  type NoteAttachment,
} from "./attachments.js";
import { ToolRunner } from "./toolRunner.js";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../package.json") as { version: string };

const MAX_RESULTS = 25;

const config = loadConfig();
const session = new SapSession(config, true);

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
  },
  { idleTimeoutMs: config.idleTimeoutMs, stateSaveIntervalMs: STATE_SAVE_INTERVAL_MS },
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
      query: z.string().trim().min(2).describe("Search terms, e.g. 'HANA backup failed error 447'"),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    },
  },
  async ({ query, limit }) =>
    runner.execute(
      () => searchNotes(session, config, query, limit),
      (hits) =>
        hits.length === 0
          ? `No notes found for: ${query}`
          : hits.map((hit) => `${hit.id} — ${hit.title}\n${hit.url}`).join("\n\n"),
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
      (note) => `# ${note.id} — ${note.title}\n\nSource: ${note.url}\n\n${note.markdown}`,
    ),
);

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
    runner.execute(
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
