import TurndownService from "turndown";
import type { Page } from "playwright";
import { buildUrl, type Config } from "./config.js";
import { SessionExpiredError, type SapSession } from "./session.js";

export interface NoteHit {
  id: string;
  title: string;
  url: string;
}

export interface NoteDetail {
  id: string;
  title: string;
  url: string;
  markdown: string;
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript"]);

/** Matches note/KBA links regardless of the routing scheme the portal currently uses. */
const NOTE_LINK_PATTERN = /(?:\/notes?\/|note[_-]?number=|\/knowledge\/en\/)(\d{4,10})/i;

export function extractNoteId(href: string): string | undefined {
  const match = NOTE_LINK_PATTERN.exec(href);
  return match?.[1];
}

/**
 * Reads hits straight from the anchors of the rendered result list.
 * Deliberately selector-agnostic: any link pointing at a note number counts,
 * which survives the portal's frequent CSS/class renames.
 */
async function collectHits(page: Page, limit: number): Promise<NoteHit[]> {
  const anchors = await page.$$eval("a[href]", (elements) =>
    elements.map((element) => ({
      href: (element as HTMLAnchorElement).href,
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );

  const hits = new Map<string, NoteHit>();
  for (const anchor of anchors) {
    const id = extractNoteId(anchor.href);
    if (!id || hits.has(id)) continue;
    const title = anchor.text.replace(/^\d{4,10}\s*[-–:]\s*/, "").trim();
    if (title.length < 3) continue;
    hits.set(id, { id, title, url: anchor.href });
    if (hits.size >= limit) break;
  }
  return [...hits.values()];
}

/**
 * Primary search path.
 *
 * The SAP for Me note search is served by Coveo, not by the SAP backend: the portal
 * fetches a short-lived token from `.../coveo/CoveoToken` (authenticated by the session
 * cookies) and POSTs the query to Coveo's REST API. Scraping the rendered SPA never
 * worked because the results are drawn client-side from that JSON response. We replicate
 * the two calls directly, which is both reliable and fast (no page render needed).
 * If Coveo is unreachable we fall back to the old DOM scrape.
 */
export async function searchNotes(
  session: SapSession,
  config: Config,
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  try {
    return await searchNotesViaCoveo(session, config, query, limit);
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    // Coveo (org id / token endpoint) may have changed; try the legacy scrape before giving up.
    // Log the original error to stderr (safe for stdio MCP) so it is not silently lost.
    console.error(
      `Coveo search failed, falling back to DOM scrape: ${error instanceof Error ? error.message : String(error)}`,
    );
    return await searchNotesViaDom(session, config, query, limit);
  }
}

/** Coveo returns fields as either a scalar or a single-element array; normalise to a string. */
function coerceField(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : "";
  return value === undefined || value === null ? "" : String(value);
}

/** A result counts as a Note/KBA if it carries a numeric note id and a notes source/URI. */
const NOTE_SOURCE_PATTERN = /sap-note|knowledge-base-article/i;

interface CoveoResult {
  title?: string;
  clickUri?: string;
  raw?: Record<string, unknown>;
}

async function fetchCoveoToken(session: SapSession, config: Config): Promise<string> {
  const response = await session
    .request()
    .get(config.coveoTokenUrl, { headers: { accept: "application/json" } });

  if (!response.ok()) {
    // A redirect to the identity provider means the stored session is no longer valid.
    if ([401, 403].includes(response.status()) || /logon|signin|saml2/i.test(response.url())) {
      throw new SessionExpiredError();
    }
    throw new Error(`Coveo token request failed: HTTP ${response.status()}`);
  }

  let payload: { token?: string };
  try {
    payload = (await response.json()) as { token?: string };
  } catch {
    // HTML instead of JSON almost always means we were bounced to the login page.
    throw new SessionExpiredError();
  }
  if (!payload.token) throw new Error("Coveo token endpoint returned no token.");
  return payload.token;
}

async function searchNotesViaCoveo(
  session: SapSession,
  config: Config,
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  const token = await fetchCoveoToken(session, config);

  const response = await session.request().post(config.coveoSearchUrl, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: {
      locale: "en-US",
      q: query,
      searchHub: config.coveoSearchHub,
      tab: "All",
      sortCriteria: "relevancy",
      // Over-fetch: non-note results (blogs, docs) are filtered out below.
      numberOfResults: Math.min(limit * 2, 50),
      firstResult: 0,
      fieldsToInclude: ["mh_id", "source", "mh_alt_url", "objecttype", "documenttype", "language"],
    },
  });

  if (!response.ok()) throw new Error(`Coveo search failed: HTTP ${response.status()}`);
  const body = (await response.json()) as { results?: CoveoResult[] };

  const hits = new Map<string, NoteHit>();
  for (const result of body.results ?? []) {
    const raw = result.raw ?? {};
    const id = coerceField(raw.mh_id).trim();
    if (!/^\d{4,10}$/.test(id) || hits.has(id)) continue;

    const source = coerceField(raw.source);
    const clickUri = result.clickUri ?? "";
    const isNote = NOTE_SOURCE_PATTERN.test(source) || /\/sapnotes\/\d+/i.test(clickUri);
    if (!isNote) continue;

    const title =
      (result.title ?? "")
        .replace(/\s*[-|]\s*SAP for Me\s*$/i, "")
        .replace(/^\d{4,10}\s*[-–:]\s*/, "")
        .trim() || `SAP Note ${id}`;

    hits.set(id, { id, title, url: buildUrl(config.noteUrlTemplate, { id }) });
    if (hits.size >= limit) break;
  }
  return [...hits.values()];
}

/** Legacy fallback: scrape note links from the rendered search page. Kept as a safety net. */
export async function searchNotesViaDom(
  session: SapSession,
  config: Config,
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  const url = buildUrl(config.searchUrlTemplate, { query });
  const page = await session.open(url);
  try {
    return await collectHits(page, limit);
  } finally {
    await page.close();
  }
}

/** Picks the densest plausible content container, falling back to the whole body. */
async function extractMainHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll("main, article, [role='main'], .sapMPage, #content"),
    ];
    let best: Element = document.body;
    let bestLength = 0;
    for (const candidate of candidates) {
      const length = (candidate.textContent ?? "").length;
      if (length > bestLength) {
        best = candidate;
        bestLength = length;
      }
    }
    return best.innerHTML;
  });
}

export async function fetchNote(
  session: SapSession,
  config: Config,
  id: string,
): Promise<NoteDetail> {
  const url = buildUrl(config.noteUrlTemplate, { id });
  const page = await session.open(url);
  try {
    const html = await extractMainHtml(page);
    const markdown = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();

    if (markdown.length < 50) {
      throw new Error(
        `Note ${id} returned no readable content. The note may not exist, may be ` +
          `restricted for your S-user, or the portal layout changed (adjust SAP_NOTE_URL).`,
      );
    }

    const rawTitle = await page.title();
    const title = rawTitle.replace(/\s*[-|]\s*SAP.*$/i, "").trim() || `SAP Note ${id}`;

    return { id, title, url, markdown };
  } finally {
    await page.close();
  }
}
