import { homedir } from "node:os";
import { join } from "node:path";

/**
 * All portal URLs are configurable: SAP changes the support portal frontend
 * without notice, so a broken selector/URL must be fixable without a code change.
 */
export interface Config {
  /** Playwright storageState file (cookies + localStorage of the logged-in session). */
  storageStatePath: string;
  /** Page that lists search hits. {query} is replaced with the URL-encoded search term.
   *  Only used by the legacy DOM-scraping fallback; the primary path is Coveo. */
  searchUrlTemplate: string;
  /** SAP endpoint that issues a short-lived Coveo search token (uses the session cookies). */
  coveoTokenUrl: string;
  /** Coveo REST search endpoint the portal posts the query to. */
  coveoSearchUrl: string;
  /** Coveo searchHub the portal identifies as; scopes the search pipeline. */
  coveoSearchHub: string;
  /** Detail page of a single note. {id} is replaced with the note number. */
  noteUrlTemplate: string;
  /** URL used to verify that the stored session is still valid. */
  sessionProbeUrl: string;
  /** Milliseconds to wait for portal pages (SPA, slow backend). */
  navigationTimeoutMs: number;
  /**
   * Milliseconds to wait for "networkidle". The portal keeps polling connections
   * open, so this almost always times out; keep it short so we do not block on it.
   */
  networkIdleTimeoutMs: number;
  /** Extra settle time after network idle, for late client-side rendering. */
  renderSettleMs: number;
  /** Only used by the interactive login CLI to prefill the username field, never by the server. */
  username: string | undefined;
}

const DEFAULT_STATE_PATH = join(homedir(), ".sap-notes-mcp", "session.json");

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const coveoOrg = process.env.SAP_COVEO_ORG ?? "sapamericaproductiontyfzmfz0";
  return {
    storageStatePath: process.env.SAP_STATE_PATH ?? DEFAULT_STATE_PATH,
    searchUrlTemplate:
      process.env.SAP_SEARCH_URL ?? "https://me.sap.com/search?q={query}&tab=notes",
    coveoTokenUrl:
      process.env.SAP_COVEO_TOKEN_URL ?? "https://me.sap.com/backend/raw/coveo/CoveoToken",
    coveoSearchUrl:
      process.env.SAP_COVEO_SEARCH_URL ??
      `https://${coveoOrg}.org.coveo.com/rest/search/v2?organizationId=${coveoOrg}`,
    coveoSearchHub: process.env.SAP_COVEO_SEARCH_HUB ?? "SAP for Me",
    noteUrlTemplate: process.env.SAP_NOTE_URL ?? "https://me.sap.com/notes/{id}",
    sessionProbeUrl: process.env.SAP_PROBE_URL ?? "https://me.sap.com/notes/2170696",
    navigationTimeoutMs: intFromEnv("SAP_NAV_TIMEOUT_MS", 60_000),
    networkIdleTimeoutMs: intFromEnv("SAP_NETWORK_IDLE_TIMEOUT_MS", 4_000),
    renderSettleMs: intFromEnv("SAP_RENDER_SETTLE_MS", 2_500),
    username: process.env.SAP_USERNAME,
  };
}

export function buildUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`URL template placeholder {${key}} has no value`);
    }
    return encodeURIComponent(value);
  });
}
