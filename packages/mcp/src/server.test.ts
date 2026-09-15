import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("standalone MCP entrypoint negotiates stdio and preserves tools and expired-session responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-mcp-protocol-"));
  const envFile = join(directory, ".env");
  await writeFile(envFile, "", { mode: 0o600 });
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("./server.js", import.meta.url))], cwd: directory,
    env: { SAP_ENV_FILE: envFile, SAP_STATE_PATH: join(directory, "missing.json"), SAP_AUTO_LOGIN: "0" }, stderr: "pipe",
  });
  const errors: Error[] = [];
  client.onerror = error => errors.push(error);
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "sap-notes");
    assert.match(client.getServerVersion()?.version ?? "", /^\d+\.\d+\.\d+$/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["sap_note_attachments", "sap_note_attachment_get", "sap_note_get", "sap_notes_search", "sap_session_status"].sort());
    const result = await client.callTool({ name: "sap_session_status", arguments: {} });
    assert.match(JSON.stringify(result), /npm run login/);
    assert.deepEqual(errors, [], "no non-protocol output on stdout");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
