import { PublicError } from "./errors.js";
import { rejectApiRedirect } from "./api.js";
import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { buildUrl, type Config } from "./config.js";
import {
  assertAllowedApiUrl,
  isAllowedApiUrl,
  isAllowedAttachmentHost,
  isTrustedAttachmentCookieHost,
} from "./urls.js";
import {
  AccessDeniedError,
  SessionExpiredError,
  assertNotLoggedOut,
  ensurePrivateDirectory,
  looksLikeLoginPage,
  type SapSession,
} from "./session.js";
import { coerceField, errorMessage, withRetry, wrapUntrustedPortalContent } from "./notes.js";

export interface NoteAttachment {
  fileName: string;
  url: string;
  sizeBytes?: number;
}

export interface AttachmentDownload {
  attachment: NoteAttachment;
  filePath: string;
  bytes: number;
  contentType: string;
  /** UTF-8 content, only set for text-like attachments (capped at INLINE_TEXT_LIMIT chars). */
  text?: string;
  textTruncated?: boolean;
}

/** Client-facing result; the original portal file name stays inside a fixed untrusted block. */
export function formatAttachmentDownload(download: AttachmentDownload): string {
  const type = download.contentType ? `, ${download.contentType}` : "";
  const header = `Saved: ${download.filePath} (${download.bytes} bytes${type})`;
  const truncated = download.textTruncated
    ? `\n\n[Output truncated — the complete file is on disk at ${download.filePath}]`
    : "";
  const text = download.text === undefined ? "" : `\n\n${download.text}${truncated}`;
  const body = `${header}\nFile name: ${download.attachment.fileName}${text}`;
  return wrapUntrustedPortalContent("attachment download", body);
}

/** Cap for inline text returned to the MCP client; the full file is always on disk. */
export const INLINE_TEXT_LIMIT = 50_000;

/**
 * Hard limit for downloaded bytes. Content-Length is checked before reading, and the
 * streaming loop enforces the same limit for chunked or incorrectly declared responses.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_REDIRECTS = 5;

export { ensurePrivateDirectory, isAllowedAttachmentHost };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Fetches an attachment without automatic redirects.
 *
 * Every hop is validated before the request is sent. Cookies are selected separately
 * for each URL using the browser context's normal scope rules.
 */
export async function fetchAllowedAttachment(
  initialUrl: string,
  cookieHeader: (url: string) => Promise<string>,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (!isAllowedAttachmentHost(currentUrl)) {
      throw new PublicError("Refusing to download from non-SAP host.");
    }

    const cookie = await cookieHeader(currentUrl);
    const headers: Record<string, string> = { accept: "*/*" };
    if (cookie) headers.cookie = cookie;
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!isAllowedAttachmentHost(response.url || currentUrl)) {
        await response.body?.cancel().catch(() => undefined);
        throw new PublicError("Refusing response from non-SAP host.");
      }
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    if (redirectCount >= MAX_ATTACHMENT_REDIRECTS) {
      throw new PublicError(`Attachment download exceeded ${MAX_ATTACHMENT_REDIRECTS} redirects.`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new PublicError(`Attachment redirect HTTP ${response.status} has no Location header.`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

/**
 * Abort signal that fires after `timeoutMs` WITHOUT PROGRESS, not after a fixed total
 * budget. A total budget (AbortSignal.timeout) cuts off a 100 MB attachment on a slow
 * link although data keeps flowing; a stalled connection is still detected because
 * nothing calls touch() while it hangs.
 */
export interface DownloadWatchdog {
  signal: AbortSignal;
  /** Re-arms the timer; call whenever a chunk arrives. */
  touch(): void;
  /** Stops the timer once the download has finished or failed. */
  clear(): void;
}

export function inactivityWatchdog(timeoutMs: number): DownloadWatchdog {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    // Deliberately not unref'd: a stalled read has nothing else keeping the loop alive,
    // and the timer is the only thing that can turn the stall into an error.
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Writes the complete chunk even when the operating system accepts only part of it. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new PublicError("Attachment write made no progress.");
    offset += bytesWritten;
  }
}

/** Rejects when the signal aborts; never rejects unobserved (the catch marks it handled). */
function abortPromise(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new PublicError("Download aborted", { cause: signal.reason }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

/**
 * Streams a response to a temporary file and atomically installs it on success.
 * With a watchdog, every chunk re-arms its inactivity timer and a stalled read is
 * abandoned when it fires (fetch bodies reject on abort by themselves; the race also
 * covers streams that are not tied to the signal).
 */
export async function writeResponseWithLimit(
  response: Response,
  filePath: string,
  maxBytes: number,
  watchdog?: DownloadWatchdog,
): Promise<number> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicError(`Attachment is ${declaredLength} bytes — exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) throw new PublicError("Attachment response has no body.");

  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  const reader = response.body.getReader();
  const aborted = watchdog ? abortPromise(watchdog.signal) : undefined;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = aborted
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (done) break;
      watchdog?.touch();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublicError(`Attachment exceeds the ${maxBytes}-byte limit.`);
      }
      await writeAll(handle, value);
    }
    await handle.close();
    await rename(temporary, filePath);
    // rename() keeps the target's previous mode when it already existed.
    await chmod(filePath, 0o600);
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readInlineText(filePath: string, totalBytes: number): Promise<{
  text: string;
  truncated: boolean;
}> {
  // Four bytes per Unicode code point is enough to preserve INLINE_TEXT_LIMIT UTF-8 chars.
  const buffer = Buffer.alloc(INLINE_TEXT_LIMIT * 4 + 4);
  const handle = await open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const decoded = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      text: decoded.slice(0, INLINE_TEXT_LIMIT),
      truncated: totalBytes > bytesRead || decoded.length > INLINE_TEXT_LIMIT,
    };
  } finally {
    await handle.close();
  }
}

/** Keeps the original name recognizable while preventing path traversal and control chars. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 200) || "attachment";
}

const TEXT_EXTENSION_PATTERN =
  /\.(txt|sql|csv|tsv|log|md|json|xml|abap|cfg|conf|ini|properties|sh|py|ya?ml)$/i;
const INLINE_BLOCKED = /html|javascript|ecmascript/i;

/** Whether the content is worth returning inline instead of only saving to disk. */
export function isTextAttachment(fileName: string, contentType: string): boolean {
  if (INLINE_BLOCKED.test(contentType) || /\.(html?|js)$/i.test(fileName)) return false;
  if (/^text\//i.test(contentType)) return true;
  if (/json|xml|csv/i.test(contentType)) return true;
  return TEXT_EXTENSION_PATTERN.test(fileName);
}

/** Something that plausibly names a file, as opposed to a note title or link text. */
const FILE_NAME_PATTERN = /\.[a-z0-9]{1,10}$/i;

const FILE_NAME_KEYS = ["FileName", "Filename", "fileName", "filename", "Name", "name"];
const URL_KEYS = ["URL", "Url", "url", "Uri", "uri", "DownloadUrl", "downloadUrl"];
const SIZE_KEYS = ["FileSize", "Size", "fileSize", "size", "SizeInBytes"];

/** The portal wraps most scalars as { value: ... }; unwrap one level, then coerce. */
function readField(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (!(key in source)) continue;
    let raw = source[key];
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
      raw = raw.value;
    }
    const value = coerceField(raw);
    if (value) return value;
  }
  return "";
}

const MAX_SCAN_DEPTH = 16;

/**
 * Pulls attachment entries out of the note-detail JSON without depending on the exact
 * envelope (the portal has wrapped the payload differently across frontend releases).
 * Preferred shape is any subtree under an "Attachments" key; if none matches, the whole
 * payload is scanned for objects that carry both a plausible file name and a URL.
 */
export function extractAttachments(payload: unknown, baseUrl: string): NoteAttachment[] {
  const fromAttachmentSubtrees = new Map<string, NoteAttachment>();
  const fromAnywhere = new Map<string, NoteAttachment>();

  const tryCollect = (node: Record<string, unknown>, into: Map<string, NoteAttachment>): void => {
    const fileName = readField(node, FILE_NAME_KEYS);
    const href = readField(node, URL_KEYS);
    if (!fileName || !href || !FILE_NAME_PATTERN.test(fileName)) return;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (!isAllowedAttachmentHost(url)) return;
    if (into.has(url)) return;
    const attachment: NoteAttachment = { fileName, url };
    const size = Number.parseInt(readField(node, SIZE_KEYS), 10);
    if (Number.isFinite(size) && size > 0) attachment.sizeBytes = size;
    into.set(url, attachment);
  };

  const visit = (node: unknown, depth: number, inAttachments: boolean): void => {
    if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1, inAttachments);
      return;
    }
    const record = node as Record<string, unknown>;
    tryCollect(record, inAttachments ? fromAttachmentSubtrees : fromAnywhere);
    for (const [key, child] of Object.entries(record)) {
      visit(child, depth + 1, inAttachments || /^attachments$/i.test(key));
    }
  };

  visit(payload, 0, false);
  return fromAttachmentSubtrees.size > 0
    ? [...fromAttachmentSubtrees.values()]
    : [...fromAnywhere.values()];
}

async function fetchAttachmentsViaApi(
  session: SapSession,
  config: Config,
  id: string,
): Promise<NoteAttachment[]> {
  const url = buildUrl(config.noteDetailApiUrlTemplate, { id });
  return withRetry(async () => {
    assertAllowedApiUrl(url, "Note detail request");
    const response = await session
      .request()
      .get(url, {
        headers: { accept: "application/json" },
        timeout: config.apiTimeoutMs,
        maxRedirects: 0,
      });
    try {
      rejectApiRedirect(response);
      if (response.url() && !isAllowedApiUrl(response.url())) {
        throw new PublicError("Refusing note detail response from non-SAP host.");
      }
      assertNotLoggedOut(response.status(), response.url(), `Note ${id}`, response.ok());
      if (!response.ok()) {
        throw new PublicError(`Note detail request failed: HTTP ${response.status()}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // HTML where JSON was expected: the portal served the login page with HTTP 200.
        const contentType = response.headers()["content-type"] ?? "";
        if (/text\/html/i.test(contentType) || looksLikeLoginPage(response.url())) {
          throw new SessionExpiredError();
        }
        throw new PublicError("Note detail endpoint returned invalid JSON.");
      }
      return extractAttachments(payload, url);
    } finally {
      await response.dispose().catch(() => undefined);
    }
  });
}

/** Hrefs that plausibly point at a note attachment or document download. */
const ATTACHMENT_HREF_PATTERN = /attachment|\/documents\//i;

/**
 * Last path segment of a URL as a readable file name.
 *
 * decodeURIComponent throws URIError on a lone or malformed percent escape — and a
 * literal "%" in an attachment name (100%_report.csv) is not exotic. An exception here
 * used to abort the whole listing, losing every other attachment of the note, so a
 * name that cannot be decoded falls back to its raw form. The query string is removed
 * before decoding, not after, so a "%" in the query cannot trip it either.
 */
export function fileNameFromHref(href: string): string {
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return "";
  }
  const last = pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Legacy fallback: scrape attachment-looking links from the rendered note page. */
async function fetchAttachmentsViaDom(
  session: SapSession,
  config: Config,
  id: string,
): Promise<NoteAttachment[]> {
  return session.withOpenPage(buildUrl(config.noteUrlTemplate, { id }), async (page) => {
    const anchors = await page.$$eval("a[href]", (elements) =>
      elements.map((element) => ({
        href: (element as HTMLAnchorElement).href,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    );
    const found = new Map<string, NoteAttachment>();
    for (const anchor of anchors) {
      if (!ATTACHMENT_HREF_PATTERN.test(anchor.href)) continue;
      if (!isAllowedAttachmentHost(anchor.href)) continue;
      const fromHref = fileNameFromHref(anchor.href);
      const fileName = FILE_NAME_PATTERN.test(anchor.text) ? anchor.text : fromHref;
      if (!FILE_NAME_PATTERN.test(fileName) || found.has(anchor.href)) continue;
      found.set(anchor.href, { fileName, url: anchor.href });
    }
    return [...found.values()];
  });
}

/**
 * Primary path is the note-detail JSON API (fast, no page render); the DOM scrape of
 * the note page is kept as a safety net for the portal's next frontend rewrite —
 * the same two-tier strategy the search uses (Coveo first, DOM second).
 */
export async function fetchAttachmentList(
  session: SapSession,
  config: Config,
  id: string,
): Promise<NoteAttachment[]> {
  try {
    return (await fetchAttachmentsViaApi(session, config, id)).filter((attachment) =>
      isAllowedAttachmentHost(attachment.url),
    );
  } catch (error) {
    // Both are definite answers from a working portal; the DOM scrape only exists for
    // the case that the API moved, and would just repeat the same denial.
    if (error instanceof SessionExpiredError || error instanceof AccessDeniedError) throw error;
    console.error(`Note detail API failed, falling back to DOM scrape: ${errorMessage(error)}`);
    let attachments: NoteAttachment[];
    try {
      attachments = await fetchAttachmentsViaDom(session, config, id);
    } catch (fallbackError) {
      if (fallbackError instanceof SessionExpiredError || fallbackError instanceof AccessDeniedError) {
        throw fallbackError;
      }
      throw new PublicError(
        `Attachment list for note ${id} failed: ${errorMessage(error)} ` +
          `(DOM fallback: ${errorMessage(fallbackError)})`,
        { cause: error },
      );
    }
    // Same reasoning as searchNotes: an empty scrape after a failed API call is a broken
    // backend, not a note without attachments — do not report it as "no attachments".
    if (attachments.length === 0) {
      throw new PublicError(
        `Attachment list for note ${id} failed: ${errorMessage(error)} ` +
          `(the DOM fallback found nothing either)`,
        { cause: error },
      );
    }
    return attachments.filter((attachment) => isAllowedAttachmentHost(attachment.url));
  }
}

/** Client-facing list: names and sizes only — download URLs stay inside the process. */
export function formatAttachmentList(number: string, attachments: NoteAttachment[]): string {
  if (attachments.length === 0) {
    return (
      `Note ${number} lists no attachments. If the note shows "A new version is in ` +
      `preparation", the portal hides attachments until the new version is released ` +
      `(see KBA 3453681).`
    );
  }
  const lines = attachments.map((attachment) => {
    const size = attachment.sizeBytes !== undefined ? ` (${attachment.sizeBytes} bytes)` : "";
    return `${attachment.fileName}${size}`;
  });
  return `Note ${number} has ${attachments.length} attachment(s):\n\n${lines.join("\n\n")}`;
}

function describeAvailable(attachments: NoteAttachment[]): string {
  return wrapUntrustedPortalContent(
    "attachment names",
    attachments.map((attachment) => attachment.fileName).join("\n"),
  );
}

/** Case-insensitive exact match first, then unique substring match. */
export function selectAttachment(
  attachments: NoteAttachment[],
  id: string,
  fileName: string | undefined,
): NoteAttachment {
  if (attachments.length === 0) {
    throw new PublicError(
      `Note ${id} lists no attachments. If the note shows "A new version is in preparation", ` +
        `the portal hides attachments until the new version is released (see KBA 3453681).`,
    );
  }
  const wanted = fileName?.trim().toLowerCase();
  if (!wanted) {
    const single = attachments[0];
    if (attachments.length === 1 && single) return single;
    throw new PublicError(
      `Note ${id} has ${attachments.length} attachments; pass fileName to pick one. ` +
        `Available: ${describeAvailable(attachments)}`,
    );
  }
  const exact = attachments.find((attachment) => attachment.fileName.toLowerCase() === wanted);
  if (exact) return exact;
  const partial = attachments.filter((attachment) =>
    attachment.fileName.toLowerCase().includes(wanted),
  );
  if (partial.length === 1 && partial[0]) return partial[0];
  throw new PublicError(
    partial.length === 0
      ? `Note ${id} has no attachment matching "${fileName}". Available: ${describeAvailable(attachments)}`
      : `"${fileName}" matches ${partial.length} attachments of note ${id}; be more specific. ` +
          `Available: ${describeAvailable(partial)}`,
  );
}

export async function downloadAttachment(
  session: SapSession,
  config: Config,
  id: string,
  fileName: string | undefined,
): Promise<AttachmentDownload> {
  const attachments = await fetchAttachmentList(session, config, id);
  const attachment = selectAttachment(attachments, id, fileName);
  if (!isAllowedAttachmentHost(attachment.url)) {
    throw new PublicError("Refusing to download from non-SAP host.");
  }

  return withRetry(async () => {
    // apiTimeoutMs bounds the time between two chunks, not the whole transfer.
    const watchdog = inactivityWatchdog(config.apiTimeoutMs);
    try {
      return await transferAttachment(session, config, id, attachment, watchdog);
    } catch (error) {
      if (watchdog.signal.aborted) {
        // "ETIMEDOUT" keeps the error transient for withRetry.
        throw new PublicError(
          `Attachment download ETIMEDOUT: no data received for ${config.apiTimeoutMs} ms.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      watchdog.clear();
    }
  });
}

/** Browser downloads stay in memory; the MCP's disk-based download remains unchanged. */
export interface AttachmentBytes { fileName: string; data: Buffer }

export async function readAttachmentBytes(response: Response, signal: AbortSignal, touch: () => void, maxBytes = MAX_DOWNLOAD_BYTES): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new PublicError("Attachment response has no body.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get("content-length")) > maxBytes) throw new PublicError("Attachment exceeds download size limit.");
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      touch(); bytes += value.byteLength;
      if (bytes > maxBytes) throw new PublicError("Attachment exceeds download size limit.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function downloadAttachmentBytes(session: SapSession, config: Config, id: string, fileName: string, signal: AbortSignal): Promise<AttachmentBytes> {
  const attachments = await fetchAttachmentList(session, config, id);
  signal.throwIfAborted();
  // Only exact names from this note are accepted; clients cannot supply download URLs.
  const attachment = attachments.find(item => item.fileName === fileName);
  if (!attachment) throw new PublicError("Attachment is no longer available. Refresh the attachment list.");
  return withRetry(async () => {
    signal.throwIfAborted();
    const watchdog = inactivityWatchdog(config.apiTimeoutMs);
    const combined = AbortSignal.any([signal, watchdog.signal]);
    let response: Response | undefined;
    try {
      response = await fetchAllowedAttachment(attachment.url, url =>
        isTrustedAttachmentCookieHost(url, config.attachmentCookieHosts) ? session.cookieHeader(url) : Promise.resolve(""), combined);
      watchdog.touch();
      assertUsableAttachmentResponse(response.status, response.url, response.ok, response.headers.get("content-type") ?? "", attachment.fileName);
      const data = await readAttachmentBytes(response, combined, () => watchdog.touch());
      return { fileName: sanitizeFileName(attachment.fileName), data };
    } catch (error) {
      signal.throwIfAborted();
      if (watchdog.signal.aborted) throw new PublicError("Attachment download ETIMEDOUT", { cause: error });
      throw error;
    } finally {
      watchdog.clear();
      await response?.body?.cancel().catch(() => undefined);
    }
  });
}

async function transferAttachment(
  session: SapSession,
  config: Config,
  id: string,
  attachment: NoteAttachment,
  watchdog: DownloadWatchdog,
): Promise<AttachmentDownload> {
  const response = await fetchAllowedAttachment(
    attachment.url,
    (url) =>
      isTrustedAttachmentCookieHost(url, config.attachmentCookieHosts)
        ? session.cookieHeader(url)
        : Promise.resolve(""),
    watchdog.signal,
  );
  watchdog.touch();

  try {
    const contentType = response.headers.get("content-type") ?? "";
    assertUsableAttachmentResponse(
      response.status,
      response.url,
      response.ok,
      contentType,
      attachment.fileName,
    );

    const directory = join(config.attachmentDirPath, id);
    await ensurePrivateDirectory(directory);
    const filePath = join(directory, sanitizeFileName(attachment.fileName));
    const bytes = await writeResponseWithLimit(response, filePath, MAX_DOWNLOAD_BYTES, watchdog);

    const result: AttachmentDownload = {
      attachment,
      filePath,
      bytes,
      contentType,
    };
    if (isTextAttachment(attachment.fileName, contentType)) {
      const inline = await readInlineText(filePath, bytes);
      result.text = inline.text;
      result.textTruncated = inline.truncated;
    }
    return result;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** Rejects login/error pages before they can be persisted as an attachment. */
export function assertUsableAttachmentResponse(
  status: number,
  url: string,
  ok: boolean,
  contentType: string,
  fileName: string,
): void {
  const isHtml = /text\/html/i.test(contentType);
  if (isHtml && looksLikeLoginPage(url)) throw new SessionExpiredError();
  assertNotLoggedOut(status, url, "Attachment download", ok);
  if (!ok) throw new PublicError(`Attachment download failed: HTTP ${status}`);
  if (isHtml && !/\.html?$/i.test(fileName)) {
    throw new PublicError(
      "Portal returned an HTML page instead of the requested attachment — the session may " +
        "lack permission for this download, or the attachment URL scheme changed.",
    );
  }
}
