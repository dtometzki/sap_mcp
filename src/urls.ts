/**
 * Host allowlists for navigation, API calls, login form-filling and downloads.
 *
 * Portal URLs are configurable (SAP reworks frontends), but a rewritten
 * SAP_PROBE_URL / SAP_NOTE_URL must never send the S-user password or session
 * cookies to a foreign host, and must never open file:/http: targets.
 */

/** Browser pages, session probe, token endpoint, note/search URLs. */
export const PAGE_HOST_ROOTS = ["sap.com", "sap.cn"] as const;

/** Direct HTTP APIs: the portal hosts plus Coveo (the note search backend). */
export const API_HOST_ROOTS = ["sap.com", "sap.cn", "coveo.com"] as const;

/** Attachment downloads stay on sap.com — cookies must not follow a rewritten URL. */
export const ATTACHMENT_HOST_ROOTS = ["sap.com"] as const;

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
  return isAllowedPageUrl(url);
}

export function isAllowedApiUrl(url: string): boolean {
  return parseAllowedHttpsUrl(url, API_HOST_ROOTS) !== undefined;
}

export function isAllowedAttachmentHost(url: string): boolean {
  return parseAllowedHttpsUrl(url, ATTACHMENT_HOST_ROOTS) !== undefined;
}

export function assertAllowedPageUrl(url: string, subject = "navigation"): void {
  if (!isAllowedPageUrl(url)) {
    throw new Error(
      `Refusing ${subject} to a host outside https://*.sap.com / https://*.sap.cn: ${url}`,
    );
  }
}

export function assertAllowedApiUrl(url: string, subject = "API request"): void {
  if (!isAllowedApiUrl(url)) {
    throw new Error(
      `Refusing ${subject} to a host outside sap.com / sap.cn / coveo.com: ${url}`,
    );
  }
}

