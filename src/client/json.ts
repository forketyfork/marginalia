import { escapeHtml, renderPlain } from "./html";

const INDENT = "  ";
/** Strings at least this long are laid out as blocks even without a line break. */
const BLOCK_MIN_LENGTH = 80;
/** How many levels of JSON-encoded-in-a-string to unfold. */
const MAX_NESTING = 3;

/** The parsed object or array when `text` is JSON of that shape; undefined otherwise. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pretty-prints JSON for reading rather than for parsing back: long or multi-line strings become
 * indented `"""` blocks with their real line breaks, and a string that itself holds JSON is unfolded
 * into nested JSON. Tool results that wrap a Markdown document in a JSON field read as the document.
 */
export function renderJson(value: unknown): string {
  return `<pre class="plain code json">${jsonHtml(value, 0, 0)}</pre>`;
}

export function renderJsonOrPlain(text: string): string {
  const parsed = tryParseJson(text);
  return parsed === undefined ? renderPlain(text) : renderJson(parsed);
}

const punct = (s: string) => `<span class="hljs-punctuation">${s}</span>`;
const pad = (depth: number) => INDENT.repeat(depth);

function jsonHtml(value: unknown, depth: number, nesting: number): string {
  if (value === null) return '<span class="hljs-literal">null</span>';
  switch (typeof value) {
    case "boolean":
      return `<span class="hljs-literal">${value}</span>`;
    case "number":
      return `<span class="hljs-number">${value}</span>`;
    case "string":
      return stringHtml(value, depth, nesting);
    case "object":
      break;
    default:
      return escapeHtml(String(value));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return punct("[]");
    const items = value.map((item) => pad(depth + 1) + jsonHtml(item, depth + 1, nesting));
    return `${punct("[")}\n${items.join(`${punct(",")}\n`)}\n${pad(depth)}${punct("]")}`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return punct("{}");
  const rows = entries.map(
    ([key, item]) =>
      `${pad(depth + 1)}<span class="hljs-attr">${escapeHtml(JSON.stringify(key))}</span>${punct(":")} ${jsonHtml(item, depth + 1, nesting)}`,
  );
  return `${punct("{")}\n${rows.join(`${punct(",")}\n`)}\n${pad(depth)}${punct("}")}`;
}

function stringHtml(value: string, depth: number, nesting: number): string {
  if (nesting < MAX_NESTING) {
    const nested = tryParseJson(value);
    if (nested !== undefined) return block(jsonHtml(nested, depth + 1, nesting + 1), depth);
  }
  if (value.includes("\n") || value.length >= BLOCK_MIN_LENGTH) {
    const lines = value.split("\n").map((line) => pad(depth + 1) + escapeHtml(line));
    return block(`<span class="str-text">${lines.join("\n")}</span>`, depth, false);
  }
  return `<span class="hljs-string">${escapeHtml(JSON.stringify(value))}</span>`;
}

function block(inner: string, depth: number, indentFirst = true): string {
  const quote = '<span class="hljs-string str-block">"""</span>';
  return `${quote}\n${indentFirst ? pad(depth + 1) : ""}${inner}\n${pad(depth)}${quote}`;
}
