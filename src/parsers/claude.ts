import { formatDuration, preview } from "../shared/format";
import type { Block, Entry, ImageRef, Transcript, Usage } from "../shared/model";
import { TranscriptBuilder } from "./builder";
import {
  arr,
  bool,
  isObject,
  type JsonObject,
  num,
  obj,
  omitKeys,
  parseTimestamp,
  prettyJson,
  str,
} from "./json";
import { parseJsonl } from "./jsonl";

/** Request logs and file-history bookkeeping make up most bytes of a large session and carry no conversation. */
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history'];

export function classifyClaudeLine(line: string): string | null {
  for (const prefix of SKIP_PREFIXES) {
    if (line.startsWith(prefix)) {
      const match = /^\{"type":"([^"]+)"/.exec(line);
      return match?.[1] ?? "skipped";
    }
  }
  return null;
}

const ENVELOPE_KEYS = new Set([
  "parentUuid",
  "logicalParentUuid",
  "isSidechain",
  "uuid",
  "timestamp",
  "sessionId",
  "session_id",
  "userType",
  "entrypoint",
  "cwd",
  "version",
  "gitBranch",
  "type",
  "subtype",
  "isMeta",
  "promptId",
  "agentId",
]);

/** `toolUseResult` carries copies of file contents that already appear in the tool result text. */
const DROPPED_DETAIL_KEYS = new Set(["originalFile"]);
const DETAIL_STRING_LIMIT = 2_000;
const INLINE_IMAGE_LIMIT = 256 * 1024;

export interface ClaudeOptions {
  path: string;
  id: string;
  agentId?: string | null;
}

export function parseClaude(text: string, opts: ClaudeOptions): Transcript {
  const b = new TranscriptBuilder("claude", opts.id, opts.path);
  b.agentId = opts.agentId ?? null;
  const parsed = parseJsonl(text, classifyClaudeLine);
  b.malformedLines = parsed.malformed;
  for (const [label, count] of parsed.skipped) b.skip(label, count);

  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let legacySummary: string | null = null;
  let firstPrompt: string | null = null;
  let firstCommand: string | null = null;
  let current: AssistantCursor = null;

  for (const { line, value } of parsed.lines) {
    const type = str(value, "type");
    if (type === null) {
      b.skip("untyped");
      continue;
    }
    noteEnvelope(b, value);
    const timestamp = parseTimestamp(value.timestamp);

    switch (type) {
      case "assistant":
        current = addAssistant(b, value, line, timestamp, current);
        break;
      case "user": {
        current = null;
        const entry = addUser(b, value, line, timestamp);
        if (entry.kind === "user" && firstPrompt === null) {
          firstPrompt = entry.blocks.find((bl) => bl.type === "text")?.text ?? null;
        }
        if (entry.kind === "command" && firstCommand === null) firstCommand = entry.label;
        break;
      }
      case "system":
        current = null;
        addSystem(b, value, line, timestamp);
        break;
      case "attachment":
        current = null;
        addAttachment(b, value, line, timestamp);
        break;
      case "ai-title":
        aiTitle = str(value, "aiTitle") ?? aiTitle;
        break;
      case "agent-name":
        agentName = str(value, "agentName") ?? agentName;
        break;
      case "summary":
        legacySummary = str(value, "summary") ?? legacySummary;
        break;
      case "cost-state":
        noteCost(b, value);
        break;
      case "pr-link": {
        const url = str(value, "prUrl");
        if (url) b.prLinks.add(url);
        break;
      }
      case "permission-mode":
        b.permissionMode = str(value, "permissionMode") ?? b.permissionMode;
        break;
      case "mode": {
        const mode = str(value, "mode");
        if (mode) b.extra.mode = mode;
        break;
      }
      default:
        b.skip(type);
    }
  }

  b.title =
    agentName ?? aiTitle ?? legacySummary ?? (firstPrompt ? preview(firstPrompt, 120) : null) ?? firstCommand;
  return b.build();
}

function noteEnvelope(b: TranscriptBuilder, value: JsonObject): void {
  if (b.cwd === null) b.cwd = str(value, "cwd");
  const branch = str(value, "gitBranch");
  if (branch) b.gitBranch = branch;
  const version = str(value, "version");
  if (version) b.versions.add(version);
}

export function noteCost(b: TranscriptBuilder, value: JsonObject): void {
  b.costUsd = num(value, "totalCostUSD") ?? b.costUsd;
  const usage = obj(value, "modelUsage");
  if (!usage) return;
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
  for (const perModel of Object.values(usage)) {
    if (!isObject(perModel)) continue;
    total.input += num(perModel, "inputTokens") ?? 0;
    total.output += num(perModel, "outputTokens") ?? 0;
    total.cacheRead += num(perModel, "cacheReadInputTokens") ?? 0;
    total.cacheCreation += num(perModel, "cacheCreationInputTokens") ?? 0;
    total.thinking += num(perModel, "thinkingTokens") ?? 0;
  }
  b.totalTokens = total;
}

/** The assistant entry still being streamed, so that the next line of the same API message joins it. */
export type AssistantCursor = { entry: Entry; messageId: string } | null;

export function addAssistant(
  b: TranscriptBuilder,
  value: JsonObject,
  line: number,
  timestamp: number | null,
  current: AssistantCursor,
): AssistantCursor {
  const uuid = str(value, "uuid") ?? `L${line}`;
  const message = obj(value, "message");
  if (!message) {
    b.skip("assistant:no-message");
    return null;
  }
  const blocks = assistantBlocks(message.content);
  if (bool(value, "isApiErrorMessage")) {
    b.add({
      id: uuid,
      parentId: str(value, "parentUuid"),
      kind: "system",
      label: "api_error",
      level: "error",
      timestamp,
      blocks,
      line,
      isSidechain: bool(value, "isSidechain"),
    });
    return null;
  }
  const messageId = str(message, "id") ?? uuid;
  const usage = parseUsage(obj(message, "usage"));
  const thinkingMs = num(value, "thinkingDurationMs");
  if (current && current.messageId === messageId && b.last() === current.entry) {
    b.appendBlocks(current.entry, blocks);
    if (usage) current.entry.usage = usage;
    if (thinkingMs !== null) current.entry.thinkingMs = (current.entry.thinkingMs ?? 0) + thinkingMs;
    const stop = str(message, "stop_reason");
    if (stop) current.entry.stopReason = stop;
    return current;
  }
  const entry = b.add({
    id: uuid,
    parentId: str(value, "parentUuid"),
    kind: "assistant",
    timestamp,
    blocks,
    line,
    model: str(message, "model"),
    usage,
    stopReason: str(message, "stop_reason"),
    thinkingMs,
    isSidechain: bool(value, "isSidechain"),
  });
  return { entry, messageId };
}

function assistantBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    switch (str(part, "type")) {
      case "text": {
        const text = str(part, "text") ?? "";
        if (text.length > 0) blocks.push({ type: "text", text });
        break;
      }
      case "thinking": {
        const text = str(part, "thinking") ?? "";
        if (text.length > 0) blocks.push({ type: "thinking", text });
        break;
      }
      case "redacted_thinking":
        blocks.push({ type: "thinking", text: "(redacted thinking)" });
        break;
      case "tool_use":
        blocks.push({
          type: "tool_use",
          id: str(part, "id") ?? "",
          name: str(part, "name") ?? "unknown",
          input: part.input ?? null,
        });
        break;
      default:
        blocks.push({
          type: "data",
          label: str(part, "type") ?? "block",
          text: prettyJson(part),
          truncated: false,
          fullLength: 0,
        });
    }
  }
  return blocks;
}

function parseUsage(usage: JsonObject | null): Usage | null {
  if (!usage) return null;
  const details = obj(usage, "output_tokens_details");
  return {
    input: num(usage, "input_tokens") ?? 0,
    output: num(usage, "output_tokens") ?? 0,
    cacheRead: num(usage, "cache_read_input_tokens") ?? 0,
    cacheCreation: num(usage, "cache_creation_input_tokens") ?? 0,
    thinking: details ? (num(details, "thinking_tokens") ?? 0) : 0,
  };
}

export function addUser(
  b: TranscriptBuilder,
  value: JsonObject,
  line: number,
  timestamp: number | null,
): Entry {
  const uuid = str(value, "uuid") ?? `L${line}`;
  const message = obj(value, "message");
  const { blocks, toolResults } = userBlocks(message?.content, value.toolUseResult);
  const text = blocks
    .filter((bl): bl is Extract<Block, { type: "text" }> => bl.type === "text")
    .map((bl) => bl.text)
    .join("\n");

  let kind: Entry["kind"];
  let label: string | null = null;
  if (toolResults > 0) {
    kind = "tool_result";
  } else if (bool(value, "isCompactSummary")) {
    kind = "compact";
    label = "compact summary";
  } else if (bool(value, "isMeta")) {
    kind = "meta";
  } else if (/^\s*<command-(name|message)>/.test(text) || text.includes("<local-command-stdout>")) {
    kind = "command";
    label = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ?? null;
  } else {
    kind = "user";
  }

  const entry = b.add({
    id: uuid,
    parentId: str(value, "parentUuid"),
    kind,
    label,
    timestamp,
    blocks,
    line,
    isSidechain: bool(value, "isSidechain"),
  });

  const details = value.toolUseResult;
  if (kind === "tool_result" && isObject(details)) {
    const agentId = str(details, "agentId");
    if (agentId) {
      const toolUseId = blocks.find((bl) => bl.type === "tool_result")?.toolUseId ?? null;
      b.addSubagent({ agentId, description: str(details, "description"), toolUseId });
    }
  }
  return entry;
}

function userBlocks(content: unknown, toolUseResult: unknown): { blocks: Block[]; toolResults: number } {
  if (typeof content === "string") {
    return { blocks: content.length > 0 ? [{ type: "text", text: content }] : [], toolResults: 0 };
  }
  if (!Array.isArray(content)) return { blocks: [], toolResults: 0 };
  const resultParts = content.filter((p) => isObject(p) && str(p, "type") === "tool_result").length;
  const blocks: Block[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    switch (str(part, "type")) {
      case "text": {
        const text = str(part, "text") ?? "";
        if (text.length > 0) blocks.push({ type: "text", text });
        break;
      }
      case "image": {
        const image = imageRef(obj(part, "source"));
        if (image) blocks.push({ type: "image", image });
        break;
      }
      case "tool_result":
        blocks.push(toolResultBlock(part, resultParts === 1 ? toolUseResult : null));
        break;
      default:
        blocks.push({
          type: "data",
          label: str(part, "type") ?? "block",
          text: prettyJson(part),
          truncated: false,
          fullLength: 0,
        });
    }
  }
  return { blocks, toolResults: resultParts };
}

function toolResultBlock(part: JsonObject, toolUseResult: unknown): Block {
  const texts: string[] = [];
  const images: ImageRef[] = [];
  const content = part.content;
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const inner of content) {
      if (!isObject(inner)) continue;
      const innerType = str(inner, "type");
      if (innerType === "text") {
        texts.push(str(inner, "text") ?? "");
      } else if (innerType === "image") {
        const image = imageRef(obj(inner, "source"));
        if (image) images.push(image);
      } else {
        texts.push(prettyJson(inner));
      }
    }
  }
  let text = texts.join("\n");
  if (text.length === 0 && typeof toolUseResult === "string") text = toolUseResult;
  const isError =
    bool(part, "is_error") || (typeof toolUseResult === "string" && /^Error/i.test(toolUseResult));
  return {
    type: "tool_result",
    toolUseId: str(part, "tool_use_id") ?? "",
    text,
    isError,
    images,
    details: isObject(toolUseResult) ? compactDetails(toolUseResult) : null,
    truncated: false,
    fullLength: text.length,
  };
}

function compactDetails(details: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(details)) {
    if (DROPPED_DETAIL_KEYS.has(key)) continue;
    out[key] = compactValue(v);
  }
  return out;
}

function compactValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > DETAIL_STRING_LIMIT ? `${v.slice(0, DETAIL_STRING_LIMIT)}… [${v.length} chars]` : v;
  }
  if (Array.isArray(v)) return v.map(compactValue);
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, inner] of Object.entries(v)) {
      if (k === "content" && typeof inner === "string" && inner.length > DETAIL_STRING_LIMIT) continue;
      out[k] = compactValue(inner);
    }
    return out;
  }
  return v;
}

function imageRef(source: JsonObject | null): ImageRef | null {
  if (!source) return null;
  const data = str(source, "data");
  return {
    mediaType: str(source, "media_type") ?? "image/png",
    data: data && data.length <= INLINE_IMAGE_LIMIT ? data : null,
  };
}

function addSystem(b: TranscriptBuilder, value: JsonObject, line: number, timestamp: number | null): void {
  const uuid = str(value, "uuid") ?? `L${line}`;
  const subtype = str(value, "subtype") ?? "system";
  const content = str(value, "content") ?? "";
  const rest = omitKeys(value, ENVELOPE_KEYS);
  const blocks: Block[] = [];
  let text = content;
  let kind: Entry["kind"] = "system";
  let label: string | null = subtype;

  switch (subtype) {
    case "turn_duration": {
      const ms = num(value, "durationMs");
      const messages = num(value, "messageCount");
      text = `Turn took ${ms === null ? "?" : formatDuration(ms)}${messages === null ? "" : ` across ${messages} messages`}`;
      break;
    }
    case "stop_hook_summary": {
      const hooks = arr(value, "hookInfos") ?? [];
      const described = hooks
        .filter(isObject)
        .map((h) => `${str(h, "command") ?? "?"} (${num(h, "durationMs") ?? "?"} ms)`)
        .join("; ");
      const errors = arr(value, "hookErrors") ?? [];
      text = `${hooks.length} stop hook${hooks.length === 1 ? "" : "s"}: ${described}${errors.length > 0 ? ` — ${errors.length} error(s)` : ""}`;
      break;
    }
    case "compact_boundary": {
      const meta = obj(value, "compactMetadata");
      const trigger = meta ? str(meta, "trigger") : null;
      const pre = meta ? num(meta, "preTokens") : null;
      text = `${content || "Conversation compacted"}${trigger ? ` (${trigger})` : ""}${pre !== null ? `, ${pre.toLocaleString("en-US")} tokens before` : ""}`;
      break;
    }
    case "local_command":
      kind = "command";
      label = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1]?.trim() ?? subtype;
      break;
    default:
      break;
  }

  if (text.length > 0) blocks.push({ type: "text", text });
  const detailKeys = Object.keys(rest).filter((k) => k !== "content");
  if (detailKeys.length > 0) {
    const details = omitKeys(rest, new Set(["content"]));
    const json = prettyJson(details);
    blocks.push({ type: "data", label: "details", text: json, truncated: false, fullLength: json.length });
  }
  b.add({
    id: uuid,
    parentId: str(value, "parentUuid") ?? str(value, "logicalParentUuid"),
    kind,
    label,
    level: str(value, "level"),
    timestamp,
    blocks,
    line,
    isSidechain: bool(value, "isSidechain"),
  });
}

function addAttachment(
  b: TranscriptBuilder,
  value: JsonObject,
  line: number,
  timestamp: number | null,
): void {
  const uuid = str(value, "uuid") ?? `L${line}`;
  const attachment = obj(value, "attachment");
  if (!attachment) {
    b.skip("attachment:empty");
    return;
  }
  const subtype = str(attachment, "type") ?? "attachment";
  const texts: string[] = [];
  const content = attachment.content;
  if (typeof content === "string" && content.length > 0) texts.push(content);
  else if (Array.isArray(content)) texts.push(...content.filter((c): c is string => typeof c === "string"));
  const text = texts.join("\n").trim();
  const rest = omitKeys(attachment, new Set(["type", "content", "stdout", "stderr"]));
  const blocks: Block[] = [];
  if (text.length > 0) blocks.push({ type: "text", text });
  // Hook output is program output, not prose: as data it is laid out as JSON and never read as Markdown.
  for (const key of ["stdout", "stderr"]) {
    const v = str(attachment, key);
    if (v && v.length > 0)
      blocks.push({ type: "data", label: key, text: v, truncated: false, fullLength: v.length });
  }
  if (Object.keys(rest).length > 0) {
    const json = prettyJson(rest);
    blocks.push({ type: "data", label: subtype, text: json, truncated: false, fullLength: json.length });
  }
  const hookName = str(attachment, "hookName");
  b.add({
    id: uuid,
    parentId: str(value, "parentUuid"),
    kind: "attachment",
    label: hookName ? `${subtype} · ${hookName}` : subtype,
    timestamp,
    blocks,
    line,
    isSidechain: bool(value, "isSidechain"),
  });
}
