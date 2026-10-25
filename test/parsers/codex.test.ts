import { describe, expect, test } from "bun:test";
import { parseCodex } from "../../src/parsers/codex";
import { CODEX_LEGACY_PATH, CODEX_NEW_PATH } from "../helpers";

describe("parseCodex (current format)", () => {
  const load = async () =>
    parseCodex(await Bun.file(CODEX_NEW_PATH).text(), { path: CODEX_NEW_PATH, fallbackId: "x" });

  test("reads session metadata", async () => {
    const t = await load();
    expect(t.id).toBe("019bdc1a-d3ca-7a13-bb89-3c228628e7f4");
    expect(t.cwd).toBe("/Users/alice/dev/zwanzig");
    expect(t.info.gitBranch).toBe("feature/x");
    expect(t.info.versions).toEqual(["0.87.0"]);
    expect(t.info.models).toEqual(["gpt-5.2-codex"]);
    expect(t.info.extra).toMatchObject({
      originator: "codex_exec",
      effort: "high",
      sandbox: "workspace-write",
    });
    expect(t.info.permissionMode).toBe("never");
    expect(t.title).toBe("Review the last commit.");
  });

  test("separates wrapper envelopes from real prompts", async () => {
    const t = await load();
    const kinds = t.entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === "user")).toHaveLength(1);
    expect(kinds.filter((k) => k === "meta")).toHaveLength(2);
    expect(t.info.counts.turns).toBe(1);
  });

  test("groups reasoning with the following tool call and parses arguments", async () => {
    const t = await load();
    const assistant = t.entries.find((e) => e.kind === "assistant");
    expect(assistant?.blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    const call = assistant?.blocks[1];
    if (call?.type !== "tool_use") throw new Error("expected tool_use");
    expect(call.name).toBe("shell_command");
    expect(call.id).toBe("call_1");
    expect(call.input).toEqual({ command: "git show HEAD", workdir: "/Users/alice/dev/zwanzig" });
    expect(assistant?.model).toBe("gpt-5.2-codex");
  });

  test("detects failures from exit codes in plain and JSON outputs", async () => {
    const t = await load();
    const results = t.entries.filter((e) => e.kind === "tool_result").map((e) => e.blocks[0]);
    expect(results).toHaveLength(2);
    const [shell, patch] = results;
    if (shell?.type !== "tool_result" || patch?.type !== "tool_result")
      throw new Error("expected tool_result blocks");
    expect(shell.isError).toBe(true);
    expect(shell.toolUseId).toBe("call_1");
    expect(patch.isError).toBe(false);
    expect(patch.text).toBe("Success. Updated the following files:\nM src/a.zig\n");
    expect(patch.details).toEqual({ exit_code: 0, duration_seconds: 0 });
  });

  test("keeps apply_patch input, token totals, and aborted turns", async () => {
    const t = await load();
    const patchCall = t.entries
      .flatMap((e) => e.blocks)
      .find((b) => b.type === "tool_use" && b.name === "apply_patch");
    expect(patchCall && patchCall.type === "tool_use" ? patchCall.input : null).toEqual({
      input: "*** Begin Patch\n*** Update File: src/a.zig\n@@\n-old\n+new\n*** End Patch",
    });
    expect(t.info.totalTokens).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 600,
      cacheCreation: 0,
      thinking: 50,
    });
    const aborted = t.entries.find((e) => e.label === "turn_aborted");
    expect(aborted?.kind).toBe("system");
    expect(aborted?.blocks[0]).toMatchObject({ text: "Turn aborted (interrupted)" });
    expect(t.info.counts.skippedLines).toEqual({ "event:task_complete": 1 });
  });
});

describe("parseCodex (legacy 2025 format)", () => {
  test("reads top-level items after the header line", async () => {
    const t = parseCodex(await Bun.file(CODEX_LEGACY_PATH).text(), {
      path: CODEX_LEGACY_PATH,
      fallbackId: "fallback",
    });
    expect(t.id).toBe("0b5fd170-7c2a-4f91-92f4-95b754916ff6");
    expect(t.entries.map((e) => e.kind)).toEqual(["meta", "user", "assistant", "tool_result", "assistant"]);
    expect(t.entries[0]?.label).toBe("instructions");
    const call = t.entries[2]?.blocks[1];
    expect(call?.type === "tool_use" ? call.input : null).toEqual({ command: ["cat", "README.md"] });
    expect(t.title).toBe("Review the code in this repository and improve README.md");
  });
});
