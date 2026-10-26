import type { AnnotationCounts } from "./annotation";

export type Agent = "claude" | "cowork" | "codex" | "gemini";

export const AGENTS: readonly Agent[] = ["claude", "cowork", "codex", "gemini"];

export const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  cowork: "Cowork",
  codex: "Codex",
  gemini: "Gemini CLI",
};

export function isAgent(value: unknown): value is Agent {
  return typeof value === "string" && (AGENTS as readonly string[]).includes(value);
}

export interface ImageRef {
  mediaType: string;
  /** Base64 payload; null when the image was too large to embed in the transcript payload. */
  data: string | null;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
}

export type Block =
  | { type: "text"; text: string; truncated?: boolean; fullLength?: number }
  | { type: "thinking"; text: string; truncated?: boolean; fullLength?: number }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      text: string;
      isError: boolean;
      images: ImageRef[];
      /** Agent-specific structured result (Claude's `toolUseResult`, Codex output metadata). */
      details: unknown;
      truncated: boolean;
      fullLength: number;
    }
  | { type: "image"; image: ImageRef }
  /** Raw structured context that is not a conversation message (attachments, hook output, system details). */
  | { type: "data"; label: string; text: string; truncated: boolean; fullLength: number };

export type EntryKind =
  | "user"
  | "assistant"
  | "tool_result"
  | "system"
  | "meta"
  | "attachment"
  | "compact"
  | "command";

export interface Entry {
  /** Stable id within the transcript: the line uuid for Claude and Gemini, `L<line>` for Codex. */
  id: string;
  parentId: string | null;
  kind: EntryKind;
  /** Unix milliseconds. */
  timestamp: number | null;
  /** 1-based index of the user prompt this entry belongs to; 0 before the first prompt. */
  turn: number;
  blocks: Block[];
  /** 1-based line number of the first source line that produced this entry. */
  line: number;
  label: string | null;
  level: string | null;
  model: string | null;
  usage: Usage | null;
  stopReason: string | null;
  thinkingMs: number | null;
  isSidechain: boolean;
}

export type SessionSource = "file" | "history" | "store";

export const SOURCE_LABEL: Record<SessionSource, string> = {
  file: "",
  history: "prompts only",
  store: "legacy store",
};

export interface SubagentRef {
  agentId: string;
  description: string | null;
  toolUseId: string | null;
  available: boolean;
  /** Set when the subagent is an indexed session of its own (Codex spawned threads) rather than a nested file. */
  sessionId: string | null;
}

export interface TranscriptCounts {
  user: number;
  assistant: number;
  toolCalls: number;
  toolErrors: number;
  thinking: number;
  turns: number;
  malformedLines: number;
  skippedLines: Record<string, number>;
}

export interface TranscriptInfo {
  models: string[];
  versions: string[];
  costUsd: number | null;
  totalTokens: Usage | null;
  prLinks: string[];
  permissionMode: string | null;
  gitBranch: string | null;
  counts: TranscriptCounts;
  toolNames: Record<string, number>;
  /** Agent-specific scalar facts (Codex originator, sandbox policy, Gemini project hash, ...). */
  extra: Record<string, string>;
}

export interface Transcript {
  agent: Agent;
  id: string;
  path: string;
  /** Set when this transcript is a Claude subagent transcript nested under a session. */
  agentId: string | null;
  cwd: string | null;
  title: string;
  startedAt: number | null;
  endedAt: number | null;
  info: TranscriptInfo;
  entries: Entry[];
  subagents: SubagentRef[];
  /** Where the bytes came from: the agent's own file, or a reconstruction (prompt history, legacy store). */
  source: SessionSource;
  /** Set when the agent's original file is gone and the transcript is served from Marginalia's archived copy. */
  missingSince: number | null;
}

export interface SessionSummary {
  agent: Agent;
  id: string;
  path: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  firstPrompt: string;
  startedAt: number | null;
  /** File mtime in unix milliseconds. */
  updatedAt: number;
  model: string | null;
  version: string | null;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  costUsd: number | null;
  subagents: number;
  /** Kind of sub-session (Codex guardian, review, spawned thread); null for top-level sessions. */
  subagent: string | null;
  parentId: string | null;
  source: SessionSource;
  missingSince: number | null;
  annotations: AnnotationCounts;
  unresolved: number;
}

export interface CatalogStatus {
  indexing: boolean;
  done: number;
  total: number;
  sessions: number;
  lastRefreshAt: number | null;
  errors: number;
  /** Sessions whose original file is gone; they stay listed and readable from the archive. */
  missing: number;
}

export function textOfBlock(block: Block): string {
  switch (block.type) {
    case "text":
    case "thinking":
    case "data":
    case "tool_result":
      return block.text;
    case "tool_use":
      return typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2);
    case "image":
      return "";
  }
}

export function textOfEntry(entry: Entry): string {
  return entry.blocks
    .map(textOfBlock)
    .filter((t) => t.length > 0)
    .join("\n\n");
}
