import { formatCost, formatDuration, preview } from "../shared/format";
import type { Block, Transcript } from "../shared/model";
import { TranscriptBuilder } from "./builder";
import { type AssistantCursor, addAssistant, addUser, noteCost } from "./claude";
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

/**
 * Line Marginalia prepends when it stores a Cowork audit log together with the desktop app's
 * session sidecar (`{"type": "cowork_session", "sidecar": {...}}`).
 */
export const COWORK_HEADER_TYPE = "cowork_session";

/** Progress and heartbeat lines make up most of an audit log and carry no conversation. */
const SKIP_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['{"type":"system","subtype":"thinking_tokens"', "system:thinking_tokens"],
  ['{"type":"system","subtype":"status"', "system:status"],
  ['{"type":"rate_limit_event"', "rate_limit_event"],
  ['{"type":"tool_progress"', "tool_progress"],
  ['{"type":"command_lifecycle"', "command_lifecycle"],
];

export function classifyCoworkLine(line: string): string | null {
  for (const [prefix, label] of SKIP_PREFIXES) {
    if (line.startsWith(prefix)) return label;
  }
  return null;
}

/** System subtypes that only report progress; the same facts arrive through other lines. */
const SKIPPED_SYSTEM_SUBTYPES = new Set([
  "status",
  "thinking_tokens",
  "permission_check_status",
  "task_progress",
  "task_updated",
  "commands_changed",
]);

const ENVELOPE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "session_id",
  "timestamp",
  "_audit_timestamp",
  "_audit_hmac",
  "_audit_redactions",
  "parent_tool_use_id",
  "user_message_uuid",
  "user_message_uuids",
  "request_id",
]);

/** Sidecar fields that are either huge (prompts, MCP tool schemas) or repeated in the transcript. */
const BULKY_SIDECAR_KEYS = new Set([
  "systemPrompt",
  "remoteMcpServersConfig",
  "enabledMcpTools",
  "slashCommands",
  "coworkSyspromptMap",
  "spSectionPrompts",
  "spVariantPrompts",
  "systemPromptRendererAppends",
  "memoryGuidelinesTemplate",
  "initialMessage",
  "emailAddress",
  "accountName",
]);

const RESULT_DETAIL_KEYS = [
  "subtype",
  "stop_reason",
  "terminal_reason",
  "duration_api_ms",
  "permission_denials",
  "usage",
] as const;

export interface CoworkOptions {
  path: string;
}

export function parseCowork(text: string, opts: CoworkOptions): Transcript {
  const parsed = parseJsonl(text, classifyCoworkLine);
  const firstUser = parsed.lines.find(({ value }) => str(value, "type") === "user");
  const id = firstUser ? str(firstUser.value, "session_id") : null;
  if (id === null) throw new Error("Cowork audit log has no user line carrying a session_id");
  const b = new TranscriptBuilder("cowork", id, opts.path);
  b.malformedLines = parsed.malformed;
  for (const [label, count] of parsed.skipped) b.skip(label, count);

  let sidecar: JsonObject | null = null;
  let headerLine = 0;
  let firstPrompt: string | null = null;
  let cursor: AssistantCursor = null;
  let compactPending = false;
  const seenUserIds = new Set<string>();

  for (const { line, value } of parsed.lines) {
    const type = str(value, "type");
    if (type === null) {
      b.skip("untyped");
      continue;
    }
    const timestamp = parseTimestamp(value.timestamp ?? value._audit_timestamp);
    switch (type) {
      case COWORK_HEADER_TYPE:
        sidecar = obj(value, "sidecar");
        headerLine = line;
        if (sidecar) noteSidecar(b, sidecar, line);
        break;
      case "assistant":
        cursor = addAssistant(b, adapt(value), line, timestamp, cursor);
        break;
      case "user": {
        cursor = null;
        const uuid = str(value, "uuid");
        // Resuming a session replays earlier prompts into the log; only a replay of an unseen prompt is new.
        if (uuid !== null && bool(value, "isReplay") && seenUserIds.has(uuid)) {
          b.skip("user:replay");
          break;
        }
        if (uuid !== null) seenUserIds.add(uuid);
        const adapted = adapt(value);
        if (compactPending && !holdsToolResult(value)) {
          adapted.isCompactSummary = true;
          compactPending = false;
        }
        const entry = addUser(b, adapted, line, timestamp);
        if (entry.kind === "user" && firstPrompt === null) {
          firstPrompt = entry.blocks.find((bl) => bl.type === "text")?.text ?? null;
        }
        break;
      }
      case "system":
        cursor = null;
        if (str(value, "subtype") === "compact_boundary") compactPending = true;
        addSystem(b, value, line, timestamp);
        break;
      case "result":
        cursor = null;
        addResult(b, value, line, timestamp);
        break;
      case "tool_use_summary": {
        cursor = null;
        const summary = str(value, "summary");
        b.add({
          id: str(value, "uuid") ?? `L${line}`,
          kind: "system",
          label: "tool summary",
          timestamp,
          line,
          blocks: summary ? [{ type: "text", text: summary }] : [],
        });
        break;
      }
      default:
        b.skip(type);
    }
  }

  if (sidecar) noteSidecarError(b, sidecar, headerLine);
  b.title = (sidecar ? str(sidecar, "title") : null) ?? (firstPrompt ? preview(firstPrompt, 120) : null);
  return b.build();
}

/** Rewrites the Agent SDK envelope into the Claude Code field names the shared message handlers read. */
function adapt(value: JsonObject): JsonObject {
  return {
    ...value,
    parentUuid: null,
    isSidechain: typeof value.parent_tool_use_id === "string",
    isMeta: bool(value, "isSynthetic"),
    toolUseResult: value.tool_use_result,
    thinkingDurationMs: value.thinking_duration_ms,
  };
}

function holdsToolResult(value: JsonObject): boolean {
  const content = obj(value, "message")?.content;
  return Array.isArray(content) && content.some((p) => isObject(p) && str(p, "type") === "tool_result");
}

/**
 * The sidecar is where the app keeps what the audit log lacks: the title, the folders the user
 * granted (the log's `cwd` is a scratch directory), flags, and the rendered system prompt.
 */
function noteSidecar(b: TranscriptBuilder, sidecar: JsonObject, line: number): void {
  const folders = (arr(sidecar, "userSelectedFolders") ?? []).filter(
    (f): f is string => typeof f === "string",
  );
  b.cwd = folders[0] ?? null;
  if (folders.length > 1) b.extra.folders = folders.join(", ");
  const task = str(sidecar, "scheduledTaskId");
  if (task) b.extra.scheduledTask = task;
  const model = str(sidecar, "model");
  if (model) b.models.add(model);
  b.permissionMode = str(sidecar, "permissionMode");
  const createdAt = parseTimestamp(sidecar.createdAt);
  b.touch(parseTimestamp(sidecar.lastActivityAt));

  const facts = prettyJson(omitKeys(sidecar, BULKY_SIDECAR_KEYS));
  b.add({
    id: "cowork-session",
    kind: "attachment",
    label: "session",
    timestamp: createdAt,
    line,
    blocks: [{ type: "data", label: "session", text: facts, truncated: false, fullLength: facts.length }],
  });
  const systemPrompt = str(sidecar, "systemPrompt");
  if (systemPrompt) {
    b.add({
      id: "cowork-system-prompt",
      kind: "attachment",
      label: "system prompt",
      timestamp: createdAt,
      line,
      blocks: [{ type: "text", text: systemPrompt }],
    });
  }
}

function noteSidecarError(b: TranscriptBuilder, sidecar: JsonObject, line: number): void {
  const error = str(sidecar, "error");
  if (!error) return;
  b.add({
    id: "cowork-error",
    kind: "system",
    label: "error",
    level: "error",
    timestamp: parseTimestamp(sidecar.errorAt),
    line,
    blocks: [{ type: "text", text: error }],
  });
}

function addSystem(b: TranscriptBuilder, value: JsonObject, line: number, timestamp: number | null): void {
  const subtype = str(value, "subtype") ?? "system";
  if (SKIPPED_SYSTEM_SUBTYPES.has(subtype)) {
    b.skip(`system:${subtype}`);
    return;
  }
  const used = new Set(ENVELOPE_KEYS);
  const take = (key: string): string | null => {
    used.add(key);
    return str(value, key);
  };
  const takeNum = (key: string): number | null => {
    used.add(key);
    return num(value, key);
  };
  let label = subtype;
  let level: string | null = null;
  let text: string | null = null;

  switch (subtype) {
    case "init": {
      const version = take("claude_code_version");
      const model = take("model");
      const mode = take("permissionMode");
      if (version) b.versions.add(version);
      if (model) b.models.add(model);
      if (mode) b.permissionMode = mode;
      const servers = (arr(value, "mcp_servers") ?? []).filter(isObject).map((s) => str(s, "name") ?? "?");
      const tools = arr(value, "tools")?.length ?? 0;
      text = `Claude Code ${version ?? "?"} · ${model ?? "?"} · ${mode ?? "?"} permissions · ${tools} tools · MCP: ${servers.join(", ") || "none"}`;
      break;
    }
    case "permission_request":
      label = "permission request";
      text = take("tool_name") ?? "?";
      break;
    case "permission_response": {
      label = "permission response";
      used.add("granted");
      const granted = value.granted === true;
      text = `${take("tool_name") ?? "?"}: ${granted ? "granted" : "denied"} (${take("decision") ?? "?"})`;
      break;
    }
    case "permission_auto_approved": {
      label = "permission auto-approved";
      const task = take("scheduled_task_id");
      text = `${take("tool_name") ?? "?"}${task ? ` (scheduled task ${task})` : ""}`;
      break;
    }
    case "api_retry": {
      level = "warning";
      const attempt = takeNum("attempt");
      const max = takeNum("max_retries");
      const delay = takeNum("retry_delay_ms");
      const status = takeNum("error_status");
      text = `API retry ${attempt ?? "?"}/${max ?? "?"} in ${delay === null ? "?" : formatDuration(delay)}: ${take("error") ?? "unknown error"}${status === null ? "" : ` (HTTP ${status})`}`;
      break;
    }
    case "task_started":
      label = "task started";
      text = `${take("description") ?? "?"} (${take("subagent_type") ?? "agent"})`;
      break;
    case "task_notification": {
      label = "task finished";
      const status = take("status");
      const summary = take("summary");
      text = [status, summary].filter((s): s is string => s !== null).join(": ");
      break;
    }
    case "compact_boundary": {
      used.add("compact_metadata");
      const meta = obj(value, "compact_metadata");
      const trigger = meta ? str(meta, "trigger") : null;
      const pre = meta ? num(meta, "pre_tokens") : null;
      text = `Conversation compacted${trigger ? ` (${trigger})` : ""}${pre !== null ? `, ${pre.toLocaleString("en-US")} tokens before` : ""}`;
      break;
    }
    default:
      text = take("content");
  }

  const blocks: Block[] = [];
  if (text) blocks.push({ type: "text", text });
  const rest = omitKeys(value, used);
  if (Object.keys(rest).length > 0) {
    const json = prettyJson(rest);
    blocks.push({ type: "data", label: "details", text: json, truncated: false, fullLength: json.length });
  }
  b.add({ id: str(value, "uuid") ?? `L${line}`, kind: "system", label, level, timestamp, blocks, line });
}

/** One `result` line closes each turn; its cost and token totals are cumulative for the session. */
function addResult(b: TranscriptBuilder, value: JsonObject, line: number, timestamp: number | null): void {
  const isError = bool(value, "is_error");
  const duration = num(value, "duration_ms");
  const turns = num(value, "num_turns");
  const cost = num(value, "total_cost_usd");
  noteCost(b, { totalCostUSD: cost ?? undefined, modelUsage: value.modelUsage });

  const parts = [`Turn took ${duration === null ? "?" : formatDuration(duration)}`];
  if (turns !== null) parts.push(`${turns} API call${turns === 1 ? "" : "s"}`);
  if (cost !== null) parts.push(`${formatCost(cost)} so far`);
  const blocks: Block[] = [{ type: "text", text: parts.join(" · ") }];
  const result = str(value, "result");
  if (isError && result) blocks.push({ type: "text", text: result });
  const details: JsonObject = {};
  for (const key of RESULT_DETAIL_KEYS) {
    const v = value[key];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    details[key] = v;
  }
  if (Object.keys(details).length > 0) {
    const json = prettyJson(details);
    blocks.push({ type: "data", label: "details", text: json, truncated: false, fullLength: json.length });
  }
  b.add({
    id: str(value, "uuid") ?? `L${line}`,
    kind: "system",
    label: isError ? "turn failed" : "turn result",
    level: isError ? "error" : null,
    timestamp,
    blocks,
    line,
  });
}
