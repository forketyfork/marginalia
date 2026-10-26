import { describe, expect, test } from "bun:test";
import { classifyCoworkLine, parseCowork } from "../../src/parsers/cowork";
import { readCoworkSession } from "../../src/server/cowork";
import type { Entry } from "../../src/shared/model";
import {
  COWORK_NEW_AUDIT,
  COWORK_NEW_ID,
  COWORK_NEW_SIDECAR,
  COWORK_OLD_AUDIT,
  COWORK_OLD_ID,
  COWORK_OLD_SIDECAR,
} from "../helpers";

const loadNew = async () =>
  parseCowork((await readCoworkSession(COWORK_NEW_AUDIT, COWORK_NEW_SIDECAR)).text, {
    path: COWORK_NEW_AUDIT,
  });
const loadOld = async () =>
  parseCowork((await readCoworkSession(COWORK_OLD_AUDIT, COWORK_OLD_SIDECAR)).text, {
    path: COWORK_OLD_AUDIT,
  });

const byId = (entries: Entry[], id: string): Entry => {
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return entry;
};
const textOf = (entry: Entry, index = 0): string => {
  const block = entry.blocks[index];
  if (!block || !("text" in block)) throw new Error(`block ${index} of ${entry.id} has no text`);
  return block.text;
};

describe("parseCowork", () => {
  test("skips heartbeat and progress lines before JSON parsing", () => {
    expect(classifyCoworkLine('{"type":"system","subtype":"thinking_tokens","x":1}')).toBe(
      "system:thinking_tokens",
    );
    expect(classifyCoworkLine('{"type":"system","subtype":"status_report"}')).toBeNull();
    expect(classifyCoworkLine('{"type":"tool_progress"}')).toBe("tool_progress");
    expect(classifyCoworkLine('{"type":"user"}')).toBeNull();
  });

  test("takes the id from the first user line and title, folder and flags from the sidecar", async () => {
    const t = await loadNew();
    expect(t.id).toBe(COWORK_NEW_ID);
    expect(t.title).toBe("Slack digest");
    expect(t.cwd).toBe("/Users/alice/Notes");
    expect(t.info.extra).toEqual({ scheduledTask: "slack-fetch" });
    expect(t.info.permissionMode).toBe("auto");
    expect(t.info.models).toEqual(["claude-opus-5-5"]);
    expect(t.info.versions).toEqual(["2.1.304"]);
    expect(t.startedAt).toBe(1792560240000);
    expect(t.endedAt).toBe(1792560460000);
  });

  test("surfaces the sidecar facts and the system prompt as attachments without the bulky fields", async () => {
    const t = await loadNew();
    const [session, prompt] = t.entries;
    expect(session?.id).toBe("cowork-session");
    expect(session?.kind).toBe("attachment");
    const facts = textOf(session as Entry);
    expect(facts).toContain('"isStarred": true');
    expect(facts).toContain('"scheduledTaskId": "slack-fetch"');
    for (const hidden of ["systemPrompt", "remoteMcpServersConfig", "enabledMcpTools", "emailAddress"]) {
      expect(facts).not.toContain(hidden);
    }
    expect(prompt?.id).toBe("cowork-system-prompt");
    expect(textOf(prompt as Entry)).toBe("You are Cowork, running inside the Claude desktop app.");
  });

  test("counts every skipped line kind", async () => {
    const t = await loadNew();
    expect(t.info.counts.skippedLines).toEqual({
      command_lifecycle: 1,
      "system:status": 1,
      "system:thinking_tokens": 1,
      rate_limit_event: 1,
      "system:permission_check_status": 1,
      "system:task_progress": 1,
      tool_progress: 1,
      "user:replay": 1,
      "system:commands_changed": 1,
      mystery: 1,
    });
    expect(t.info.counts.malformedLines).toBe(0);
  });

  test("groups streamed assistant lines and keeps the snake_case thinking duration", async () => {
    const t = await loadNew();
    const first = byId(t.entries, "ca1");
    expect(first.blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(first.thinkingMs).toBe(1100);
    expect(first.stopReason).toBe("tool_use");
    expect(t.entries.some((e) => e.id === "ca2")).toBe(false);
  });

  test("marks subagent traffic as sidechain by parent_tool_use_id", async () => {
    const t = await loadNew();
    expect(byId(t.entries, "ca4").isSidechain).toBe(true);
    expect(byId(t.entries, "cr2").isSidechain).toBe(true);
    expect(byId(t.entries, "cu1").isSidechain).toBe(false);
    expect(byId(t.entries, "ca3").isSidechain).toBe(false);
  });

  test("classifies synthetic, replayed and post-compaction user lines", async () => {
    const t = await loadNew();
    expect(byId(t.entries, "cu2").kind).toBe("meta");
    expect(byId(t.entries, "cu9").kind).toBe("user");
    expect(byId(t.entries, "cu3").kind).toBe("compact");
    expect(t.entries.filter((e) => e.id === "cu1")).toHaveLength(1);
    expect(t.info.counts.turns).toBe(2);
    expect(t.info.counts.user).toBe(2);
  });

  test("keeps structured tool results and pairs them by tool_use_id", async () => {
    const t = await loadNew();
    const result = byId(t.entries, "cr1");
    expect(result.kind).toBe("tool_result");
    const block = result.blocks[0];
    if (block?.type !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.toolUseId).toBe("toolu_1");
    expect(block.text).toBe("3 results");
    expect(block.details).toEqual({ matches: ["a", "b", "c"], query: "to:me" });
    const agentResult = byId(t.entries, "cr3").blocks[0];
    expect(agentResult?.type === "tool_result" && agentResult.details).toBeNull();
  });

  test("turns init, permission, task, retry and compaction lines into system entries", async () => {
    const t = await loadNew();
    const init = byId(t.entries, "cs1");
    expect(init.label).toBe("init");
    expect(textOf(init)).toBe(
      "Claude Code 2.1.304 · claude-opus-5-5 · auto permissions · 2 tools · MCP: Slack",
    );
    expect(textOf(init, 1)).toContain('"additional_directories"');

    const request = byId(t.entries, "cs2");
    expect(request.label).toBe("permission request");
    expect(textOf(request)).toBe("mcp__slack__search");
    expect(textOf(request, 1)).toContain('"query": "to:me"');

    const response = byId(t.entries, "cs3");
    expect(response.label).toBe("permission response");
    expect(response.blocks).toHaveLength(1);
    expect(textOf(response)).toBe("mcp__slack__search: granted (once)");

    const started = byId(t.entries, "cs4");
    expect(started.label).toBe("task started");
    expect(textOf(started)).toBe("Explore vault (general-purpose)");
    expect(textOf(started, 1)).toContain("Look for notes about Slack.");
    expect(textOf(byId(t.entries, "cs5"))).toBe("completed: Found 2 notes");

    const retry = byId(t.entries, "cs6");
    expect(retry.level).toBe("warning");
    expect(textOf(retry)).toBe("API retry 1/10 in 553 ms: unknown");

    expect(textOf(byId(t.entries, "cs7"))).toBe("Conversation compacted (auto), 181,925 tokens before");
    expect(textOf(byId(t.entries, "cts1"))).toBe("Searched Slack for this week's mentions");
  });

  test("reads cost and token totals from the cumulative result lines", async () => {
    const t = await loadNew();
    expect(t.info.costUsd).toBe(1.35);
    expect(t.info.totalTokens).toEqual({
      input: 28,
      output: 5534,
      cacheRead: 1030123,
      cacheCreation: 129821,
      thinking: 744,
    });
    const first = byId(t.entries, "cres1");
    expect(first.label).toBe("turn result");
    expect(textOf(first)).toBe("Turn took 1 min 17 s · 18 API calls · $0.77 so far");
    expect(textOf(first, 1)).toContain('"stop_reason": "end_turn"');
    expect(textOf(first, 1)).not.toContain("permission_denials");
  });

  test("takes timestamps from _audit_timestamp when the SDK line has none", async () => {
    const t = await loadNew();
    expect(byId(t.entries, "cs2").timestamp).toBe(Date.parse("2026-10-21T05:24:08.052Z"));
    expect(byId(t.entries, "cu1").timestamp).toBe(Date.parse("2026-10-21T05:24:02.424Z"));
  });

  test("titles a log without a sidecar after its first prompt", async () => {
    const t = parseCowork(await Bun.file(COWORK_NEW_AUDIT).text(), { path: COWORK_NEW_AUDIT });
    expect(t.id).toBe(COWORK_NEW_ID);
    expect(t.title).toBe("Summarize what people asked me on Slack this week.");
    expect(t.cwd).toBeNull();
    expect(t.entries.some((e) => e.id.startsWith("cowork-"))).toBe(false);
    expect(t.startedAt).toBe(Date.parse("2026-10-21T05:24:02.424Z"));
  });

  test("reads older logs that only carry _audit_timestamp and appends the sidecar error", async () => {
    const t = await loadOld();
    expect(t.id).toBe(COWORK_OLD_ID);
    expect(t.title).toBe("Receipt scan");
    expect(t.cwd).toBeNull();
    expect(t.entries.every((e) => e.timestamp !== null)).toBe(true);
    const prompt = byId(t.entries, "du1");
    expect(prompt.kind).toBe("user");
    expect(prompt.blocks.map((b) => b.type)).toEqual(["image", "text"]);
    const last = t.entries[t.entries.length - 1];
    expect(last?.id).toBe("cowork-error");
    expect(last?.level).toBe("error");
    expect(textOf(last as Entry)).toBe("You've hit your limit · resets 11:10am");
    expect(last?.timestamp).toBe(1770666759000);
    expect(t.info.costUsd).toBe(0.05);
  });

  test("refuses a log without a user line", () => {
    expect(() =>
      parseCowork('{"type":"system","subtype":"init","uuid":"x"}', { path: "/x/audit.jsonl" }),
    ).toThrow(/no user line/);
  });
});
