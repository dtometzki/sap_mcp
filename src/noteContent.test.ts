import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractNoteDocument, noteHtmlToMarkdown } from "./noteContent.js";
import { fetchNote } from "./notes.js";
import { renderNote } from "./web/markdown.js";
import { loadConfig } from "./config.js";
import type { SapSession } from "./session.js";

const description = `<section><h3>Symptom</h3><p>A database operation reports an error. This paragraph describes the observed problem in detail.</p>
  <h3>Reason and Prerequisites</h3><p>Review the configuration before proceeding.</p>
  <h3>Solution</h3><ol><li>Check the affected component.</li><li>Follow the documented procedure.</li></ol>
  <table><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td>example_setting</td><td><code>enabled</code></td></tr></tbody></table>
  <p><a href="/notes/2170696">Related SAP Note</a></p><img alt="Logo" src="data:image/svg+xml,%3Csvg%3E">
  <div role="toolbar"><button>Download for SNOTE</button><span>Show Changes</span></div>
  <div hidden>Hidden portal state</div></section>`;
const shell = `<header role="banner">Menu<img alt="Logo" src="data:image/svg+xml,%3Csvg%3E">SAP for Me</header>
  <nav><h2>Solution</h2>Home SearchCancel Notifications ${"Dashboard ".repeat(50)}</nav>`;
async function launch(t: { skip(message: string): void }): Promise<Browser | undefined> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) { if (process.env.CI) throw error; t.skip("Chromium cannot start in this environment"); return undefined; }
}

test("note extraction excludes the portal shell, keeps all document sections and renders tables", async t => {
  const browser = await launch(t); if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent(`<base href="https://me.sap.com/notes/3250501"><div class="sapMPage">${shell}
      <main><h1>3250501 - Example document</h1><div role="toolbar">Expand header content</div>
      ${description}<section><h3>This document refers to</h3><p>Reference details remain available.</p></section>
      <section><h3>Available Languages</h3><ul><li>Deutsch (Machine Translation)</li></ul></section></main>
      <footer>Legal Feedback</footer></div>`);
    const html = await page.evaluate(extractNoteDocument, "3250501"); assert.ok(html);
    const markdown = noteHtmlToMarkdown(html);
    for (const unwanted of ["SAP for Me", "SearchCancel", "Dashboard", "Menu", "Logo", "data:image", "Download for SNOTE", "Show Changes", "Available Languages", "Hidden portal state", "Example document", "Legal Feedback"]) assert.ok(!markdown.includes(unwanted), unwanted);
    for (const wanted of ["### Symptom", "### Reason and Prerequisites", "### Solution", "This document refers to", "Reference details", "1.  Check", "example\\_setting", "https://me.sap.com/notes/2170696"]) assert.ok(markdown.includes(wanted), wanted);
    const rendered = renderNote(markdown);
    assert.match(rendered, /example_setting/); assert.match(rendered, /<table>/); assert.match(rendered, /<th>Parameter<\/th>/); assert.match(rendered, /<code>enabled<\/code>/);
  } finally { await browser.close(); }
});

test("fetchNote waits for asynchronously rendered content instead of accepting the shell", async t => {
  const browser = await launch(t); if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent(`<title>3250501 - Example document | SAP for Me</title><div class="sapMPage">${shell}<main id="document"></main></div>`);
    await page.evaluate(html => { setTimeout(() => { document.getElementById("document")!.innerHTML = html; }, 250); }, description);
    const session = { withOpenPage: async (_url: string, fn: (page: Page) => Promise<unknown>) => fn(page) };
    const note = await fetchNote(session as unknown as SapSession, { ...loadConfig(), navigationTimeoutMs: 3000 }, "3250501");
    assert.equal(note.title, "Example document"); assert.match(note.markdown, /observed problem/); assert.doesNotMatch(note.markdown, /Dashboard/);
  } finally { await browser.close(); }
});

test("shell-only pages and empty document headings do not count as readable notes", async t => {
  const browser = await launch(t); if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="sapMPage">${shell}<main><h1>3250501 - Example document</h1></main></div>`);
    assert.equal(await page.evaluate(extractNoteDocument, "3250501"), null);
    await page.setContent(`${shell}<main><h3>Symptom</h3><h3>Solution</h3></main>`);
    assert.equal(await page.evaluate(extractNoteDocument, "3250501"), null);
    const session = { withOpenPage: async (_url: string, fn: (value: typeof page) => Promise<unknown>) => fn(page) };
    await assert.rejects(fetchNote(session as unknown as SapSession, { ...loadConfig(), navigationTimeoutMs: 100 }, "3250501"), /no readable document sections/);
  } finally { await browser.close(); }
});

test("documents without standard headings require an explicit article with the requested note number", async t => {
  const browser = await launch(t); if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent(`${shell}<article><h1>3250501 - Example document</h1><p>This article contains a complete explanation of an unusual issue and its documented workaround.</p></article>`);
    assert.ok(await page.evaluate(extractNoteDocument, "3250501"));
    assert.equal(await page.evaluate(extractNoteDocument, "9999999"), null);
  } finally { await browser.close(); }
});

test("table conversion preserves data without headers and escapes pipes without emitting raw HTML", () => {
  const markdown = noteHtmlToMarkdown(`<table><tr><td>name | alternative</td><td><p>first</p><p>second</p></td></tr><tr><td colspan="2">combined</td></tr></table><img src="data:image/svg+xml,anything" alt="Logo">`);
  const html = renderNote(markdown);
  assert.match(html, /<table>/); assert.match(html, /name \| alternative/); assert.match(html, /first second/); assert.match(html, /combined/);
  assert.doesNotMatch(markdown, /<table|data:image|Logo/);
  assert.doesNotThrow(() => noteHtmlToMarkdown("<table></table>"));
});
