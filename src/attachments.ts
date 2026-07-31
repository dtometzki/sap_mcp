import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildUrl, type Config } from "./config.js";
import {
  AccessDeniedError,
  SessionExpiredError,
  assertNotLoggedOut,
  looksLikeLoginPage,
  type SapSession,
} from "./session.js";
import { coerceField, withRetry } from "./notes.js";

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

/** Cap for inline text returned to the MCP client; the full file is always on disk. */
export const INLINE_TEXT_LIMIT = 200_000;

/**
 * Reject downloads whose Content-Length exceeds this, so a multi-hundred-MB trace
 * file cannot exhaust the process's RAM (response.body() buffers everything).
 * The check is best-effort: servers may omit Content-Length (chunked encoding).
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Attachments may only be fetched from SAP-owned hosts. The download URL comes from
 * portal data we do not control, so this guards against a manipulated or rewritten
 * URL exfiltrating the session cookies to a foreign host.
 */
export function isAllowedAttachmentHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    const host = hostname.toLowerCase();
    return host === "sap.com" || host.endsWith(".sap.com");
  } catch {
    return false;
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
  /\.(txt|sql|csv|tsv|log|md|json|xml|html?|abap|cfg|conf|ini|properties|sh|py|ya?ml)$/i;

/** Whether the content is worth returning inline instead of only saving to disk. */
export function isTextAttachment(fileName: string, contentType: string): boolean {
  if (/^text\//i.test(contentType)) return true;
  if (/json|xml|csv|javascript/i.test(contentType)) return true;
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
    const response = await session
      .request()
      .get(url, { headers: { accept: "application/json" }, timeout: config.apiTimeoutMs });
    try {
      assertNotLoggedOut(response.status(), response.url(), `Note ${id}`, response.ok());
      if (!response.ok()) {
        throw new Error(`Note detail request failed: HTTP ${response.status()}`);
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
        throw new Error("Note detail endpoint returned invalid JSON.");
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
    return await fetchAttachmentsViaApi(session, config, id);
  } catch (error) {
    // Both are definite answers from a working portal; the DOM scrape only exists for
    // the case that the API moved, and would just repeat the same denial.
    if (error instanceof SessionExpiredError || error instanceof AccessDeniedError) throw error;
    console.error(
      `Note detail API failed, falling back to DOM scrape: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fetchAttachmentsViaDom(session, config, id);
  }
}

function describeAvailable(attachments: NoteAttachment[]): string {
  return attachments.map((attachment) => attachment.fileName).join(", ");
}

/** Case-insensitive exact match first, then unique substring match. */
export function selectAttachment(
  attachments: NoteAttachment[],
  id: string,
  fileName: string | undefined,
): NoteAttachment {
  if (attachments.length === 0) {
    throw new Error(
      `Note ${id} lists no attachments. If the note shows "A new version is in preparation", ` +
        `the portal hides attachments until the new version is released (see KBA 3453681).`,
    );
  }
  const wanted = fileName?.trim().toLowerCase();
  if (!wanted) {
    const single = attachments[0];
    if (attachments.length === 1 && single) return single;
    throw new Error(
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
  throw new Error(
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
    throw new Error(`Refusing to download from non-SAP host: ${attachment.url}`);
  }

  return withRetry(async () => {
    const response = await session
      .request()
      .get(attachment.url, { timeout: config.apiTimeoutMs });
    try {
      assertNotLoggedOut(
        response.status(),
        response.url(),
        `"${attachment.fileName}"`,
        response.ok(),
      );
      if (!response.ok()) {
        throw new Error(`Attachment download failed: HTTP ${response.status()}`);
      }
      const contentLength = Number(response.headers()["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `"${attachment.fileName}" is ${contentLength} bytes — exceeds the ${MAX_DOWNLOAD_BYTES}-byte ` +
            "inline limit. Download it directly from the URL listed by sap_note_attachments.",
        );
      }
      const body = await response.body();
      const contentType = response.headers()["content-type"] ?? "";

      // A login or error page served instead of the file must not end up on disk.
      if (/text\/html/i.test(contentType) && !/\.html?$/i.test(attachment.fileName)) {
        throw new Error(
          `Portal returned an HTML page instead of "${attachment.fileName}" — the session ` +
            `may lack permission for this download, or the attachment URL scheme changed.`,
        );
      }

      const directory = join(config.attachmentDirPath, id);
      await mkdir(directory, { recursive: true });
      const filePath = join(directory, sanitizeFileName(attachment.fileName));
      await writeFile(filePath, body);

      const result: AttachmentDownload = {
        attachment,
        filePath,
        bytes: body.length,
        contentType,
      };
      if (isTextAttachment(attachment.fileName, contentType)) {
        const text = body.toString("utf8");
        result.text = text.slice(0, INLINE_TEXT_LIMIT);
        result.textTruncated = text.length > INLINE_TEXT_LIMIT;
      }
      return result;
    } finally {
      await response.dispose().catch(() => undefined);
    }
  });
}
