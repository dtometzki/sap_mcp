import type { APIResponse } from "playwright";
import { PublicError } from "./errors.js";
import { SessionExpiredError } from "./session.js";
import { isAllowedLoginUrl } from "./urls.js";

/**
 * Callers MUST request with maxRedirects: 0. Direct API endpoints should not
 * redirect; accepting the response only after following it is too late to block
 * access to a foreign host or an internal service. Never expose Location values.
 */
export function rejectApiRedirect(response: APIResponse): void {
  if (response.status() < 300 || response.status() >= 400) return;
  const location = response.headers().location;
  if (location) {
    let destination: URL | undefined;
    try {
      destination = new URL(location, response.url());
    } catch {
      // A malformed Location is refused just like every other redirect.
    }
    if (destination && isAllowedLoginUrl(destination.href)) throw new SessionExpiredError();
  }
  throw new PublicError(
    `API redirect refused (HTTP ${response.status()}). Check the configured API endpoint.`,
  );
}
