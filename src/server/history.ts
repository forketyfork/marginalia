import { isObject, str } from "../parsers/json";
import { parseJsonl } from "../parsers/jsonl";

/**
 * `~/.claude/history.jsonl` outlives transcripts: Claude Code appends every prompt there and never
 * cleans it up. Since 2025-10-31 each line carries a `sessionId`; older lines only have the project
 * and a timestamp, so those are grouped per project and day.
 */
export interface HistoryEntry {
  display: string;
  pasted: string[];
  project: string | null;
  timestamp: number;
  sessionId: string | null;
}

export interface HistoryGroup {
  id: string;
  project: string | null;
  /** True when the entries had no session id and were grouped by project and calendar day. */
  dayGroup: boolean;
  entries: HistoryEntry[];
}

export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const { value } of parseJsonl(text).lines) {
    const display = str(value, "display");
    const timestamp = typeof value.timestamp === "number" ? value.timestamp : null;
    if (display === null || timestamp === null) continue;
    const pasted: string[] = [];
    if (isObject(value.pastedContents)) {
      for (const item of Object.values(value.pastedContents)) {
        if (isObject(item) && typeof item.content === "string" && item.content.length > 0)
          pasted.push(item.content);
      }
    }
    entries.push({
      display,
      pasted,
      project: str(value, "project"),
      timestamp: timestamp < 1e12 ? timestamp * 1000 : timestamp,
      sessionId: str(value, "sessionId"),
    });
  }
  return entries;
}

/** A prompt that is only a slash command. Commands with arguments (`/implement …`) carry intent and stay prompts. */
const BARE_COMMAND = /^(\/[\w:.-]+)\s*$/;

export function isBareCommand(display: string): boolean {
  return BARE_COMMAND.test(display);
}

/** True when at least one entry is a real prompt rather than a bare slash command. */
export function hasRealPrompt(group: HistoryGroup): boolean {
  return group.entries.some((e) => !isBareCommand(e.display));
}

const pad = (n: number) => String(n).padStart(2, "0");

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayGroupId(project: string | null, day: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(`${project ?? ""}|${day}`).digest("hex");
  return `hist-${hash.slice(0, 16)}`;
}

export function groupHistory(entries: HistoryEntry[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    const id = entry.sessionId ?? dayGroupId(entry.project, localDay(entry.timestamp));
    const group = groups.get(id) ?? {
      id,
      project: entry.project,
      dayGroup: entry.sessionId === null,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Renders a group as Claude Code JSONL so the regular Claude parser can read it. */
export function historyToClaudeJsonl(group: HistoryGroup, origin = "~/.claude/history.jsonl"): string {
  const first = group.entries[0];
  if (!first) return "";
  const iso = (ms: number) => new Date(ms).toISOString();
  const envelope = { sessionId: group.id, cwd: group.project, isSidechain: false, userType: "external" };
  const notice = group.dayGroup
    ? `Transcript no longer on disk. These ${group.entries.length} prompts were recovered from ${origin}; they predate session ids there, so this groups one project's prompts for ${localDay(first.timestamp)} and may span several sessions.`
    : `Transcript no longer on disk (Claude Code deletes transcripts after its retention period). These ${group.entries.length} prompts were recovered from ${origin}; assistant replies and tool calls are lost.`;
  const lines: string[] = [
    JSON.stringify({
      type: "system",
      subtype: "informational",
      level: "notice",
      content: notice,
      uuid: "h0",
      parentUuid: null,
      timestamp: iso(first.timestamp),
      isMeta: false,
      ...envelope,
    }),
  ];
  let parent = "h0";
  group.entries.forEach((entry, i) => {
    const uuid = `h${i + 1}`;
    const command = BARE_COMMAND.exec(entry.display);
    const content = command
      ? `<command-name>${command[1]}</command-name>\n<command-args></command-args>`
      : entry.pasted.length === 0
        ? entry.display
        : [
            { type: "text", text: entry.display },
            ...entry.pasted.map((p, j) => ({ type: "text", text: `[Pasted content ${j + 1}]\n${p}` })),
          ];
    lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        parentUuid: parent,
        timestamp: iso(entry.timestamp),
        message: { role: "user", content },
        ...envelope,
      }),
    );
    parent = uuid;
  });
  return `${lines.join("\n")}\n`;
}
