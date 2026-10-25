import { preview } from "../shared/format";
import type { Block, Transcript, Usage } from "../shared/model";
import { TranscriptBuilder } from "./builder";
import { arr, isObject, type JsonObject, num, obj, parseTimestamp, prettyJson, str } from "./json";
import { parseJsonl } from "./jsonl";

export interface GeminiOptions {
  path: string;
  fallbackId: string;
  /** SHA-256 hex of a project directory → that directory, from `~/.gemini/projects.json`. */
  projects: ReadonlyMap<string, string>;
}

export function parseGemini(text: string, opts: GeminiOptions): Transcript {
  const parsed = parseJsonl(text);
  let sessionId = opts.fallbackId;
  const header = parsed.lines.find(
    ({ value }) => str(value, "sessionId") !== null && str(value, "projectHash") !== null,
  );
  if (header) sessionId = str(header.value, "sessionId") ?? sessionId;

  const b = new TranscriptBuilder("gemini", sessionId, opts.path);
  b.malformedLines = parsed.malformed;
  let firstPrompt: string | null = null;

  for (const { line, value } of parsed.lines) {
    if (header && line === header.line) {
      const hash = str(value, "projectHash");
      if (hash) {
        b.extra.projectHash = hash;
        b.cwd = opts.projects.get(hash) ?? null;
      }
      b.touch(parseTimestamp(value.startTime));
      b.touch(parseTimestamp(value.lastUpdated));
      const kind = str(value, "kind");
      if (kind) b.extra.kind = kind;
      continue;
    }
    const set = obj(value, "$set");
    if (set) {
      b.touch(parseTimestamp(set.lastUpdated));
      continue;
    }
    const type = str(value, "type");
    const timestamp = parseTimestamp(value.timestamp);
    const id = str(value, "id") ?? `L${line}`;
    switch (type) {
      case "user": {
        const text = contentText(value.content);
        if (text.length === 0) break;
        b.add({ id, kind: "user", timestamp, blocks: [{ type: "text", text }], line });
        if (firstPrompt === null) firstPrompt = text;
        break;
      }
      case "gemini": {
        const blocks: Block[] = [];
        for (const thought of arr(value, "thoughts") ?? []) {
          if (!isObject(thought)) continue;
          const subject = str(thought, "subject");
          const description = str(thought, "description") ?? "";
          const body = subject ? `**${subject}**\n\n${description}` : description;
          if (body.trim().length > 0) blocks.push({ type: "thinking", text: body });
        }
        const text = contentText(value.content);
        if (text.length > 0) blocks.push({ type: "text", text });
        const results: Block[] = [];
        for (const call of arr(value, "toolCalls") ?? []) {
          if (!isObject(call)) continue;
          const callId = str(call, "id") ?? str(call, "callId") ?? `call-${id}-${blocks.length}`;
          blocks.push({
            type: "tool_use",
            id: callId,
            name: str(call, "name") ?? "tool",
            input: call.args ?? call.input ?? null,
          });
          const result = call.result ?? call.response ?? call.output;
          if (result !== undefined) {
            const resultText = prettyJson(result);
            results.push({
              type: "tool_result",
              toolUseId: callId,
              text: resultText,
              isError: str(call, "status") === "error" || call.error !== undefined,
              images: [],
              details: null,
              truncated: false,
              fullLength: resultText.length,
            });
          }
        }
        const model = str(value, "model");
        b.add({
          id,
          kind: "assistant",
          timestamp,
          blocks,
          line,
          model,
          usage: usageOf(obj(value, "tokens")),
        });
        if (results.length > 0) {
          b.add({ id: `${id}-results`, kind: "tool_result", timestamp, blocks: results, line });
        }
        break;
      }
      case null:
        b.skip("untyped");
        break;
      default: {
        const text = contentText(value.content);
        b.add({
          id,
          kind: "system",
          label: type,
          level: type === "error" ? "error" : type === "warning" ? "warning" : "info",
          timestamp,
          blocks: text.length > 0 ? [{ type: "text", text }] : [],
          line,
        });
      }
    }
  }

  b.title = firstPrompt ? preview(firstPrompt, 120) : null;
  return b.build();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) ? (str(part, "text") ?? prettyJson(part)) : String(part)))
    .join("\n");
}

function usageOf(tokens: JsonObject | null): Usage | null {
  if (!tokens) return null;
  return {
    input: num(tokens, "input") ?? 0,
    output: num(tokens, "output") ?? 0,
    cacheRead: num(tokens, "cached") ?? 0,
    cacheCreation: 0,
    thinking: num(tokens, "thoughts") ?? 0,
  };
}
