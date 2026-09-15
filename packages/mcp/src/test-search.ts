import {
  applicationEnvDirectories,
  isEntrypoint,
  safeErrorMessage,
  loadConfig,
  loadDotEnv,
  scrubCredentialsFromEnv,
  SapSession,
  searchNotes,
} from "@sap-notes/core";

/**
 * End-to-end smoke test for the new Coveo-backed search, using your stored session.
 *   npm run build
 *   node dist/test-search.js "HANA Revision"
 */
async function main(envDirectories: readonly string[]): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim() || "HANA Revision";
  loadDotEnv(envDirectories);
  const config = loadConfig();
  scrubCredentialsFromEnv(); // diagnostics never log in; keep credentials away from Chromium
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

export async function run(envDirectories: readonly string[] = applicationEnvDirectories(import.meta.url)): Promise<void> {
  await main(envDirectories).catch((error: unknown) => {
    console.error("Test failed:", safeErrorMessage(error));
    process.exitCode = 1;
  });
}

if (isEntrypoint(import.meta.url)) await run();
