import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SapSession, SessionExpiredError } from "./session.js";
import { fetchNote, searchNotes } from "./notes.js";

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
      query: z.string().min(2).describe("Search terms, e.g. 'HANA backup failed error 447'"),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      await ensureSession();
      const hits = await searchNotes(session, config, query, limit);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No notes found for: ${query}` }] };
      }
      const text = hits.map((hit) => `${hit.id} — ${hit.title}\n${hit.url}`).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
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
      await ensureSession();
      const note = await fetchNote(session, config, number);
      const text = `# ${note.id} — ${note.title}\n\nSource: ${note.url}\n\n${note.markdown}`;
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
    }
  },
);

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function shutdown(): Promise<void> {
  // Do not let a hanging browser close keep the process alive forever.
  await Promise.race([
    session.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.connect(new StdioServerTransport());
