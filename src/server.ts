import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SapSession, SessionExpiredError } from "./session.js";
import { fetchNote, searchNotes } from "./notes.js";

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
    await runSerialized(() => session.close()).catch(() => undefined);
  }
}

function toErrorText(error: unknown): string {
  if (error instanceof SessionExpiredError) return error.message;
  if (error instanceof Error) return `SAP portal request failed: ${error.message}`;
  return "SAP portal request failed with an unknown error.";
}

const server = new McpServer({ name: "sap-notes", version: "1.0.0" });

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
  async ({ query, limit }) => {
    try {
      const hits = await runSerialized(async () => {
        await ensureSession();
        const result = await searchNotes(session, config, query, limit);
        await persistSessionState();
        return result;
      });
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No notes found for: ${query}` }] };
      }
      const text = hits.map((hit) => `${hit.id} — ${hit.title}\n${hit.url}`).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      await recoverFromError(error);
      return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
    } finally {
      scheduleIdleClose();
    }
  },
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
  async ({ number }) => {
    try {
      const note = await runSerialized(async () => {
        await ensureSession();
        const result = await fetchNote(session, config, number);
        await persistSessionState();
        return result;
      });
      const text = `# ${note.id} — ${note.title}\n\nSource: ${note.url}\n\n${note.markdown}`;
      return { content: [{ type: "text", text }] };
    } catch (error) {
      await recoverFromError(error);
      return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
    } finally {
      scheduleIdleClose();
    }
  },
);

const SHUTDOWN_TIMEOUT_MS = 5_000;
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  // Do not let a hanging browser close keep the process alive forever.
  await Promise.race([
    requestQueue.then(() => session.close()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The MCP client may disappear without sending a signal (crash, some Windows hosts).
// stdin closing is the reliable cross-platform sign that the client is gone; without
// this, a running Playwright browser would keep an orphaned process alive.
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
