import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Catalog } from "../../src/server/catalog";
import { openDatabase } from "../../src/server/db";
import {
  dayGroupId,
  groupHistory,
  hasRealPrompt,
  historyToClaudeJsonl,
  parseHistory,
} from "../../src/server/history";
import { TranscriptStore } from "../../src/server/transcripts";
import { CLAUDE_SESSION_ID, FIXTURES, fixtureConfig } from "../helpers";

const HISTORY = join(FIXTURES, "claude/history.jsonl");

describe("history.jsonl recovery", () => {
  test("parses entries, groups by session id, and groups older entries by project and day", async () => {
    const entries = parseHistory(await Bun.file(HISTORY).text());
    expect(entries).toHaveLength(8);
    const groups = groupHistory(entries);
    const bySession = groups.find((g) => g.id === "deadbeef-0000-4000-8000-000000000001");
    expect(bySession?.entries.map((e) => e.display)).toEqual([
      "Deleted session prompt A",
      "Deleted session prompt B",
    ]);
    expect(bySession?.entries[0]?.pasted).toEqual(["pasted blob"]);
    const dayGroups = groups.filter((g) => g.dayGroup);
    expect(dayGroups).toHaveLength(2);
    expect(dayGroups[0]?.entries).toHaveLength(2);
    expect(dayGroups[0]?.id).toBe(dayGroupId("/Users/alice/dev/old", localDay(1759300000000)));
  });

  test("renders a group as Claude JSONL with a notice and one user line per prompt", () => {
    const [group] = groupHistory(
      parseHistory(
        '{"display":"Hi","pastedContents":{},"project":"/p","timestamp":1793000000000,"sessionId":"s1"}\n',
      ),
    );
    if (!group) throw new Error("expected a group");
    const lines = historyToClaudeJsonl(group)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["system", "user"]);
    expect(lines[1]).toMatchObject({
      uuid: "h1",
      parentUuid: "h0",
      sessionId: "s1",
      cwd: "/p",
      message: { role: "user", content: "Hi" },
    });
  });

  test("imports prompt-only sessions for transcripts that are gone, skipping ones that still exist", async () => {
    const config = fixtureConfig({ claudeHistoryPath: HISTORY });
    const catalog = new Catalog(openDatabase(":memory:"), config);
    const stats = await catalog.refresh();
    expect(stats.imported).toBe(4);
    expect(catalog.get("claude", "cafe0000-0000-4000-8000-000000000002")).toBeNull();
    expect(catalog.get("claude", "cafe0000-0000-4000-8000-000000000003")?.title).toBe(
      "/implement the plan in docs/plan.md",
    );

    const live = catalog.get("claude", CLAUDE_SESSION_ID);
    expect(live?.source).toBe("file");
    expect(live?.title).toBe("Repo file listing");

    const ghost = catalog.get("claude", "deadbeef-0000-4000-8000-000000000001");
    expect(ghost).toMatchObject({
      source: "history",
      cwd: "/Users/alice/dev/gone",
      userMessages: 2,
      missingSince: null,
    });
    expect(ghost?.title).toBe("Deleted session prompt A");

    const transcript = await new TranscriptStore(config, catalog).load(
      "claude",
      "deadbeef-0000-4000-8000-000000000001",
    );
    expect(transcript?.source).toBe("history");
    expect(transcript?.entries.map((e) => e.kind)).toEqual(["system", "user", "user"]);
    expect(transcript?.entries[1]?.blocks.map((b) => b.type)).toEqual(["text", "text"]);

    const second = await catalog.refresh();
    expect(second.imported).toBe(0);
    const forced = await catalog.refresh({ force: true });
    expect(forced.imported).toBe(0);
  });
});

function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("history slash commands", () => {
  test("renders bare slash commands as command records and keeps commands with arguments as prompts", () => {
    const text = [
      '{"display":"/mcp","pastedContents":{},"project":"/p","timestamp":1793000000000,"sessionId":"s2"}',
      '{"display":"/review  PR 42","pastedContents":{},"project":"/p","timestamp":1793000001000,"sessionId":"s2"}',
      '{"display":"/Users/alice/file.txt is broken","pastedContents":{},"project":"/p","timestamp":1793000002000,"sessionId":"s2"}',
    ].join("\n");
    const [group] = groupHistory(parseHistory(text));
    if (!group) throw new Error("expected a group");
    const lines = historyToClaudeJsonl(group)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[1]?.message.content).toBe(
      "<command-name>/mcp</command-name>\n<command-args></command-args>",
    );
    expect(lines[2]?.message.content).toBe("/review  PR 42");
    expect(lines[3]?.message.content).toBe("/Users/alice/file.txt is broken");
  });
});

describe("hasRealPrompt", () => {
  test("distinguishes bare commands from prompts", () => {
    const mk = (display: string) => ({ display, pasted: [], project: null, timestamp: 0, sessionId: "s" });
    expect(
      hasRealPrompt({ id: "s", project: null, dayGroup: false, entries: [mk("/exit"), mk("/mcp ")] }),
    ).toBe(false);
    expect(
      hasRealPrompt({
        id: "s",
        project: null,
        dayGroup: false,
        entries: [mk("/exit"), mk("/bug it crashed")],
      }),
    ).toBe(true);
    expect(hasRealPrompt({ id: "s", project: null, dayGroup: false, entries: [mk("plain question")] })).toBe(
      true,
    );
  });
});
