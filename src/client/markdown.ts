import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { highlightCode, languageForFence } from "./code";
import { escapeHtml, markPseudoTags, PSEUDO_TAG, PSEUDO_TAG_AT_START } from "./html";
import { highlightShell } from "./shell";

/**
 * Emphasis tags are tokenized ahead of marked's own inline HTML rule, so names with underscores,
 * which CommonMark does not treat as tags at all, are marked up the same way as `<IMPORTANT>`.
 */
const pseudoTags: TokenizerAndRendererExtension = {
  name: "pseudoTag",
  level: "inline",
  start(src) {
    return src.search(PSEUDO_TAG);
  },
  tokenizer(src) {
    const match = PSEUDO_TAG_AT_START.exec(src);
    return match ? { type: "pseudoTag", raw: match[0], text: match[0] } : undefined;
  },
  renderer(token) {
    return `<span class="ptag">${escapeHtml(String(token.text))}</span>`;
  },
};

const marked: Marked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [pseudoTags],
  renderer: {
    /**
     * Raw HTML in agent output is shown literally: `<system-reminder>` and friends are content, not
     * markup. A block that opens with an emphasis tag is the prompt's own Markdown, so it is rendered
     * inline rather than frozen as one escaped run with its line breaks lost.
     */
    html({ text, block }): string {
      if (block && PSEUDO_TAG_AT_START.test(text)) return marked.parseInline(text, { async: false });
      return markPseudoTags(escapeHtml(text));
    },
    code({ text, lang }) {
      const language = languageForFence(lang ?? "");
      const cls = `hljs${language ? ` language-${language}` : ""}`;
      return `<pre><code class="${cls}">${language === "bash" ? highlightShell(text) : highlightCode(text, language)}</code></pre>\n`;
    },
  },
});

/** DOMPurify needs a DOM, so the link hook is registered on first render rather than at import. */
let sanitizer: typeof DOMPurify | null = null;
function sanitize(html: string): string {
  if (sanitizer === null) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    sanitizer = DOMPurify;
  }
  return sanitizer.sanitize(html);
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 2000;

/** Marked's output before sanitizing; the UI goes through `renderMarkdown`. */
export function parseMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}

export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const html = sanitize(parseMarkdown(text));
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, html);
  return html;
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
