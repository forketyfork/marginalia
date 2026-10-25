import { describe, expect, test } from "bun:test";
import { forTransport, TRANSPORT_LIMITS } from "../../src/parsers/parse";
import type { Transcript } from "../../src/shared/model";

describe("forTransport", () => {
  test("truncates oversized blocks and leaves the original untouched", () => {
    const big = "x".repeat(TRANSPORT_LIMITS.toolResult + 10);
    const transcript: Transcript = {
      agent: "claude",
      id: "s",
      path: "/p",
      agentId: null,
      cwd: null,
      title: "t",
      startedAt: null,
      endedAt: null,
      info: {
        models: [],
        versions: [],
        costUsd: null,
        totalTokens: null,
        prLinks: [],
        permissionMode: null,
        gitBranch: null,
        counts: {
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolErrors: 0,
          thinking: 0,
          turns: 0,
          malformedLines: 0,
          skippedLines: {},
        },
        toolNames: {},
        extra: {},
      },
      entries: [
        {
          id: "e",
          parentId: null,
          kind: "tool_result",
          timestamp: null,
          turn: 0,
          line: 1,
          label: null,
          level: null,
          model: null,
          usage: null,
          stopReason: null,
          thinkingMs: null,
          isSidechain: false,
          blocks: [
            {
              type: "tool_result",
              toolUseId: "t",
              text: big,
              isError: false,
              images: [],
              details: null,
              truncated: false,
              fullLength: big.length,
            },
            { type: "text", text: "short" },
          ],
        },
      ],
      subagents: [],
      source: "file",
      missingSince: null,
    };
    const out = forTransport(transcript);
    const block = out.entries[0]?.blocks[0];
    expect(block?.type === "tool_result" && block.truncated).toBe(true);
    expect(block?.type === "tool_result" ? block.text.length : 0).toBe(TRANSPORT_LIMITS.toolResult);
    expect(block?.type === "tool_result" ? block.fullLength : 0).toBe(big.length);
    expect(out.entries[0]?.blocks[1]).toEqual({ type: "text", text: "short" });
    const original = transcript.entries[0]?.blocks[0];
    expect(original?.type === "tool_result" ? original.text.length : 0).toBe(big.length);
  });
});
