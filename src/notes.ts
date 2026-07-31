import TurndownService from "turndown";
import type { Page } from "playwright";
import { z } from "zod";
import { buildUrl, type Config } from "./config.js";
import {
  AccessDeniedError,
  SessionExpiredError,
  assertNotLoggedOut,
  looksLikeLoginPage,
  type SapSession,
} from "./session.js";

/** Whether an error is transient (network / 5xx) and worth retrying. */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const httpStatus = /HTTP (\d{3})/.exec(error.message)?.[1];
  if (httpStatus) return Number(httpStatus) >= 500;
  return /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(
    error.message,
  );
}

/** Retry once after a short delay on transient errors (network, 5xx). */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 1_000): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof AccessDeniedError) throw error;
      if (attempt >= retries || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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
    if (error instanceof SessionExpiredError || error instanceof AccessDeniedError) throw error;
    // Coveo (org id / token endpoint) may have changed; try the legacy scrape before giving up.
    // Log the original error to stderr (safe for stdio MCP) so it is not silently lost.
    console.error(
      `Coveo search failed, falling back to DOM scrape: ${error instanceof Error ? error.message : String(error)}`,
    );
    return await searchNotesViaDom(session, config, query, limit);
  }
}

/** Coveo returns fields as either a scalar or a single-element array; normalise to a string. */
export function coerceField(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? coerceField(value[0]) : "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** A result counts as a Note/KBA if it carries a numeric note id and a notes source/URI. */
const NOTE_SOURCE_PATTERN = /sap-note|knowledge-base-article/i;

const CoveoResultSchema = z
  .object({
    title: z.string().optional(),
    clickUri: z.string().optional(),
    raw: z.record(z.unknown()).optional(),
  })
  .passthrough();

const CoveoResponseSchema = z
  .object({
    results: z.array(CoveoResultSchema),
    totalCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

type CoveoResponse = z.infer<typeof CoveoResponseSchema>;

/** Validate external API data so a Coveo schema change triggers the DOM fallback. */
export function parseCoveoResponse(payload: unknown): CoveoResponse {
  const parsed = CoveoResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Unexpected Coveo response schema (${summary})`);
  }
  return parsed.data;
}

export type CoveoResult = z.infer<typeof CoveoResultSchema>;

/**
 * Maps a single Coveo result to a NoteHit, or undefined when the result is not a
 * Note/KBA (Coveo also returns blogs and documentation). Pure so the mapping — the
 * part most likely to break when SAP renames fields — is unit-testable offline.
 */
export function mapCoveoResult(
  result: CoveoResult,
  noteUrlTemplate: string,
): NoteHit | undefined {
  const raw = result.raw ?? {};
  const id = coerceField(raw.mh_id).trim();
  if (!/^\d{4,10}$/.test(id)) return undefined;

  const source = coerceField(raw.source);
  const clickUri = result.clickUri ?? "";
  const isNote = NOTE_SOURCE_PATTERN.test(source) || /\/sapnotes\/\d+/i.test(clickUri);
  if (!isNote) return undefined;

  const title =
    (result.title ?? "")
      .replace(/\s*[-|]\s*SAP for Me\s*$/i, "")
      .replace(/^\d{4,10}\s*[-–:]\s*/, "")
      .trim() || `SAP Note ${id}`;

  return { id, title, url: buildUrl(noteUrlTemplate, { id }) };
}

const CoveoTokenSchema = z.object({ token: z.string().min(1) }).passthrough();

/** Coveo tokens are short-lived; cache to avoid a roundtrip on every search. */
const TOKEN_TTL_MS = 4 * 60_000;
let cachedToken: { value: string; expiresAt: number } | undefined;

/** Drops the cached Coveo token; call when the underlying session changes or closes. */
export function resetTokenCache(): void {
  cachedToken = undefined;
}

async function fetchCoveoToken(session: SapSession, config: Config): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const response = await session
    .request()
    .get(config.coveoTokenUrl, {
      headers: { accept: "application/json" },
      timeout: config.apiTimeoutMs,
    });

  try {
    if (!response.ok()) {
      cachedToken = undefined;
      assertNotLoggedOut(response.status(), response.url(), "Coveo token endpoint", response.ok());
      throw new Error(`Coveo token request failed: HTTP ${response.status()}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      cachedToken = undefined;
      const contentType = response.headers()["content-type"] ?? "";
      if (/text\/html/i.test(contentType) || looksLikeLoginPage(response.url())) {
        throw new SessionExpiredError();
      }
      throw new Error("Coveo token endpoint returned invalid JSON.");
    }
    const parsed = CoveoTokenSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Coveo token endpoint returned no valid token.");
    cachedToken = { value: parsed.data.token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return parsed.data.token;
  } finally {
    // APIResponse bodies otherwise remain in memory for the lifetime of the browser context.
    await response.dispose().catch(() => undefined);
  }
}

const COVEO_PAGE_SIZE = 50;
const MAX_COVEO_PAGES = 3;

async function searchNotesViaCoveo(
  session: SapSession,
  config: Config,
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  const token = await withRetry(() => fetchCoveoToken(session, config));
  const hits = new Map<string, NoteHit>();

  for (let pageIndex = 0; pageIndex < MAX_COVEO_PAGES && hits.size < limit; pageIndex += 1) {
    const firstResult = pageIndex * COVEO_PAGE_SIZE;
    const body = await withRetry(async () => {
      const response = await session.request().post(config.coveoSearchUrl, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        timeout: config.apiTimeoutMs,
        data: {
          locale: "en-US",
          q: query,
          searchHub: config.coveoSearchHub,
          tab: "All",
          sortCriteria: "relevancy",
          // Over-fetch and paginate because Coveo also returns blogs and documentation.
          numberOfResults: COVEO_PAGE_SIZE,
          firstResult,
          fieldsToInclude: [
            "mh_id",
            "source",
            "mh_alt_url",
            "objecttype",
            "documenttype",
            "language",
          ],
        },
      });

      try {
        if (!response.ok()) throw new Error(`Coveo search failed: HTTP ${response.status()}`);
        return parseCoveoResponse(await response.json());
      } finally {
        await response.dispose().catch(() => undefined);
      }
    });

    for (const result of body.results) {
      const hit = mapCoveoResult(result, config.noteUrlTemplate);
      if (!hit || hits.has(hit.id)) continue;
      hits.set(hit.id, hit);
      if (hits.size >= limit) break;
    }

    // A full first page with zero surviving hits almost always means Coveo renamed
    // the source/id fields, not "no results" — surface that instead of failing silently.
    if (pageIndex === 0 && hits.size === 0 && body.results.length > 0) {
      console.error(
        `Coveo returned ${body.results.length} results for "${query}" but none matched ` +
          "the Note/KBA filter — the 'source'/'mh_id' field naming may have changed " +
          "(see mapCoveoResult in notes.ts).",
      );
    }

    const exhaustedResults = body.results.length < COVEO_PAGE_SIZE;
    const reachedTotal =
      body.totalCount !== undefined && firstResult + body.results.length >= body.totalCount;
    if (exhaustedResults || reachedTotal) break;
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
  return session.withOpenPage(url, (page) => collectHits(page, limit));
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
  return withRetry(async () =>
    session.withOpenPage(url, async (page) => {
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
    }),
  );
}
