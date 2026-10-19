/** Shared source-to-plain-text helpers for the SaaS connectors. */

/** Atlassian Document Format (Jira descriptions) -> plain text. */
export function adfToText(node: unknown): string {
  if (node == null || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(adfToText).join("");
  const n = node as { type?: string; text?: string; content?: unknown };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []) && Array.isArray(n.content) ? n.content.map(adfToText).join("") : "";
  const BLOCK = new Set(["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "blockquote", "rule", "table", "tableRow", "tableCell", "tableHeader", "panel", "mediaSingle", "mediaGroup"]);
  return BLOCK.has(n.type ?? "") ? inner.replace(/\n+$/, "") + "\n" : inner;
}

/** Confluence storage-format XHTML -> plain text (tags stripped, blocks become lines). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Decode specific entities FIRST, &amp; LAST: a literal "&amp;ldquo;"
    // must become "&ldquo;" (single decode), never a raw quote char.
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;/g, "--").replace(/&ndash;/g, "-").replace(/&hellip;/g, "...")
    .replace(/&#(x?[0-9a-fA-F]+);/g, (_m, code: string) =>
      String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}
