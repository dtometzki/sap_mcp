import { homedir } from "node:os";
import { join } from "node:path";
import { envKeysFromFile } from "./env.js";
import { isAllowedApiUrl, isAllowedPageUrl } from "./urls.js";

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
  /** JSON API behind the note detail page; source of the attachment list. {id} = note number. */
  noteDetailApiUrlTemplate: string;
  /** Directory attachments are downloaded to (one subfolder per note number). */
  attachmentDirPath: string;
  /** URL used to verify that the stored session is still valid. */
  sessionProbeUrl: string;
  /** Milliseconds to wait for portal pages (SPA, slow backend). */
  navigationTimeoutMs: number;
  /**
   * Milliseconds to wait for direct HTTP API calls (Coveo token/search, the
   * note-detail API, attachment downloads). These run inside the serialized
   * tool queue, so a hung request would otherwise block every other client.
   */
  apiTimeoutMs: number;
  /**
   * Milliseconds to wait for "networkidle". The portal keeps polling connections
   * open, so this almost always times out; keep it short so we do not block on it.
   */
  networkIdleTimeoutMs: number;
  /** Extra settle time after network idle, for late client-side rendering. */
  renderSettleMs: number;
  /**
   * Close the headless browser after this many milliseconds without a tool call
   * (frees ~200 MB RAM); the next call relaunches it lazily. 0 disables.
   */
  idleTimeoutMs: number;
  /** S-user for the login form (SAPUSER, legacy: SAP_USERNAME). */
  username: string | undefined;
  /** Password for the login form (SAPPASSWORD, legacy: SAP_PASSWORD). Only ever read from .env. */
  password: string | undefined;
  /**
   * Whether the server may log in by itself when the stored session has expired.
   * Requires username + password; SAP_AUTO_LOGIN=0 disables it even then.
   */
  autoLoginEnabled: boolean;
  /** After a failed automatic login, do not try again for this long (throttles login storms). */
  autoLoginCooldownMs: number;
  /** Milliseconds to wait for a single login step (field appears, page reacts). */
  loginStepTimeoutMs: number;
  /** Selector of the user/e-mail field on the SAP identity provider. */
  loginUserSelector: string;
  /** Selector of the password field. */
  loginPasswordSelector: string;
  /** Selector of the submit button; Enter is pressed when it is not present. */
  loginSubmitSelector: string;
  /** Selector that identifies an MFA/one-time-code prompt (never automatable). */
  loginMfaSelector: string;
}

/**
 * Default selectors for the SAP identity provider. Configurable for the same reason the
 * URLs are: SAP reworks the logon frontend without notice, and a renamed field id must be
 * fixable in .env instead of in a release.
 */
const DEFAULT_LOGIN_USER_SELECTOR =
  "input#j_username, input[name='j_username'], input[name='mail'], input[type='email']";
const DEFAULT_LOGIN_PASSWORD_SELECTOR =
  "input#j_password, input[name='j_password'], input[type='password']";
const DEFAULT_LOGIN_SUBMIT_SELECTOR =
  "#logOnFormSubmit, button[type='submit'], input[type='submit']";
const DEFAULT_LOGIN_MFA_SELECTOR = [
  "input[autocomplete='one-time-code']",
  "input[name*='otp' i]",
  "input[id*='otp' i]",
  "input[name*='passcode' i]",
  "input[id*='passcode' i]",
].join(", ");

const DEFAULT_STATE_PATH = join(homedir(), ".sap-notes-mcp", "session.json");
const DEFAULT_ATTACHMENT_DIR = join(homedir(), "Downloads", "sap-notes");

/** Expands a leading `~` so SAP_ATTACHMENT_DIR=~/Downloads works as users expect. */
export function expandHomePath(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Strictly parses an integer ENV variable. Number() (not parseInt) so trailing
 * junk like "60000ms" is rejected instead of silently becoming "60".
 */
export function intFromEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, got: ${raw}`);
  }
  return parsed;
}

/**
 * Strictly parses a boolean ENV variable; anything unrecognized is an error rather
 * than a silent "false", so a typo cannot quietly disable the automatic login.
 */
export function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be one of 1/0/true/false/yes/no/on/off, got: ${raw}`);
}

/**
 * Resolves a value from several accepted variable names.
 *
 * Origin beats spelling: a value exported in the real environment wins over one that
 * only came from the .env file, even when the file used the preferred name. Otherwise
 * `SAP_USERNAME=... npm start` would silently keep using the SAPUSER from the file.
 * Within the same origin the order of `names` decides.
 *
 * Empty strings count as "not set" — an empty SAPPASSWORD= line must not start a login attempt.
 */
function stringFromEnv(...names: string[]): string | undefined {
  const fromFile = envKeysFromFile();
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !fromFile.has(name)) return value;
  }
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function assertConfigUrl(
  name: string,
  template: string,
  placeholders: Record<string, string>,
  allowed: (url: string) => boolean,
  hint: string,
): void {
  const resolved =
    Object.keys(placeholders).length > 0 ? buildUrl(template, placeholders) : template;
  if (!allowed(resolved)) {
    throw new Error(`${name} must be an https URL on ${hint}, got: ${template}`);
  }
}

export function loadConfig(): Config {
  const coveoOrg = process.env.SAP_COVEO_ORG ?? "sapamericaproductiontyfzmfz0";
  if (!/^[A-Za-z0-9-]+$/.test(coveoOrg)) {
    throw new Error(`SAP_COVEO_ORG must contain only letters, digits and hyphens, got: ${coveoOrg}`);
  }
  // SAPUSER/SAPPASSWORD are the documented names; the older SAP_* spellings stay valid.
  const username = stringFromEnv("SAPUSER", "SAP_USERNAME");
  const password = stringFromEnv("SAPPASSWORD", "SAP_PASSWORD");
  const searchUrlTemplate =
    process.env.SAP_SEARCH_URL ?? "https://me.sap.com/search?q={query}&tab=notes";
  const coveoTokenUrl =
    process.env.SAP_COVEO_TOKEN_URL ?? "https://me.sap.com/backend/raw/coveo/CoveoToken";
  const coveoSearchUrl =
    process.env.SAP_COVEO_SEARCH_URL ??
    `https://${coveoOrg}.org.coveo.com/rest/search/v2?organizationId=${coveoOrg}`;
  const noteUrlTemplate = process.env.SAP_NOTE_URL ?? "https://me.sap.com/notes/{id}";
  const noteDetailApiUrlTemplate =
    process.env.SAP_NOTE_API_URL ??
    "https://me.sap.com/backend/raw/sapnotes/Detail?q={id}&t=E&isVTEnabled=false";
  const sessionProbeUrl = process.env.SAP_PROBE_URL ?? "https://me.sap.com/notes/2170696";

  const pageHint = "sap.com or sap.cn";
  const apiHint = "sap.com, sap.cn or coveo.com";
  assertConfigUrl("SAP_SEARCH_URL", searchUrlTemplate, { query: "q" }, isAllowedPageUrl, pageHint);
  assertConfigUrl("SAP_COVEO_TOKEN_URL", coveoTokenUrl, {}, isAllowedPageUrl, pageHint);
  assertConfigUrl("SAP_COVEO_SEARCH_URL", coveoSearchUrl, {}, isAllowedApiUrl, apiHint);
  assertConfigUrl("SAP_NOTE_URL", noteUrlTemplate, { id: "1" }, isAllowedPageUrl, pageHint);
  assertConfigUrl("SAP_NOTE_API_URL", noteDetailApiUrlTemplate, { id: "1" }, isAllowedPageUrl, pageHint);
  assertConfigUrl("SAP_PROBE_URL", sessionProbeUrl, {}, isAllowedPageUrl, pageHint);

  return {
    storageStatePath: process.env.SAP_STATE_PATH ?? DEFAULT_STATE_PATH,
    searchUrlTemplate,
    coveoTokenUrl,
    coveoSearchUrl,
    coveoSearchHub: process.env.SAP_COVEO_SEARCH_HUB ?? "SAP for Me",
    noteUrlTemplate,
    noteDetailApiUrlTemplate,
    attachmentDirPath: expandHomePath(process.env.SAP_ATTACHMENT_DIR ?? DEFAULT_ATTACHMENT_DIR),
    sessionProbeUrl,
    navigationTimeoutMs: intFromEnv("SAP_NAV_TIMEOUT_MS", 60_000),
    apiTimeoutMs: intFromEnv("SAP_API_TIMEOUT_MS", 60_000),
    networkIdleTimeoutMs: intFromEnv("SAP_NETWORK_IDLE_TIMEOUT_MS", 4_000),
    renderSettleMs: intFromEnv("SAP_RENDER_SETTLE_MS", 2_500),
    idleTimeoutMs: intFromEnv("SAP_IDLE_TIMEOUT_MS", 10 * 60_000, 0),
    username,
    password,
    // Without both credentials there is nothing to automate, so the flag defaults to
    // "on" only in that case; SAP_AUTO_LOGIN=0 turns it off explicitly.
    autoLoginEnabled: boolFromEnv("SAP_AUTO_LOGIN", true) && username !== undefined && password !== undefined,
    autoLoginCooldownMs: intFromEnv("SAP_AUTO_LOGIN_COOLDOWN_MS", 5 * 60_000, 0),
    loginStepTimeoutMs: intFromEnv("SAP_LOGIN_STEP_TIMEOUT_MS", 30_000),
    loginUserSelector: process.env.SAP_LOGIN_USER_SELECTOR ?? DEFAULT_LOGIN_USER_SELECTOR,
    loginPasswordSelector:
      process.env.SAP_LOGIN_PASSWORD_SELECTOR ?? DEFAULT_LOGIN_PASSWORD_SELECTOR,
    loginSubmitSelector: process.env.SAP_LOGIN_SUBMIT_SELECTOR ?? DEFAULT_LOGIN_SUBMIT_SELECTOR,
    loginMfaSelector: process.env.SAP_LOGIN_MFA_SELECTOR ?? DEFAULT_LOGIN_MFA_SELECTOR,
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
