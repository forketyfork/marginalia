import { describe, expect, test } from "bun:test";
import { classifyClaudeLine, parseClaude } from "../../src/parsers/claude";
import { CLAUDE_SESSION_ID, CLAUDE_SESSION_PATH } from "../helpers";

const load = async () =>
  parseClaude(await Bun.file(CLAUDE_SESSION_PATH).text(), {
    path: CLAUDE_SESSION_PATH,
    id: CLAUDE_SESSION_ID,
  });

describe("parseClaude", () => {
  test("skips request logs before JSON parsing", () => {
    expect(classifyClaudeLine('{"type":"api-request","x":1}')).toBe("api-request");
    expect(classifyClaudeLine('{"type":"file-history-delta","x":1}')).toBe("file-history-delta");
    expect(classifyClaudeLine('{"type":"user","x":1}')).toBeNull();
  });

  test("groups streamed assistant lines of one API message into one entry", async () => {
    const t = await load();
    const first = t.entries.find((e) => e.id === "a1");
    expect(first?.kind).toBe("assistant");
    expect(first?.blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(first?.thinkingMs).toBe(1200);
    expect(first?.stopReason).toBe("tool_use");
    expect(first?.usage?.output).toBe(60);
    expect(t.entries.some((e) => e.id === "a2" || e.id === "a3")).toBe(false);
  });

  test("drops empty thinking blocks but keeps the thinking duration", async () => {
    const t = await load();
    const entry = t.entries.find((e) => e.id === "a5");
    expect(entry?.blocks.map((b) => b.type)).toEqual(["text"]);
    expect(entry?.thinkingMs).toBe(300);
  });

  test("classifies user lines into prompts, meta, compact summaries, and commands", async () => {
    const t = await load();
    const kinds = Object.fromEntries(
      t.entries.filter((e) => e.id.startsWith("u")).map((e) => [e.id, e.kind]),
    );
    expect(kinds).toEqual({ u0: "meta", u1: "user", u2: "compact", u3: "command", u4: "user" });
    expect(t.entries.find((e) => e.id === "u3")?.label).toBe("/clear");
    expect(t.info.counts.turns).toBe(2);
  });

  test("keeps tool results with structured details minus file copies", async () => {
    const t = await load();
    const result = t.entries.find((e) => e.id === "r1");
    expect(result?.kind).toBe("tool_result");
    const block = result?.blocks[0];
    if (block?.type !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.toolUseId).toBe("toolu_1");
    expect(block.text).toBe("README.md\nsrc");
    expect(block.isError).toBe(false);
    expect(block.details).toMatchObject({ stdout: "README.md\nsrc", interrupted: false });
    expect(block.details).not.toHaveProperty("originalFile");
  });

  test("records subagent references from Agent tool results", async () => {
    const t = await load();
    expect(t.subagents).toEqual([
      {
        agentId: "abc123def4567890a",
        description: "Explore repo",
        toolUseId: "toolu_2",
        available: false,
        sessionId: null,
      },
    ]);
    const errored = t.entries.find((e) => e.id === "r2")?.blocks[0];
    expect(errored?.type === "tool_result" && errored.isError).toBe(true);
    expect(t.info.counts.toolErrors).toBe(1);
  });

  test("extracts session facts and counts", async () => {
    const t = await load();
    expect(t.title).toBe("Repo file listing");
    expect(t.cwd).toBe("/Users/alice/dev/demo");
    expect(t.info.gitBranch).toBe("main");
    expect(t.info.versions).toEqual(["2.1.300"]);
    expect(t.info.models).toEqual(["claude-fable-5-1"]);
    expect(t.info.costUsd).toBe(0.42);
    expect(t.info.totalTokens).toEqual({
      input: 30,
      output: 170,
      cacheRead: 200,
      cacheCreation: 100,
      thinking: 27,
    });
    expect(t.info.prLinks).toEqual(["https://github.com/alice/demo/pull/7"]);
    expect(t.info.toolNames).toEqual({ Bash: 1, Agent: 1 });
    expect(t.info.counts.skippedLines).toEqual({ "api-request": 1, "file-history-snapshot": 1 });
    expect(t.info.counts.malformedLines).toBe(1);
    expect(t.startedAt).toBe(Date.parse("2026-10-20T10:00:00.500Z"));
    expect(t.endedAt).toBe(Date.parse("2026-10-20T10:00:15.000Z"));
  });

  test("renders system and attachment lines as auxiliary entries", async () => {
    const t = await load();
    const system = t.entries.find((e) => e.id === "s1");
    expect(system?.kind).toBe("system");
    expect(system?.label).toBe("turn_duration");
    expect(system?.blocks[0]).toMatchObject({ type: "text", text: "Turn took 10 s across 8 messages" });
    const attachment = t.entries.find((e) => e.id === "at1");
    expect(attachment?.kind).toBe("attachment");
    expect(attachment?.label).toBe("hook_success · SessionStart:startup");
    expect(attachment?.blocks).toEqual([
      { type: "data", label: "stdout", text: "hook ran", truncated: false, fullLength: 8 },
      expect.objectContaining({ type: "data", label: "hook_success" }),
    ]);
  });

  test("falls back to the first prompt as title and tags subagent transcripts", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "x",
      isSidechain: true,
      agentId: "abc",
      timestamp: "2026-10-20T10:00:00Z",
      message: { role: "user", content: "Look around the repo please" },
    });
    const t = parseClaude(line, { path: "/p/agent-abc.jsonl", id: "abc", agentId: "abc" });
    expect(t.title).toBe("Look around the repo please");
    expect(t.agentId).toBe("abc");
    expect(t.entries[0]?.isSidechain).toBe(true);
  });
});
