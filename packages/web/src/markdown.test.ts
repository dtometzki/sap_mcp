import assert from "node:assert/strict";
import test from "node:test";
import { noteHtmlToMarkdown } from "@sap-notes/core";
import { renderNote } from "./markdown.js";

test("table conversion preserves data without headers and escapes pipes without emitting raw HTML", () => {
  const markdown = noteHtmlToMarkdown(`<table><tr><td>name | alternative</td><td><p>first</p><p>second</p></td></tr><tr><td colspan="2">combined</td></tr></table><img src="data:image/svg+xml,anything" alt="Logo">`);
  const html = renderNote(markdown);
  assert.match(html, /<table>/); assert.match(html, /name \| alternative/); assert.match(html, /first second/); assert.match(html, /combined/);
  assert.doesNotMatch(markdown, /<table|data:image|Logo/);
  assert.doesNotThrow(() => noteHtmlToMarkdown("<table></table>"));
});
