import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import gradle from "highlight.js/lib/languages/gradle";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHtml } from "./html";

const GRAMMARS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  gradle,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

const EXTENSIONS: Record<string, string> = {
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  sql: "sql",
  go: "go",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  gradle: "gradle",
  swift: "swift",
  rb: "ruby",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  diff: "diff",
  patch: "diff",
};

const FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  justfile: "makefile",
  ".zshrc": "bash",
  ".zprofile": "bash",
  ".zshenv": "bash",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".profile": "bash",
};

/** Extra fence names that highlight.js does not register as aliases. */
const FENCE_NAMES: Record<string, string> = {
  shell: "bash",
  console: "bash",
  "c++": "cpp",
  "c#": "csharp",
  toml: "ini",
  jsonc: "json",
  json5: "json",
};

/** Grammar for a file path, by extension or well-known file name; null when none applies. */
export function languageForPath(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const byName = FILENAMES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1)] ?? null;
}

/** Grammar for a Markdown fence info string such as "ts" or "python title=x"; null when unknown. */
export function languageForFence(info: string): string | null {
  const word = (info.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (word.length === 0) return null;
  const mapped = FENCE_NAMES[word] ?? word;
  return hljs.getLanguage(mapped) ? mapped : null;
}

/** Highlighted, HTML-escaped code; plain escaped text when the language is unknown. */
export function highlightCode(code: string, language: string | null): string {
  if (language !== null && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return escapeHtml(code);
}

export function renderCode(code: string, language: string | null, extraClass = ""): string {
  const cls = `plain code${language ? ` lang-${language}` : ""}${extraClass ? ` ${extraClass}` : ""}`;
  return `<pre class="${cls}">${highlightCode(code, language)}</pre>`;
}

/**
 * Splits highlighted HTML at newlines so every line is self-contained: spans still open at a line
 * end are closed there and reopened on the next line. This keeps multi-line tokens (block comments,
 * template strings) highlighted when each line is wrapped in its own element.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  for (const match of html.matchAll(/<span class="[^"]*">|<\/span>|\n|[^<\n]+|</g)) {
    const token = match[0];
    if (token === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else if (token.startsWith("<span")) {
      open.push(token);
      current += token;
    } else if (token === "</span>") {
      open.pop();
      current += token;
    } else {
      current += token;
    }
  }
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}

const NUMBERED_LINE = /^\s*(\d+)(?:→|\t)(.*)$/;

/**
 * Claude's `Read` tool returns `cat -n` style lines (`     1→code` in older versions, `1<TAB>code` in
 * current ones). Renders them with the numbers in
 * a gutter that is neither selectable nor part of the text, so quotes and copies hold only the code;
 * null when the text is not in that shape.
 */
export function renderNumberedLines(text: string, language: string | null): string | null {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  const parsed: Array<{ n: string; code: string }> = [];
  for (const line of lines) {
    const match = NUMBERED_LINE.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) return null;
    parsed.push({ n: match[1], code: match[2] });
  }
  const highlighted = splitHighlightedLines(highlightCode(parsed.map((p) => p.code).join("\n"), language));
  const rows = parsed.map(
    (p, i) => `<span class="line"><span class="ln" data-n="${p.n}"></span>${highlighted[i] ?? ""}</span>`,
  );
  const cls = `plain code numbered${language ? ` lang-${language}` : ""}`;
  return `<pre class="${cls}">${rows.join("\n")}</pre>`;
}
