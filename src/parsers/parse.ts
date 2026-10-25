import { basename } from "node:path";
import type { Agent, Block, Transcript } from "../shared/model";
import { parseClaude } from "./claude";
import { parseCodex } from "./codex";
import { parseGemini } from "./gemini";

export interface ParseContext {
  path: string;
  geminiProjects: ReadonlyMap<string, string>;
  /** Claude subagent id when parsing a `subagents/agent-<id>.jsonl` file. */
  agentId?: string | null;
}

const CODEX_FILE_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseTranscript(agent: Agent, text: string, ctx: ParseContext): Transcript {
  const stem = basename(ctx.path).replace(/\.jsonl(\.zst)?$/, "");
  switch (agent) {
    case "claude": {
      const id = ctx.agentId ? stem.replace(/^agent-/, "") : stem;
      return parseClaude(text, { path: ctx.path, id, agentId: ctx.agentId ?? null });
    }
    case "codex":
      return parseCodex(text, { path: ctx.path, fallbackId: CODEX_FILE_ID_RE.exec(stem)?.[1] ?? stem });
    case "gemini":
      return parseGemini(text, { path: ctx.path, fallbackId: stem, projects: ctx.geminiProjects });
  }
}

export const TRANSPORT_LIMITS = {
  text: 64_000,
  thinking: 64_000,
  toolResult: 24_000,
  data: 16_000,
} as const;

/** Returns a copy with oversized blocks cut down; the full block stays available through the block endpoint. */
export function forTransport(transcript: Transcript): Transcript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => ({ ...entry, blocks: entry.blocks.map(truncateBlock) })),
  };
}

function truncateBlock(block: Block): Block {
  switch (block.type) {
    case "text":
    case "thinking": {
      const limit = TRANSPORT_LIMITS[block.type];
      if (block.text.length <= limit) return block;
      return { ...block, text: block.text.slice(0, limit), truncated: true, fullLength: block.text.length };
    }
    case "tool_result":
      if (block.text.length <= TRANSPORT_LIMITS.toolResult) return block;
      return {
        ...block,
        text: block.text.slice(0, TRANSPORT_LIMITS.toolResult),
        truncated: true,
        fullLength: block.text.length,
      };
    case "data":
      if (block.text.length <= TRANSPORT_LIMITS.data) return block;
      return {
        ...block,
        text: block.text.slice(0, TRANSPORT_LIMITS.data),
        truncated: true,
        fullLength: block.text.length,
      };
    default:
      return block;
  }
}
