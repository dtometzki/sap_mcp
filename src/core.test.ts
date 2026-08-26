import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildUrl } from "./config.js";
import {
  coerceField,
  extractNoteId,
  isTransientError,
  mapCoveoResult,
  parseCoveoResponse,
} from "./notes.js";
import {
  AccessDeniedError,
  SessionExpiredError,
  assertNotLoggedOut,
  looksLikeLoginPage,
} from "./session.js";
import {
  ensurePrivateDirectory,
  extractAttachments,
  fetchAllowedAttachment,
  fileNameFromHref,
  formatAttachmentList,
  isAllowedAttachmentHost,
  isTextAttachment,
  sanitizeFileName,
  selectAttachment,
  writeResponseWithLimit,
} from "./attachments.js";

test("buildUrl encodes values and replaces repeated placeholders", () => {
  assert.equal(
    buildUrl("https://example.test/{query}?again={query}", { query: "HANA error 447" }),
    "https://example.test/HANA%20error%20447?again=HANA%20error%20447",
  );
  assert.throws(
    () => buildUrl("https://example.test/{missing}", {}),
    /placeholder \{missing\} has no value/,
  );
});

test("extractNoteId supports current and legacy SAP routes", () => {
  assert.equal(extractNoteId("https://me.sap.com/notes/1234567"), "1234567");
  assert.equal(extractNoteId("https://support.sap.com/knowledge/en/7654321"), "7654321");
  assert.equal(extractNoteId("https://example.test/?note_number=246810"), "246810");
  assert.equal(extractNoteId("https://me.sap.com/products"), undefined);
});

test("parseCoveoResponse accepts expected API fields", () => {
  const response = parseCoveoResponse({
    totalCount: 1,
    duration: 12,
    results: [
      {
        title: "1234567 - Example",
        clickUri: "https://launchpad.support.sap.com/#/notes/1234567",
        raw: { mh_id: "1234567", source: ["SAP-Note"] },
        score: 0.98,
      },
    ],
  });

  assert.equal(response.totalCount, 1);
  assert.equal(response.results[0]?.raw?.mh_id, "1234567");
});

test("parseCoveoResponse rejects silent schema changes", () => {
  assert.throws(() => parseCoveoResponse({ totalCount: 0 }), /Unexpected Coveo response schema/);
  assert.throws(
    () => parseCoveoResponse({ results: [{ raw: "not-an-object" }] }),
    /Unexpected Coveo response schema/,
  );
});

test("looksLikeLoginPage recognizes common identity-provider URLs", () => {
  assert.equal(looksLikeLoginPage("https://accounts.sap.com/saml2/idp/sso"), true);
  assert.equal(looksLikeLoginPage("https://me.sap.com/notes/2170696"), false);
  // Identity-provider paths on the portal host itself still count.
  assert.equal(looksLikeLoginPage("https://me.sap.com/oauth2/authorize"), true);
  assert.equal(looksLikeLoginPage("https://eu.accounts.sap.com/some/path"), true);
  assert.equal(looksLikeLoginPage("not a url"), false);
});

test("looksLikeLoginPage does not fire on SAP vocabulary in the query string", () => {
  // "logon" / "signin" are everyday SAP terms: a search for them must not be mistaken
  // for a logout, which used to tear down a valid session.
  assert.equal(
    looksLikeLoginPage(buildUrl("https://me.sap.com/search?q={query}&tab=notes", {
      query: "SAP Logon problem",
    })),
    false,
  );
  assert.equal(
    looksLikeLoginPage("https://me.sap.com/search?q=single%20signin%20error&tab=notes"),
    false,
  );
  // Same for attachment URLs that merely contain the word.
  assert.equal(
    looksLikeLoginPage("https://me.sap.com/backend/raw/sapnotes/attachment/1/saplogon.ini"),
    false,
  );
});

test("assertNotLoggedOut maps statuses to the right error types", () => {
  // 401: session is gone.
  assert.throws(
    () => assertNotLoggedOut(401, "https://me.sap.com/x", "Note 123", false),
    SessionExpiredError,
  );
  // 403: authenticated but not authorized — must NOT be SessionExpiredError.
  assert.throws(
    () => assertNotLoggedOut(403, "https://me.sap.com/x", "Note 123", false),
    AccessDeniedError,
  );
  // Failed response that landed on the identity provider: session expired.
  assert.throws(
    () =>
      assertNotLoggedOut(200, "https://accounts.sap.com/saml2/idp/sso", "Note 123", false),
    SessionExpiredError,
  );
  // Successful response: never treated as a logout, even on an IdP-looking URL.
  assert.doesNotThrow(() =>
    assertNotLoggedOut(200, "https://accounts.sap.com/saml2/idp/sso", "Note 123", true),
  );
  // Non-ok but not a login page: caller handles the generic HTTP error.
  assert.doesNotThrow(() =>
    assertNotLoggedOut(500, "https://me.sap.com/backend/raw/x", "Note 123", false),
  );
});

test("fileNameFromHref survives malformed percent escapes", () => {
  assert.equal(
    fileNameFromHref("https://me.sap.com/documents/ECS%20param%20fetch.txt"),
    "ECS param fetch.txt",
  );
  // A literal "%" would make decodeURIComponent throw and used to kill the whole listing.
  assert.equal(fileNameFromHref("https://me.sap.com/documents/100%_report.csv"), "100%_report.csv");
  // The query string is stripped before decoding, not after.
  assert.equal(fileNameFromHref("https://me.sap.com/dl/trace.log?token=100%25"), "trace.log");
  assert.equal(fileNameFromHref("not a url"), "");
});

const NOTE_URL_TEMPLATE = "https://me.sap.com/notes/{id}";

test("mapCoveoResult maps a Note result and cleans the title", () => {
  const hit = mapCoveoResult(
    {
      title: "1234567 - Example note title - SAP for Me",
      clickUri: "https://launchpad.support.sap.com/#/notes/1234567",
      raw: { mh_id: "1234567", source: ["SAP-Note"] },
    },
    NOTE_URL_TEMPLATE,
  );
  assert.deepEqual(hit, {
    id: "1234567",
    title: "Example note title",
    url: "https://me.sap.com/notes/1234567",
  });
});

test("mapCoveoResult accepts KBA sources and sapnotes clickUris", () => {
  assert.equal(
    mapCoveoResult(
      { title: "A KBA", raw: { mh_id: "7654321", source: "Knowledge-Base-Article" } },
      NOTE_URL_TEMPLATE,
    )?.id,
    "7654321",
  );
  assert.equal(
    mapCoveoResult(
      {
        title: "Via clickUri",
        clickUri: "https://me.sap.com/sapnotes/246810",
        raw: { mh_id: "246810", source: "Something-Else" },
      },
      NOTE_URL_TEMPLATE,
    )?.id,
    "246810",
  );
});

test("mapCoveoResult filters non-note results and missing ids", () => {
  // Blog post: has an id but the wrong source and no notes clickUri.
  assert.equal(
    mapCoveoResult(
      { title: "A blog post", raw: { mh_id: "1234567", source: "SAP-Blog" } },
      NOTE_URL_TEMPLATE,
    ),
    undefined,
  );
  // Documentation: no numeric note id at all.
  assert.equal(
    mapCoveoResult({ title: "Docs", raw: { source: "SAP-Note" } }, NOTE_URL_TEMPLATE),
    undefined,
  );
});

test("mapCoveoResult falls back to a generated title", () => {
  const hit = mapCoveoResult(
    { title: "", raw: { mh_id: "1234567", source: "SAP-Note" } },
    NOTE_URL_TEMPLATE,
  );
  assert.equal(hit?.title, "SAP Note 1234567");
});

test("coerceField normalizes scalars, arrays, and edge cases", () => {
  assert.equal(coerceField("hello"), "hello");
  assert.equal(coerceField(42), "42");
  assert.equal(coerceField(true), "true");
  assert.equal(coerceField(["single"]), "single");
  assert.equal(coerceField([123]), "123");
  assert.equal(coerceField([]), "");
  assert.equal(coerceField(null), "");
  assert.equal(coerceField(undefined), "");
  assert.equal(coerceField({ nested: true }), "");
});

test("isTransientError retries 5xx and network errors, not 4xx or logic errors", () => {
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 502")), true);
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 503")), true);
  assert.equal(isTransientError(new Error("net::ERR_CONNECTION_RESET")), true);
  assert.equal(isTransientError(new Error("fetch failed")), true);
  assert.equal(isTransientError(new Error("Coveo token request failed: HTTP 401")), false);
  assert.equal(isTransientError(new Error("Coveo search failed: HTTP 400")), false);
  assert.equal(isTransientError(new Error("Note 1234 returned no readable content")), false);
  assert.equal(isTransientError("not an error"), false);
});

const DETAIL_API_BASE = "https://me.sap.com/backend/raw/sapnotes/Detail?q=3696257";

test("extractAttachments reads the Attachments.Items shape with {value} wrappers", () => {
  const attachments = extractAttachments(
    {
      Response: {
        SAPNote: {
          Title: { value: "3696257 - ECS Database pre-migration checks" },
          Attachments: {
            Items: [
              {
                Filename: { value: "ECS-PreMigration-param-fetch-Systemdb.txt" },
                URL: { value: "/backend/raw/sapnotes/attachment/0003696257/abc123" },
                FileSize: { value: "2048" },
              },
              {
                Filename: { value: "ECS-PreMigration-param-fetch-Tenantdb.txt" },
                URL: { value: "https://me.sap.com/backend/raw/sapnotes/attachment/def456" },
              },
            ],
          },
        },
      },
    },
    DETAIL_API_BASE,
  );

  assert.deepEqual(attachments, [
    {
      fileName: "ECS-PreMigration-param-fetch-Systemdb.txt",
      url: "https://me.sap.com/backend/raw/sapnotes/attachment/0003696257/abc123",
      sizeBytes: 2048,
    },
    {
      fileName: "ECS-PreMigration-param-fetch-Tenantdb.txt",
      url: "https://me.sap.com/backend/raw/sapnotes/attachment/def456",
    },
  ]);
});

test("extractAttachments falls back to a whole-payload scan and skips non-files", () => {
  const attachments = extractAttachments(
    {
      files: [
        { fileName: "collection.sql", downloadUrl: "https://me.sap.com/dl/1" },
        // A reference entry: name without file extension must not be picked up.
        { name: "Related note about parameters", url: "https://me.sap.com/notes/3204909" },
      ],
    },
    DETAIL_API_BASE,
  );
  assert.deepEqual(attachments, [
    { fileName: "collection.sql", url: "https://me.sap.com/dl/1" },
  ]);
});

test("extractAttachments prefers Attachments subtrees over incidental matches", () => {
  const attachments = extractAttachments(
    {
      SideBar: { Name: "logo.png", Url: "https://me.sap.com/img/logo.png" },
      Attachments: {
        Items: [{ Filename: "real.txt", URL: "https://me.sap.com/dl/real" }],
      },
    },
    DETAIL_API_BASE,
  );
  assert.deepEqual(attachments, [{ fileName: "real.txt", url: "https://me.sap.com/dl/real" }]);
});

test("extractAttachments drops non-SAP download URLs", () => {
  const attachments = extractAttachments(
    {
      Attachments: {
        Items: [
          { Filename: "safe.txt", URL: "https://me.sap.com/dl/safe" },
          { Filename: "steal.txt", URL: "https://evil.example/dl/steal" },
        ],
      },
    },
    DETAIL_API_BASE,
  );
  assert.deepEqual(attachments, [{ fileName: "safe.txt", url: "https://me.sap.com/dl/safe" }]);
});

test("formatAttachmentList omits download URLs", () => {
  const text = formatAttachmentList("3696257", [
    { fileName: "safe.txt", url: "https://me.sap.com/dl/safe", sizeBytes: 12 },
  ]);
  assert.match(text, /safe\.txt \(12 bytes\)/);
  assert.doesNotMatch(text, /https:\/\//);
  assert.doesNotMatch(text, /me\.sap\.com/);
});

test("extractAttachments returns [] for payloads without attachments", () => {
  assert.deepEqual(extractAttachments({ Response: { SAPNote: {} } }, DETAIL_API_BASE), []);
  assert.deepEqual(extractAttachments(null, DETAIL_API_BASE), []);
  assert.deepEqual(extractAttachments("nope", DETAIL_API_BASE), []);
});

test("isAllowedAttachmentHost only allows https on sap.com hosts", () => {
  assert.equal(isAllowedAttachmentHost("https://me.sap.com/backend/raw/x"), true);
  assert.equal(isAllowedAttachmentHost("https://launchpad.support.sap.com/x"), true);
  assert.equal(isAllowedAttachmentHost("https://sap.com/x"), true);
  assert.equal(isAllowedAttachmentHost("https://evil.example.com/sap.com"), false);
  assert.equal(isAllowedAttachmentHost("https://notsap.com/x"), false);
  assert.equal(isAllowedAttachmentHost("http://me.sap.com/x"), false);
  assert.equal(isAllowedAttachmentHost("https://sap.com.evil.example/x"), false);
  assert.equal(isAllowedAttachmentHost("https://evil@me.sap.com/x"), false);
  assert.equal(isAllowedAttachmentHost("not a url"), false);
});

test("fetchAllowedAttachment rejects a foreign redirect before requesting it", async () => {
  const requested: string[] = [];
  await assert.rejects(
    fetchAllowedAttachment(
      "https://me.sap.com/download/1",
      async (url) => `cookie-for=${new URL(url).hostname}`,
      new AbortController().signal,
      async (url, options) => {
        requested.push(url);
        assert.equal(options.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/download/1" },
        });
      },
    ),
    /Refusing to download from non-SAP host/,
  );
  assert.deepEqual(requested, ["https://me.sap.com/download/1"]);
});

test("fetchAllowedAttachment validates every SAP redirect and scopes cookies per hop", async () => {
  const requested: { url: string; cookie: string | null }[] = [];
  const response = await fetchAllowedAttachment(
    "https://me.sap.com/download/1",
    async (url) => `cookie-for=${new URL(url).hostname}`,
    new AbortController().signal,
    async (url, options) => {
      const headers = new Headers(options.headers);
      requested.push({ url, cookie: headers.get("cookie") });
      if (requested.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://support.sap.com/files/1" },
        });
      }
      return new Response("attachment", { status: 200 });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [
    { url: "https://me.sap.com/download/1", cookie: "cookie-for=me.sap.com" },
    { url: "https://support.sap.com/files/1", cookie: "cookie-for=support.sap.com" },
  ]);
});

test("writeResponseWithLimit enforces the actual streamed byte count without Content-Length", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-notes-limit-"));
  const target = join(directory, "attachment.bin");
  try {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }),
    );
    await assert.rejects(writeResponseWithLimit(response, target, 5), /exceeds the 5-byte limit/);
    await assert.rejects(access(target));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeResponseWithLimit atomically saves a response within the limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-notes-write-"));
  const target = join(directory, "attachment.txt");
  try {
    const response = new Response("safe content");
    assert.equal(await writeResponseWithLimit(response, target, 100), 12);
    assert.equal(await readFile(target, "utf8"), "safe content");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensurePrivateDirectory creates an owner-only directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sap-notes-dir-"));
  const nested = join(parent, "3696257");
  try {
    await ensurePrivateDirectory(nested);
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("sanitizeFileName prevents traversal and keeps names readable", () => {
  assert.equal(sanitizeFileName("ECS-param-fetch.txt"), "ECS-param-fetch.txt");
  // Path separators become underscores; the leftover dots are harmless without them.
  assert.equal(sanitizeFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(sanitizeFileName("dir\\file.txt"), "dir_file.txt");
  assert.equal(sanitizeFileName(".hidden"), "hidden");
  assert.equal(sanitizeFileName("  "), "attachment");
  assert.equal(sanitizeFileName("a".repeat(300)).length, 200);
});

test("isTextAttachment recognizes text by content type and extension", () => {
  assert.equal(isTextAttachment("script.txt", "text/plain"), true);
  assert.equal(isTextAttachment("data.bin", "text/plain; charset=utf-8"), true);
  assert.equal(isTextAttachment("collection.sql", "application/octet-stream"), true);
  assert.equal(isTextAttachment("export.csv", ""), true);
  assert.equal(isTextAttachment("archive.zip", "application/zip"), false);
  assert.equal(isTextAttachment("sheet.xlsx", "application/octet-stream"), false);
});

const TWO_ATTACHMENTS = [
  { fileName: "ECS-PreMigration-param-fetch-Systemdb.txt", url: "https://me.sap.com/dl/1" },
  { fileName: "ECS-PreMigration-param-fetch-Tenantdb.txt", url: "https://me.sap.com/dl/2" },
];

test("selectAttachment matches exactly, by unique substring, and reports ambiguity", () => {
  assert.equal(
    selectAttachment(TWO_ATTACHMENTS, "3696257", "ecs-premigration-param-fetch-systemdb.txt").url,
    "https://me.sap.com/dl/1",
  );
  assert.equal(
    selectAttachment(TWO_ATTACHMENTS, "3696257", "Tenantdb").url,
    "https://me.sap.com/dl/2",
  );
  assert.throws(
    () => selectAttachment(TWO_ATTACHMENTS, "3696257", "param-fetch"),
    /matches 2 attachments/,
  );
  assert.throws(
    () => selectAttachment(TWO_ATTACHMENTS, "3696257", "does-not-exist.txt"),
    /no attachment matching/,
  );
});

test("selectAttachment handles the no-fileName and empty-list cases", () => {
  const single = [TWO_ATTACHMENTS[0]!];
  assert.equal(selectAttachment(single, "3696257", undefined).url, "https://me.sap.com/dl/1");
  assert.throws(
    () => selectAttachment(TWO_ATTACHMENTS, "3696257", undefined),
    /pass fileName to pick one/,
  );
  assert.throws(() => selectAttachment([], "3696257", undefined), /new version is in preparation/);
});
