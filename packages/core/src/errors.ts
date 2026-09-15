/** Only application-authored messages may cross the log/MCP trust boundary. */
export class PublicError extends Error {}

/**
 * Playwright errors contain request headers, URLs and even fill() values. Never
 * print their message, stack or cause. Keep only a fixed diagnostic category.
 * PublicError messages must not contain raw third-party errors or login banners.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof PublicError) return error.message;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /\bETIMEDOUT\b/.test(error.message)) {
      return "Request timed out. Check connectivity and the configured timeouts.";
    }
    if (/net::ERR_|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|fetch failed|socket hang up/i.test(error.message)) {
      return "Network request failed. Check connectivity and proxy settings.";
    }
  }
  return "Operation failed. Internal error details were withheld to protect credentials.";
}
