import { describe, expect, test } from "bun:test";
import { parseCodex } from "../../src/parsers/codex";
import { CODEX_SPAWN_PATH } from "../helpers";

describe("parseCodex (sub-sessions and newer items)", () => {
  const load = async () =>
    parseCodex(await Bun.file(CODEX_SPAWN_PATH).text(), { path: CODEX_SPAWN_PATH, fallbackId: "x" });

  test("records spawned-thread provenance from session_meta.source", async () => {
    const t = await load();
    expect(t.info.extra.subagent).toBe("spawn:Mill");
    expect(t.info.extra.parentSession).toBe("019bdc1a-d3ca-7a13-bb89-3c228628e7f4");
    expect(t.info.extra.source).toBeUndefined();
  });

  test("classifies guardian and review sources", () => {
    const meta = (source: unknown) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id: "s", timestamp: "2026-01-01T00:00:00Z", source },
      });
    expect(
      parseCodex(meta({ subagent: { other: "guardian" } }), { path: "/p", fallbackId: "x" }).info.extra
        .subagent,
    ).toBe("guardian");
    expect(
      parseCodex(meta({ subagent: "review" }), { path: "/p", fallbackId: "x" }).info.extra.subagent,
    ).toBe("review");
    const plain = parseCodex(meta("cli"), { path: "/p", fallbackId: "x" }).info.extra;
    expect(plain.source).toBe("cli");
    expect(plain.subagent).toBeUndefined();
  });

  test("maps agent messages, tool search, compaction, and tool manifests", async () => {
    const t = await load();
    expect(t.entries.map((e) => e.kind)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool_result",
      "compact",
      "attachment",
      "assistant",
    ]);
    const [agentMessage, , search, searchResult, compacted, manifest] = t.entries;
    expect(agentMessage?.label).toBe("agent message /root → /root/mill");
    expect(agentMessage?.blocks[0]).toMatchObject({
      text: "Message Type: NEW_TASK\nTask name: review\n(encrypted content)",
    });
    expect(search?.blocks[0]).toMatchObject({
      type: "tool_use",
      name: "tool_search",
      id: "call_ts",
      input: { query: "context7 docs", limit: 5 },
    });
    expect(searchResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_ts",
      text: "Found tools: mcp__context7",
    });
    expect(compacted?.blocks[0]).toMatchObject({ text: "Earlier turns were summarized." });
    expect(manifest?.label).toBe("additional_tools");
    expect(t.info.counts.skippedLines).toEqual({});
  });
});
