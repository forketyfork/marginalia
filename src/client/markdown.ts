import DOMPurify from "dompurify";
import { Marked } from "marked";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Raw HTML in agent output is shown literally: `<system-reminder>` and friends are content, not markup. */
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const cache = new Map<string, string>();
const CACHE_LIMIT = 2000;

export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }));
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, html);
  return html;
}

export function renderPlain(text: string): string {
  return `<pre class="plain">${escapeHtml(text)}</pre>`;
}

/** Unified-diff style colouring for patches and edit previews. */
export function renderDiff(text: string): string {
  const lines = text.split("\n").map((line) => {
    let cls = "diff-ctx";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
    else if (line.startsWith("@@") || line.startsWith("***")) cls = "diff-hunk";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  });
  return `<pre class="plain diff">${lines.join("\n")}</pre>`;
}
