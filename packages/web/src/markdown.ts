import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? "Bild");
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token) {
    const href = String(token.attrGet("href") ?? "");
    if (!/^https?:\/\//i.test(href)) token.attrSet("href", "#");
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("target", "_blank");
  }
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
export function renderNote(markdownText: string): string { return markdown.render(markdownText); }
