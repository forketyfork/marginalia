import { Database } from "bun:sqlite";
import { isObject } from "../parsers/json";

/**
 * Before JSONL transcripts (spring 2025) Claude Code kept messages in `~/.claude/__store.db`.
 * Each session is rendered back into today's JSONL shape so the regular Claude parser reads it.
 */
export interface LegacyStoreSession {
  id: string;
  cwd: string | null;
  startedAt: number;
  jsonl: string;
}

interface Row {
  uuid: string;
  parent_uuid: string | null;
  session_id: string;
  timestamp: number | string | null;
  message_type: string;
  cwd: string | null;
  version: string | null;
  isSidechain: number | null;
  u_message: string | null;
  tool_use_result: string | null;
  is_meta: number | null;
  a_message: string | null;
  model: string | null;
  is_api_error_message: number | null;
}

export function readLegacyStore(path: string): LegacyStoreSession[] {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<Row, []>(`
        SELECT b.uuid, b.parent_uuid, b.session_id, b.timestamp, b.message_type, b.cwd, b.version, b.isSidechain,
               u.message AS u_message, u.tool_use_result, u.is_meta,
               a.message AS a_message, a.model, a.is_api_error_message
        FROM base_messages b
        LEFT JOIN user_messages u ON u.uuid = b.uuid
        LEFT JOIN assistant_messages a ON a.uuid = b.uuid
        ORDER BY b.timestamp, b.rowid
      `)
      .all();
    const sessions = new Map<string, { cwd: string | null; startedAt: number; lines: string[] }>();
    for (const row of rows) {
      const ms = toMillis(row.timestamp);
      const session = sessions.get(row.session_id) ?? { cwd: row.cwd, startedAt: ms, lines: [] };
      if (row.cwd && !session.cwd) session.cwd = row.cwd;
      session.lines.push(JSON.stringify(toLine(row, ms)));
      sessions.set(row.session_id, session);
    }
    return [...sessions.entries()].map(([id, s]) => ({
      id,
      cwd: s.cwd,
      startedAt: s.startedAt,
      jsonl: `${s.lines.join("\n")}\n`,
    }));
  } finally {
    db.close();
  }
}

function toMillis(value: number | string | null): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toLine(row: Row, ms: number): Record<string, unknown> {
  const isUser = row.message_type === "user";
  const rawMessage = parseJson(isUser ? row.u_message : row.a_message);
  const message = isObject(rawMessage)
    ? normalizeMessage(rawMessage, isUser)
    : { role: isUser ? "user" : "assistant", content: String(rawMessage ?? "") };
  if (!isUser && row.model && !message.model) message.model = row.model;
  const line: Record<string, unknown> = {
    type: isUser ? "user" : "assistant",
    uuid: row.uuid,
    parentUuid: row.parent_uuid,
    sessionId: row.session_id,
    timestamp: new Date(ms).toISOString(),
    cwd: row.cwd,
    version: row.version,
    isSidechain: row.isSidechain === 1,
    message,
  };
  if (isUser) {
    if (row.is_meta === 1) line.isMeta = true;
    const result = parseJson(row.tool_use_result);
    if (result !== null) line.toolUseResult = result;
  } else if (row.is_api_error_message === 1) {
    line.isApiErrorMessage = true;
  }
  return line;
}

/** Early tool-result parts carried `tool_use_id` and nested `content` but no `type`. */
function normalizeMessage(message: Record<string, unknown>, isUser: boolean): Record<string, unknown> {
  const content = message.content;
  if (isUser && Array.isArray(content)) {
    message.content = content.map((part) =>
      isObject(part) && part.type === undefined && typeof part.tool_use_id === "string"
        ? { ...part, type: "tool_result" }
        : part,
    );
  }
  return message;
}
