import { isObject } from "../parsers/json";
import { shortenPath } from "../shared/format";
import { languageForPath, renderCode, renderNumberedLines } from "./code";
import { escapeHtml } from "./html";
import { renderJson, renderJsonOrPlain } from "./json";
import { renderDiff, renderMarkdown } from "./markdown";
import type { ToolResultBlock, ToolUseBlock } from "./view";

const INLINE_LIMIT = 120;

function field(input: unknown, key: string): string | null {
  if (!isObject(input)) return null;
  const v = input[key];
  return typeof v === "string" ? v : null;
}

/** One line for the collapsed tool-call header. */
export function toolSummary(block: ToolUseBlock): string {
  const { name, input } = block;
  const first = (s: string | null) => (s ? (s.split("\n")[0]?.trim() ?? "") : "");
  switch (name) {
    case "Bash":
      return first(field(input, "command"));
    case "shell_command":
    case "local_shell": {
      const cmd =
        field(input, "command") ??
        (isObject(input) && Array.isArray(input.command) ? input.command.join(" ") : null);
      return first(cmd);
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return shortenPath(field(input, "file_path") ?? field(input, "notebook_path") ?? "", 4);
    case "Grep":
      return `${field(input, "pattern") ?? ""}${field(input, "path") ? ` in ${shortenPath(field(input, "path") ?? "", 3)}` : ""}`;
    case "Glob":
      return field(input, "pattern") ?? "";
    case "Agent":
      return field(input, "description") ?? first(field(input, "prompt"));
    case "Skill":
      return field(input, "skill") ?? "";
    case "WebFetch":
      return field(input, "url") ?? "";
    case "WebSearch":
    case "web_search":
      return field(input, "query") ?? "";
    case "apply_patch": {
      const patch = field(input, "input") ?? "";
      const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]);
      return files.length > 0 ? files.map((f) => shortenPath(f ?? "", 3)).join(", ") : first(patch);
    }
    default: {
      if (typeof input === "string") return first(input);
      if (!isObject(input)) return "";
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) return first(v);
      }
      return "";
    }
  }
}

function caption(text: string): string {
  return `<div class="caption">${escapeHtml(text)}</div>`;
}

function keyValue(input: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): string {
  const rows: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (skip.has(key) || value === undefined) continue;
    let rendered: string;
    if (typeof value === "string") {
      rendered =
        value.length > INLINE_LIMIT || value.includes("\n")
          ? renderJsonOrPlain(value)
          : `<code>${escapeHtml(value)}</code>`;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      rendered = `<code>${escapeHtml(String(value))}</code>`;
    } else {
      rendered = renderJson(value);
    }
    rows.push(`<div class="kv"><span class="k">${escapeHtml(key)}</span>${rendered}</div>`);
  }
  return rows.join("");
}

function editDiff(oldText: string, newText: string): string {
  const lines = [...oldText.split("\n").map((l) => `-${l}`), ...newText.split("\n").map((l) => `+${l}`)];
  return renderDiff(lines.join("\n"));
}

function structuredPatch(details: unknown): string | null {
  if (!isObject(details) || !Array.isArray(details.structuredPatch)) return null;
  const parts: string[] = [];
  for (const hunk of details.structuredPatch) {
    if (!isObject(hunk) || !Array.isArray(hunk.lines)) continue;
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    parts.push(...hunk.lines.filter((l): l is string => typeof l === "string"));
  }
  return parts.length > 0 ? renderDiff(parts.join("\n")) : null;
}

export function renderToolInput(block: ToolUseBlock, resultDetails: unknown): string {
  const { name, input } = block;
  if (typeof input === "string") return renderJsonOrPlain(input);
  if (!isObject(input)) return input === null ? "" : renderJson(input);
  switch (name) {
    case "Bash": {
      const parts = [renderCode(field(input, "command") ?? "", "bash")];
      const description = field(input, "description");
      if (description) parts.unshift(caption(description));
      const rest = keyValue(input, new Set(["command", "description"]));
      if (rest) parts.push(rest);
      return parts.join("");
    }
    case "shell_command":
    case "local_shell": {
      const cmd = field(input, "command") ?? (Array.isArray(input.command) ? input.command.join(" ") : "");
      return renderCode(cmd, "bash") + keyValue(input, new Set(["command"]));
    }
    case "Edit": {
      const patch = structuredPatch(resultDetails);
      const diff = patch ?? editDiff(field(input, "old_string") ?? "", field(input, "new_string") ?? "");
      return (
        caption(field(input, "file_path") ?? "") +
        diff +
        keyValue(input, new Set(["file_path", "old_string", "new_string"]))
      );
    }
    case "Write": {
      const path = field(input, "file_path") ?? "";
      return caption(path) + renderCode(field(input, "content") ?? "", languageForPath(path));
    }
    case "NotebookEdit": {
      const language = field(input, "cell_type") === "markdown" ? "markdown" : "python";
      return (
        caption(field(input, "notebook_path") ?? "") +
        renderCode(field(input, "new_source") ?? "", language) +
        keyValue(input, new Set(["notebook_path", "new_source"]))
      );
    }
    case "apply_patch":
      return renderDiff(field(input, "input") ?? "");
    case "Agent": {
      const head = [field(input, "subagent_type"), field(input, "description")].filter(Boolean).join(" · ");
      return (
        (head ? caption(head) : "") +
        `<div class="md">${renderMarkdown(field(input, "prompt") ?? "")}</div>` +
        keyValue(input, new Set(["prompt", "description", "subagent_type"]))
      );
    }
    case "TodoWrite": {
      if (!Array.isArray(input.todos)) return keyValue(input);
      const items = input.todos
        .filter(isObject)
        .map(
          (t) =>
            `<li class="todo todo-${escapeHtml(String(t.status ?? ""))}">${escapeHtml(String(t.content ?? ""))}</li>`,
        )
        .join("");
      return `<ul class="todos">${items}</ul>`;
    }
    default:
      return keyValue(input);
  }
}

/**
 * Result text is shown as code when the call tells us what it is (a `Read` of a known file type keeps
 * its line numbers in a gutter), as laid-out JSON when it parses as JSON, and as plain text otherwise.
 */
export function renderToolResult(block: ToolResultBlock, call: ToolUseBlock | null): string {
  const parts: string[] = [];
  if (block.text.length > 0) parts.push(resultText(block.text, call));
  for (const image of block.images) {
    parts.push(
      image.data
        ? `<img class="result-image" alt="tool result" src="data:${escapeHtml(image.mediaType)};base64,${image.data}" />`
        : `<div class="caption">image (${escapeHtml(image.mediaType)}) omitted: too large</div>`,
    );
  }
  if (parts.length === 0) parts.push('<div class="caption">(empty result)</div>');
  return parts.join("");
}

function resultText(text: string, call: ToolUseBlock | null): string {
  if (call?.name === "Read") {
    const numbered = renderNumberedLines(text, languageForPath(field(call.input, "file_path") ?? ""));
    if (numbered !== null) return numbered;
  }
  return renderJsonOrPlain(text);
}

export function resultDetailsHtml(details: unknown): string | null {
  if (!isObject(details)) return null;
  const shown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (k === "structuredPatch" || k === "stdout" || k === "stderr" || k === "content" || k === "file")
      continue;
    shown[k] = v;
  }
  return Object.keys(shown).length > 0 ? keyValue(shown) : null;
}
