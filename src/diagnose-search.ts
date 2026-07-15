import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { SapSession } from "./session.js";

/**
 * Diagnostic v4: capture the full Coveo search call.
 *
 * We learned the note search is powered by Coveo:
 *   POST https://<org>.org.coveo.com/rest/search/v2?organizationId=<org>
 * To replicate it from the MCP server we need, for THAT call:
 *   - the Authorization header (Coveo search token)
 *   - the full request body (query + the filters that scope it to SAP Notes)
 *   - the full response body (so we can map result -> note id/title/url)
 * and we need to know where the token comes from (which SAP endpoint issues it).
 *
 * You drive the search once; the script records everything about the Coveo traffic
 * and then hunts the token's origin among all other responses.
 *
 *   npm run build
 *   node dist/diagnose-search.js "HANA Revision"
 *
 * Writes diagnose-coveo.json locally. Review it, then paste it back (the token is
 * short-lived, but redact it if you prefer — I mainly need the body/response shape).
 */

interface Rec {
  kind: "request" | "response";
  method: string;
  url: string;
  status?: number;
  headers: Record<string, string>;
  body: string;
}

const isCoveoSearch = (url: string): boolean =>
  /\.coveo\.com\/rest\/search/i.test(url);

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim() || "HANA Revision";
  const config = loadConfig();
  const session = new SapSession(config, false);
  await session.start();
  const page = await session.newPage();

  const coveo: Rec[] = [];
  const allResponses: { url: string; body: string }[] = [];

  page.on("request", (req) => {
    if (!isCoveoSearch(req.url())) return;
    coveo.push({
      kind: "request",
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      body: req.postData() ?? "",
    });
  });

  page.on("response", async (response) => {
    const req = response.request();
    if (!["xhr", "fetch"].includes(req.resourceType())) return;
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    allResponses.push({ url: response.url(), body });
    if (isCoveoSearch(response.url())) {
      coveo.push({
        kind: "response",
        method: req.method(),
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        body,
      });
    }
  });

  await page.goto("https://me.sap.com/", { waitUntil: "domcontentloaded" });

  console.log("\n============================================================");
  console.log("In the open browser window:");
  console.log("  1. Sign in if needed.");
  console.log("  2. Open the SAP Notes / Knowledge Base search.");
  console.log(`  3. Search for:  ${query}  and let the results load.`);
  console.log("Then press Enter here.");
  console.log("============================================================\n");
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question("Press Enter once results are visible... ");
  rl.close();

  // Extract the bearer token from the Coveo request and hunt its origin.
  const searchReq = coveo.find((r) => r.kind === "request");
  const auth = searchReq?.headers["authorization"] ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();

  const tokenOrigins = bearer
    ? allResponses
        .filter((r) => !isCoveoSearch(r.url) && r.body.includes(bearer))
        .map((r) => ({ url: r.url, bodyPreview: r.body.slice(0, 800) }))
    : [];

  const report = {
    query,
    finalUrl: page.url(),
    coveoTrafficCount: coveo.length,
    coveo,
    tokenPresent: Boolean(bearer),
    tokenOrigins,
    allXhrUrls: [...new Set(allResponses.map((r) => r.url))],
  };
  await writeFile("diagnose-coveo.json", JSON.stringify(report, null, 2), "utf8");

  console.log(`\nCoveo requests/responses captured: ${coveo.length}`);
  console.log(`Authorization token present: ${Boolean(bearer)}`);
  console.log(`Token-issuing endpoints found: ${tokenOrigins.length}`);
  for (const t of tokenOrigins.slice(0, 5)) console.log(`  <- ${t.url}`);
  if (searchReq) {
    console.log(`\nSearch request body (first 600 chars):\n${searchReq.body.slice(0, 600)}`);
  }
  console.log("\nFull detail in diagnose-coveo.json");
  await session.close();
}

main().catch((error: unknown) => {
  console.error("Diagnostic failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
