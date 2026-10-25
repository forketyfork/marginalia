import { preview } from "../shared/format";
import type { Block, Entry, Transcript } from "../shared/model";
import { TranscriptBuilder } from "./builder";
import { arr, isObject, type JsonObject, num, obj, parseTimestamp, prettyJson, str } from "./json";
import { parseJsonl } from "./jsonl";

export interface CodexOptions {
  path: string;
  /** Used when the file has no session_meta line (legacy 2025 rollouts); taken from the file name. */
  fallbackId: string;
}

const WRAPPER_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "# AGENTS.md instructions for ",
  "<permissions instructions>",
];

function isWrapperEnvelope(text: string): boolean {
  const stripped = text.trim();
  return WRAPPER_PREFIXES.some((p) => stripped.startsWith(p));
}

/**
 * Codex rollouts come in two shapes: the current one wraps every item in `{type, payload}`
 * (`session_meta`, `response_item`, `event_msg`, `turn_context`), the 2025 one writes the
 * response items at the top level after a header line. Both are handled by unwrapping `payload`
 * when present and treating the line itself as the item otherwise.
 */
export function parseCodex(text: string, opts: CodexOptions): Transcript {
  const parsed = parseJsonl(text);
  let sessionId = opts.fallbackId;
  for (const { value } of parsed.lines) {
    if (str(value, "type") === "session_meta") {
      const payload = obj(value, "payload");
      sessionId = (payload && (str(payload, "id") ?? str(payload, "session_id"))) ?? sessionId;
      break;
    }
    if (str(value, "type") === null && str(value, "id") && str(value, "instructions") !== null) {
      sessionId = str(value, "id") ?? sessionId;
      break;
    }
  }

  const b = new TranscriptBuilder("codex", sessionId, opts.path);
  b.malformedLines = parsed.malformed;
  let model: string | null = null;
  let firstPrompt: string | null = null;
  const state: { current: Entry | null } = { current: null };

  const appendToAssistant = (block: Block, line: number, timestamp: number | null, forceNew = false) => {
    if (state.current && b.last() === state.current && !forceNew) {
      b.appendBlocks(state.current, [block]);
      b.touch(timestamp);
      return;
    }
    state.current = b.add({ id: `L${line}`, kind: "assistant", timestamp, blocks: [block], line, model });
  };

  for (const { line, value } of parsed.lines) {
    const timestamp = parseTimestamp(value.timestamp);
    const type = str(value, "type");

    if (type === "session_meta") {
      noteSessionMeta(b, obj(value, "payload"));
      continue;
    }
    if (type === "turn_context") {
      const payload = obj(value, "payload");
      if (payload) {
        model = str(payload, "model") ?? model;
        if (model) b.models.add(model);
        noteTurnContext(b, payload);
      }
      continue;
    }
    if (type === "event_msg") {
      state.current = handleEvent(b, obj(value, "payload"), line, timestamp) ? null : state.current;
      continue;
    }
    if (type === null) {
      if (str(value, "record_type") !== null) {
        b.skip("state");
        continue;
      }
      if (str(value, "id") && str(value, "instructions") !== null) {
        b.touch(parseTimestamp(value.timestamp));
        const instructions = str(value, "instructions");
        if (instructions) {
          b.add({
            id: `L${line}`,
            kind: "meta",
            label: "instructions",
            timestamp,
            blocks: [{ type: "text", text: instructions }],
            line,
          });
        }
        continue;
      }
    }

    const item = type === "response_item" ? obj(value, "payload") : value;
    if (!item) {
      b.skip("response_item:no-payload");
      continue;
    }
    const itemType = str(item, "type");
    switch (itemType) {
      case "message": {
        const role = str(item, "role") ?? "user";
        const text = messageText(arr(item, "content"));
        if (role === "assistant") {
          if (text.length > 0) appendToAssistant({ type: "text", text }, line, timestamp);
          break;
        }
        state.current = null;
        if (text.length === 0) break;
        const wrapper = role !== "user" || isWrapperEnvelope(text);
        b.add({
          id: `L${line}`,
          kind: wrapper ? "meta" : "user",
          label: wrapper ? role : null,
          timestamp,
          blocks: [{ type: "text", text }],
          line,
        });
        if (!wrapper && firstPrompt === null) firstPrompt = text;
        break;
      }
      case "reasoning": {
        const text = reasoningText(item);
        if (text.length === 0) {
          b.skip("reasoning:encrypted-only");
          break;
        }
        const startNew = state.current?.blocks.some((bl) => bl.type !== "thinking") ?? false;
        appendToAssistant({ type: "thinking", text }, line, timestamp, startNew);
        break;
      }
      case "function_call":
        appendToAssistant(
          {
            type: "tool_use",
            id: str(item, "call_id") ?? `call-L${line}`,
            name: str(item, "name") ?? "function",
            input: parseArguments(item.arguments),
          },
          line,
          timestamp,
        );
        break;
      case "custom_tool_call":
        appendToAssistant(
          {
            type: "tool_use",
            id: str(item, "call_id") ?? `call-L${line}`,
            name: str(item, "name") ?? "custom_tool",
            input: { input: item.input ?? null },
          },
          line,
          timestamp,
        );
        break;
      case "local_shell_call":
        appendToAssistant(
          {
            type: "tool_use",
            id: str(item, "call_id") ?? `call-L${line}`,
            name: "local_shell",
            input: item.action ?? null,
          },
          line,
          timestamp,
        );
        break;
      case "web_search_call":
        appendToAssistant(
          {
            type: "tool_use",
            id: str(item, "id") ?? `search-L${line}`,
            name: "web_search",
            input: item.action ?? null,
          },
          line,
          timestamp,
        );
        break;
      case "tool_search_call":
        appendToAssistant(
          {
            type: "tool_use",
            id: str(item, "call_id") ?? `call-L${line}`,
            name: "tool_search",
            input: item.arguments ?? null,
          },
          line,
          timestamp,
        );
        break;
      case "tool_search_output": {
        state.current = null;
        const tools = arr(item, "tools") ?? [];
        const names = tools.filter(isObject).map((t) => str(t, "name") ?? "?");
        const text = names.length > 0 ? `Found tools: ${names.join(", ")}` : "No tools found";
        b.add({
          id: `L${line}`,
          kind: "tool_result",
          timestamp,
          blocks: [
            {
              type: "tool_result",
              toolUseId: str(item, "call_id") ?? "",
              text,
              isError: false,
              images: [],
              details: { tools },
              truncated: false,
              fullLength: text.length,
            },
          ],
          line,
        });
        break;
      }
      case "agent_message": {
        state.current = null;
        const text = messageText(arr(item, "content"));
        const route = [str(item, "author"), str(item, "recipient")].filter(Boolean).join(" → ");
        b.add({
          id: `L${line}`,
          kind: "meta",
          label: route ? `agent message ${route}` : "agent message",
          timestamp,
          blocks: text.length > 0 ? [{ type: "text", text }] : [],
          line,
        });
        break;
      }
      case "compacted": {
        state.current = null;
        const text = str(item, "message") ?? str(item, "summary") ?? prettyJson(item);
        b.add({
          id: `L${line}`,
          kind: "compact",
          label: "compacted",
          timestamp,
          blocks: [{ type: "text", text }],
          line,
        });
        break;
      }
      case "additional_tools":
      case "world_state": {
        state.current = null;
        const json = prettyJson(item);
        b.add({
          id: `L${line}`,
          kind: "attachment",
          label: itemType,
          timestamp,
          blocks: [{ type: "data", label: itemType, text: json, truncated: false, fullLength: json.length }],
          line,
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        state.current = null;
        b.add({
          id: `L${line}`,
          kind: "tool_result",
          timestamp,
          blocks: [toolOutputBlock(item)],
          line,
        });
        break;
      }
      default:
        b.skip(itemType ? `item:${itemType}` : "item:untyped");
    }
  }

  b.title = firstPrompt ? preview(firstPrompt, 120) : null;
  return b.build();
}

function noteSessionMeta(b: TranscriptBuilder, payload: JsonObject | null): void {
  if (!payload) return;
  b.cwd = str(payload, "cwd") ?? b.cwd;
  b.touch(parseTimestamp(payload.timestamp));
  const version = str(payload, "cli_version");
  if (version) b.versions.add(version);
  for (const key of ["originator", "model_provider"]) {
    const v = str(payload, key);
    if (v) b.extra[key] = v;
  }
  noteSource(b, payload.source);
  const git = obj(payload, "git");
  if (git) {
    b.gitBranch = str(git, "branch") ?? b.gitBranch;
    const repo = str(git, "repository_url");
    if (repo) b.extra.repository = repo;
    const commit = str(git, "commit_hash");
    if (commit) b.extra.commit = commit;
  }
}

function noteTurnContext(b: TranscriptBuilder, payload: JsonObject): void {
  const effort = str(payload, "effort");
  if (effort) b.extra.effort = effort;
  const approval = str(payload, "approval_policy");
  if (approval) b.permissionMode = approval;
  const sandbox = obj(payload, "sandbox_policy");
  const sandboxType = sandbox ? str(sandbox, "type") : null;
  if (sandboxType) b.extra.sandbox = sandboxType;
  if (b.cwd === null) b.cwd = str(payload, "cwd");
}

/** Returns true when the event ends the current assistant grouping. */
function handleEvent(
  b: TranscriptBuilder,
  payload: JsonObject | null,
  line: number,
  timestamp: number | null,
): boolean {
  if (!payload) return false;
  const eventType = str(payload, "type") ?? "event";
  switch (eventType) {
    case "token_count": {
      const info = obj(payload, "info");
      const total = info ? obj(info, "total_token_usage") : null;
      if (total) {
        b.totalTokens = {
          input: num(total, "input_tokens") ?? 0,
          output: num(total, "output_tokens") ?? 0,
          cacheRead: num(total, "cached_input_tokens") ?? 0,
          cacheCreation: 0,
          thinking: num(total, "reasoning_output_tokens") ?? 0,
        };
      }
      return false;
    }
    case "turn_aborted":
      b.add({
        id: `L${line}`,
        kind: "system",
        label: "turn_aborted",
        level: "warning",
        timestamp,
        blocks: [{ type: "text", text: `Turn aborted (${str(payload, "reason") ?? "unknown reason"})` }],
        line,
      });
      return true;
    case "task_started":
    case "task_complete":
    case "item_completed":
    case "agent_message":
    case "agent_reasoning":
    case "user_message":
      b.skip(`event:${eventType}`);
      return false;
    default:
      b.skip(`event:${eventType}`);
      return false;
  }
}

function messageText(content: unknown[] | null): string {
  if (!content) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    const text = str(part, "text");
    if (text !== null) texts.push(text);
    else if (str(part, "type") === "encrypted_content") texts.push("(encrypted content)");
    else texts.push(prettyJson(part));
  }
  return texts.join("\n");
}

function reasoningText(item: JsonObject): string {
  const texts: string[] = [];
  for (const key of ["summary", "content"]) {
    const parts = arr(item, key);
    if (!parts) continue;
    for (const part of parts) {
      if (!isObject(part)) continue;
      const text = str(part, "text");
      if (text && text.length > 0) texts.push(text);
    }
  }
  return texts.join("\n\n");
}

function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

const EXIT_CODE_RE = /^Exit code: (\d+)/;

function toolOutputBlock(item: JsonObject): Block {
  const callId = str(item, "call_id") ?? "";
  const raw = item.output;
  let text = typeof raw === "string" ? raw : prettyJson(raw ?? "");
  let details: unknown = null;
  let isError = false;
  if (text.startsWith("{")) {
    try {
      const envelope = JSON.parse(text);
      if (isObject(envelope) && typeof envelope.output === "string") {
        text = envelope.output;
        details = envelope.metadata ?? null;
        const meta = obj(envelope, "metadata");
        const exit = meta ? num(meta, "exit_code") : null;
        isError = exit !== null && exit !== 0;
      }
    } catch {
      // Plain text that happens to start with a brace; keep it as is.
    }
  }
  const exitMatch = EXIT_CODE_RE.exec(text);
  if (exitMatch) isError = exitMatch[1] !== "0";
  return {
    type: "tool_result",
    toolUseId: callId,
    text,
    isError,
    images: [],
    details,
    truncated: false,
    fullLength: text.length,
  };
}

/**
 * `source` is a plain string for top-level sessions ("cli", "exec", "vscode") and an object for
 * sub-sessions: `{subagent: "review"}`, `{subagent: {other: "guardian"}}`, or
 * `{subagent: {thread_spawn: {parent_thread_id, agent_nickname, ...}}}`.
 */
function noteSource(b: TranscriptBuilder, source: unknown): void {
  if (typeof source === "string") {
    b.extra.source = source;
    return;
  }
  if (!isObject(source)) return;
  const sub = source.subagent;
  if (typeof sub === "string") {
    b.extra.subagent = sub;
    return;
  }
  if (!isObject(sub)) return;
  const other = str(sub, "other");
  if (other) {
    b.extra.subagent = other;
    return;
  }
  const spawn = obj(sub, "thread_spawn");
  if (spawn) {
    const nickname = str(spawn, "agent_nickname");
    b.extra.subagent = nickname ? `spawn:${nickname}` : "spawn";
    const parent = str(spawn, "parent_thread_id");
    if (parent) b.extra.parentSession = parent;
    return;
  }
  b.extra.subagent = Object.keys(sub)[0] ?? "subagent";
}
