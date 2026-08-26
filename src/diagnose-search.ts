import { chmod, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { scrubCredentialsFromEnv } from "./env.js";
import { redactUrlForLog } from "./urls.js";
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
 * Writes diagnose-coveo.json locally with credentials redacted and owner-only permissions.
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

const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER_PATTERN.test(name) ? "[REDACTED]" : value,
    ]),
  );
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim() || "HANA Revision";
  const config = loadConfig();
  scrubCredentialsFromEnv(); // diagnostics never log in; keep credentials away from Chromium
  const session = new SapSession(config, false);
  await session.start();
  try {
    const page = await session.newPage();

    const coveo: Rec[] = [];
    const allResponses: { url: string; body: string }[] = [];
    let bearer = "";

    page.on("request", (req) => {
      if (!isCoveoSearch(req.url())) return;
      const headers = req.headers();
      bearer ||= (headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      coveo.push({
        kind: "request",
        method: req.method(),
        url: req.url(),
        headers: redactHeaders(headers),
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
          headers: redactHeaders(response.headers()),
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
    try {
      await rl.question("Press Enter once results are visible... ");
    } finally {
      rl.close();
    }

    // Hunt the token's origin in memory, but never persist the token itself.
    const searchReq = coveo.find((r) => r.kind === "request");

    const tokenOrigins = bearer
      ? allResponses
          .filter((r) => !isCoveoSearch(r.url) && r.body.includes(bearer))
          .map((r) => ({ url: r.url, bodyPreview: r.body.slice(0, 800) }))
      : [];

    const report = {
      query,
      finalUrl: redactUrlForLog(page.url()),
      coveoTrafficCount: coveo.length,
      coveo: coveo.map((record) => ({
        ...record,
        url: redactUrlForLog(record.url),
        headers: redactHeaders(record.headers),
        body: redactSecret(record.body, bearer),
      })),
      tokenPresent: Boolean(bearer),
      tokenOrigins: tokenOrigins.map((origin) => ({
        url: redactUrlForLog(origin.url),
        bodyPreview: redactSecret(origin.bodyPreview, bearer),
      })),
      allXhrUrls: [...new Set(allResponses.map((r) => redactUrlForLog(r.url)))],
    };
    const reportPath = "diagnose-coveo.json";
    await writeFile(reportPath, JSON.stringify(report, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(reportPath, 0o600);

    console.log(`\nCoveo requests/responses captured: ${coveo.length}`);
    console.log(`Authorization token present: ${Boolean(bearer)}`);
    console.log(`Token-issuing endpoints found: ${tokenOrigins.length}`);
    for (const t of tokenOrigins.slice(0, 5)) console.log(`  <- ${t.url}`);
    if (searchReq) {
      console.log(`\nSearch request body (first 600 chars):\n${searchReq.body.slice(0, 600)}`);
    }
    console.log("\nRedacted detail in diagnose-coveo.json (mode 0600)");
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  console.error("Diagnostic failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
