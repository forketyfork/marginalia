import { emptyCounts } from "../shared/annotation";
import { preview } from "../shared/format";
import type { SessionSummary, Transcript } from "../shared/model";
import { textOfEntry } from "../shared/model";

export interface IndexedSession extends Omit<SessionSummary, "annotations" | "unresolved"> {
  /** Lower-cased haystack for substring search: title, cwd, branch, and every user prompt. */
  searchCorpus: string;
}

export function summarize(t: Transcript, updatedAt: number): IndexedSession {
  const prompts = t.entries.filter((e) => e.kind === "user").map(textOfEntry);
  const firstPrompt = prompts[0] ?? "";
  const corpusParts = [t.title, t.cwd ?? "", t.info.gitBranch ?? "", t.id, ...prompts];
  return {
    agent: t.agent,
    id: t.id,
    path: t.path,
    cwd: t.cwd,
    gitBranch: t.info.gitBranch,
    title: t.title,
    firstPrompt: preview(firstPrompt, 240),
    startedAt: t.startedAt,
    updatedAt,
    model: t.info.models[0] ?? null,
    version: t.info.versions[t.info.versions.length - 1] ?? null,
    userMessages: t.info.counts.user,
    assistantMessages: t.info.counts.assistant,
    toolCalls: t.info.counts.toolCalls,
    costUsd: t.info.costUsd,
    subagents: t.subagents.length,
    subagent: t.info.extra.subagent ?? null,
    parentId: t.info.extra.parentSession ?? null,
    source: t.source,
    missingSince: t.missingSince,
    searchCorpus: corpusParts.join("\n").toLowerCase(),
  };
}

export function withCounts(s: IndexedSession): SessionSummary {
  const { searchCorpus: _corpus, ...rest } = s;
  return { ...rest, annotations: emptyCounts(), unresolved: 0 };
}
