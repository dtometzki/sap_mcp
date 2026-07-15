import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";
import { searchNotes } from "./notes.js";

/**
 * End-to-end smoke test for the new Coveo-backed search, using your stored session.
 *   npm run build
 *   node dist/test-search.js "HANA Revision"
 */
async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim() || "HANA Revision";
  const config = loadConfig();
  const session = new SapSession(config, true); // headless, uses session.json
  await session.start();
  try {
    const hits = await searchNotes(session, config, query, 10);
    console.log(`\nQuery: "${query}" -> ${hits.length} hits\n`);
    for (const hit of hits) console.log(`  ${hit.id}  ${hit.title}\n    ${hit.url}`);
    if (hits.length === 0) console.log("  (no hits — check the query or session)");
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  console.error("Test failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
