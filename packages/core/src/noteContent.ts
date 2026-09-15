import TurndownService from "turndown";

/**
 * Runs inside the SAP page (evaluate/waitForFunction): no module-scope references.
 * A portal shell is not a note. Anchor extraction on actual document headings,
 * even when SAP wraps both the navigation and document in one .sapMPage.
 */
export function extractNoteDocument(id: string): string | null {
  const chrome = "nav, [role='navigation'], [role='banner'], [role='toolbar'], [role='tablist'], [hidden], [aria-hidden='true']";
  const headingText = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim().replace(/:$/, "");
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")]
    .filter(element => !element.closest(chrome) && element.getClientRects().length > 0);
  const contentHeading = /^(symptom|symptoms|environment|cause|reason and prerequisites|other terms|solution|resolution|reproducing the issue|problem|umgebung|ursache(?: und voraussetzungen)?|weitere begriffe|lösung)$/i;
  const first = headings.find(element => contentHeading.test(headingText(element)));
  let fragment: DocumentFragment | Element;
  if (first) {
    const after = headings.slice(headings.indexOf(first) + 1);
    const boundary = after.find(element => /^(available languages|verfügbare sprachen)$/i.test(headingText(element)));
    // Keep all content sections, references and attachments up to the language chooser.
    // A range preserves intervening paragraphs/tables across nested SPA wrappers.
    const range = document.createRange();
    range.setStartBefore(first);
    if (boundary) range.setEndBefore(boundary);
    else {
      const scope = [...document.querySelectorAll("article, main, [role='main'], .sapMPage, #content")]
        .filter(element => element.contains(first) && after.filter(item => contentHeading.test(headingText(item))).every(item => element.contains(item)))
        .sort((a, b) => a.contains(b) ? 1 : b.contains(a) ? -1 : 0)[0] ?? document.body;
      range.setEnd(scope, scope.childNodes.length);
    }
    fragment = range.cloneContents();
  } else {
    // Documents without standard SAP section names need an explicit article and
    // matching note title. Never accept an arbitrary shell/body just for its length.
    const article = [...document.querySelectorAll("article")].find(element =>
      headings.some(heading => element.contains(heading) && headingText(heading).startsWith(id)) &&
      element.querySelector("p, table, ul, ol"));
    if (!article) return null;
    fragment = article.cloneNode(true) as Element;
  }
  const container = document.createElement("div");
  container.append(fragment);
  for (const element of container.querySelectorAll(
    `${chrome}, header, footer, [role='contentinfo'], button, input, select, textarea, script, style, noscript, img, picture, svg, canvas, iframe, object, embed`,
  )) element.remove();
  for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
    if (element.style.display === "none" || element.style.visibility === "hidden") element.remove();
  }
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const target = new URL(link.getAttribute("href") ?? "", document.baseURI);
      if (target.protocol === "https:" || target.protocol === "http:") link.setAttribute("href", target.href);
      else link.removeAttribute("href");
    } catch { link.removeAttribute("href"); }
  }
  // A rendered heading without its asynchronously loaded body is still incomplete.
  const copy = container.cloneNode(true) as HTMLElement;
  for (const heading of copy.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")) heading.remove();
  if ((copy.textContent ?? "").replace(/\s+/g, " ").trim().length < 50) return null;
  return container.innerHTML;
}

const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
converter.addRule("discardNonContent", {
  filter: node => ["SCRIPT", "STYLE", "NOSCRIPT", "IMG", "SVG"].includes(node.nodeName.toUpperCase()),
  replacement: () => "",
});
converter.addRule("safeLinks", {
  filter: node => node.nodeName === "A" && !/^https?:\/\//i.test(node.getAttribute("href") ?? ""),
  replacement: content => content,
});
converter.addRule("tables", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.querySelectorAll("tr")).filter(row => {
      let parent = row.parentElement;
      while (parent && parent.nodeName !== "TABLE") parent = parent.parentElement;
      return parent === table;
    });
    if (!rows.length) return "";
    const lines = rows.map(row => Array.from(row.querySelectorAll("th, td"))
      .filter(cell => cell.parentNode === row)
      .flatMap(cell => {
        const text = converter.turndown(cell.innerHTML).trim()
          .replace(/\n+/g, " ").replace(/(?<!\\)\|/g, "\\|");
        // Preserve the grid for merged cells without duplicating their contents.
        return [text, ...Array.from({ length: Math.min(100, Math.max(1, Number(cell.getAttribute("colspan")) || 1)) - 1 }, () => "")];
      }));
    const width = Math.max(...lines.map(row => row.length));
    if (!width) return "";
    const heading = Boolean(rows[0]?.querySelector("th"));
    if (!heading) lines.unshift(Array.from({ length: width }, () => ""));
    const format = (cells: string[]): string => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
    const [header = [], ...body] = lines;
    return `\n\n${[format(header), format(Array.from({ length: width }, () => "---")), ...body.map(format)].join("\n")}\n\n`;
  },
});

export function noteHtmlToMarkdown(html: string): string {
  return converter.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}
