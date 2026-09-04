import { PublicError } from "./errors.js";

/**
 * Host allowlists for navigation, API calls, login form-filling and downloads.
 *
 * Portal URLs are configurable (SAP reworks frontends), but a rewritten
 * SAP_PROBE_URL / SAP_NOTE_URL must never send the S-user password or session
 * cookies to a foreign host, and must never open file:/http: targets.
 */

/** Browser pages, session probe, token endpoint, note/search URLs. */
export const PAGE_HOST_ROOTS = ["sap.com", "sap.cn"] as const;

/** Exact identity-provider origins; portal/campaign sites must never receive passwords. */
export const LOGIN_ORIGINS = ["https://accounts.sap.com", "https://accounts.sap.cn"] as const;

/** Direct HTTP APIs: the portal hosts plus Coveo (the note search backend). */
export const API_HOST_ROOTS = ["sap.com", "sap.cn", "coveo.com"] as const;

/** Attachment downloads stay on sap.com — cookies must not follow a rewritten URL. */
export const ATTACHMENT_HOST_ROOTS = ["sap.com"] as const;

/**
 * Hosts that may receive the session cookie jar on an attachment download.
 * Other *.sap.com hosts (campaign sites, forgotten subdomains) are still
 * downloadable, but only without cookies — signed URLs keep working.
 */
export const DEFAULT_ATTACHMENT_COOKIE_HOSTS = [
  "me.sap.com",
  "support.sap.com",
  "accounts.sap.com",
] as const;

export function hostMatches(hostname: string, roots: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

/**
 * HTTPS URL on one of `roots`, with no userinfo (https://evil@sap.com phishing).
 * Returns the parsed URL, or undefined when the string is not acceptable.
 */
export function parseAllowedHttpsUrl(url: string, roots: readonly string[]): URL | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    if (!hostMatches(parsed.hostname, roots)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function isAllowedPageUrl(url: string): boolean {
  return parseAllowedHttpsUrl(url, PAGE_HOST_ROOTS) !== undefined;
}

export function isAllowedLoginUrl(url: string): boolean {
  const parsed = parseAllowedHttpsUrl(url, PAGE_HOST_ROOTS);
  return parsed !== undefined && LOGIN_ORIGINS.some((origin) => parsed.origin === origin);
}

export function isAllowedApiUrl(url: string): boolean {
  return parseAllowedHttpsUrl(url, API_HOST_ROOTS) !== undefined;
}

export function isAllowedAttachmentHost(url: string): boolean {
  return parseAllowedHttpsUrl(url, ATTACHMENT_HOST_ROOTS) !== undefined;
}

export function isTrustedAttachmentCookieHost(
  url: string,
  extraHosts: readonly string[] = [],
): boolean {
  const parsed = parseAllowedHttpsUrl(url, ATTACHMENT_HOST_ROOTS);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const trusted = [...DEFAULT_ATTACHMENT_COOKIE_HOSTS, ...extraHosts].map((entry) =>
    entry.toLowerCase(),
  );
  return trusted.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Drops query, hash and userinfo so logs cannot persist access tokens. */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    if (parsed.search) parsed.search = "?[redacted]";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function assertAllowedPageUrl(url: string, subject = "navigation"): void {
  if (!isAllowedPageUrl(url)) {
    throw new PublicError(
      `Refusing ${subject} to a host outside https://*.sap.com / https://*.sap.cn.`,
    );
  }
}

export function assertAllowedApiUrl(url: string, subject = "API request"): void {
  if (!isAllowedApiUrl(url)) {
    throw new PublicError(
      `Refusing ${subject} to a host outside sap.com / sap.cn / coveo.com.`,
    );
  }
}
