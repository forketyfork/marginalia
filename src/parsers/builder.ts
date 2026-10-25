import type { Agent, Block, Entry, EntryKind, SubagentRef, Transcript, Usage } from "../shared/model";

export interface EntryInit {
  id: string;
  parentId?: string | null;
  kind: EntryKind;
  timestamp?: number | null;
  blocks: Block[];
  line: number;
  label?: string | null;
  level?: string | null;
  model?: string | null;
  usage?: Usage | null;
  stopReason?: string | null;
  thinkingMs?: number | null;
  isSidechain?: boolean;
}

export class TranscriptBuilder {
  readonly entries: Entry[] = [];
  readonly subagents = new Map<string, SubagentRef>();
  readonly models = new Set<string>();
  readonly versions = new Set<string>();
  readonly prLinks = new Set<string>();
  readonly toolNames = new Map<string, number>();
  readonly skipped = new Map<string, number>();
  readonly extra: Record<string, string> = {};
  agentId: string | null = null;
  title: string | null = null;
  cwd: string | null = null;
  gitBranch: string | null = null;
  permissionMode: string | null = null;
  costUsd: number | null = null;
  totalTokens: Usage | null = null;
  startedAt: number | null = null;
  endedAt: number | null = null;
  malformedLines = 0;
  private turn = 0;
  private toolErrors = 0;
  private thinkingBlocks = 0;

  constructor(
    readonly agent: Agent,
    readonly id: string,
    readonly path: string,
  ) {}

  add(init: EntryInit): Entry {
    if (init.kind === "user") this.turn += 1;
    const entry: Entry = {
      id: init.id,
      parentId: init.parentId ?? null,
      kind: init.kind,
      timestamp: init.timestamp ?? null,
      turn: this.turn,
      blocks: [],
      line: init.line,
      label: init.label ?? null,
      level: init.level ?? null,
      model: init.model ?? null,
      usage: init.usage ?? null,
      stopReason: init.stopReason ?? null,
      thinkingMs: init.thinkingMs ?? null,
      isSidechain: init.isSidechain ?? false,
    };
    this.touch(entry.timestamp);
    if (entry.model) this.models.add(entry.model);
    this.entries.push(entry);
    this.appendBlocks(entry, init.blocks);
    return entry;
  }

  appendBlocks(entry: Entry, blocks: Block[]): void {
    for (const block of blocks) {
      entry.blocks.push(block);
      if (block.type === "tool_use") {
        this.toolNames.set(block.name, (this.toolNames.get(block.name) ?? 0) + 1);
      } else if (block.type === "tool_result" && block.isError) {
        this.toolErrors += 1;
      } else if (block.type === "thinking") {
        this.thinkingBlocks += 1;
      }
    }
  }

  last(): Entry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  touch(timestamp: number | null): void {
    if (timestamp === null) return;
    if (this.startedAt === null || timestamp < this.startedAt) this.startedAt = timestamp;
    if (this.endedAt === null || timestamp > this.endedAt) this.endedAt = timestamp;
  }

  skip(label: string, count = 1): void {
    this.skipped.set(label, (this.skipped.get(label) ?? 0) + count);
  }

  addSubagent(ref: Omit<SubagentRef, "available" | "sessionId"> & { sessionId?: string | null }): void {
    const existing = this.subagents.get(ref.agentId);
    if (existing) {
      if (!existing.description && ref.description) existing.description = ref.description;
      if (!existing.toolUseId && ref.toolUseId) existing.toolUseId = ref.toolUseId;
      return;
    }
    this.subagents.set(ref.agentId, { ...ref, sessionId: ref.sessionId ?? null, available: false });
  }

  build(): Transcript {
    let user = 0;
    let assistant = 0;
    let toolCalls = 0;
    for (const e of this.entries) {
      if (e.kind === "user") user += 1;
      else if (e.kind === "assistant") assistant += 1;
      for (const b of e.blocks) if (b.type === "tool_use") toolCalls += 1;
    }
    return {
      agent: this.agent,
      id: this.id,
      path: this.path,
      agentId: this.agentId,
      cwd: this.cwd,
      title: this.title ?? "(untitled)",
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      info: {
        models: [...this.models],
        versions: [...this.versions],
        costUsd: this.costUsd,
        totalTokens: this.totalTokens,
        prLinks: [...this.prLinks],
        permissionMode: this.permissionMode,
        gitBranch: this.gitBranch,
        counts: {
          user,
          assistant,
          toolCalls,
          toolErrors: this.toolErrors,
          thinking: this.thinkingBlocks,
          turns: this.turn,
          malformedLines: this.malformedLines,
          skippedLines: Object.fromEntries(this.skipped),
        },
        toolNames: Object.fromEntries(this.toolNames),
        extra: this.extra,
      },
      entries: this.entries,
      subagents: [...this.subagents.values()],
      source: "file",
      missingSince: null,
    };
  }
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
}
