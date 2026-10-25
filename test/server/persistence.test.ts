import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Catalog } from "../../src/server/catalog";
import type { Config } from "../../src/server/config";
import { openDatabase } from "../../src/server/db";
import { TranscriptStore } from "../../src/server/transcripts";
import { CLAUDE_SESSION_ID, FIXTURES, fixtureConfig, scratchDir } from "../helpers";

describe("sessions survive deletion of their source files", () => {
  let dir: string;
  let config: Config;
  beforeAll(() => {
    dir = scratchDir("persist");
    cpSync(FIXTURES, dir, { recursive: true });
    config = fixtureConfig({
      claudeRoot: join(dir, "claude/projects"),
      codexRoot: join(dir, "codex/sessions"),
      codexArchivedRoot: join(dir, "codex/archived_sessions"),
      geminiRoot: join(dir, "gemini/tmp"),
      geminiProjectsPath: join(dir, "gemini/projects.json"),
      archiveDir: join(dir, "archive"),
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("archives every indexed file, including Claude subagents", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), config);
    await catalog.refresh();
    expect(existsSync(catalog.archive.sessionPath("claude", CLAUDE_SESSION_ID))).toBe(true);
    expect(existsSync(catalog.archive.subagentPath(CLAUDE_SESSION_ID, "abc123def4567890a"))).toBe(true);
    expect(await catalog.archive.readMeta("claude", CLAUDE_SESSION_ID)).toMatchObject({
      source: "file",
      sourcePath: join(dir, "claude/projects/-Users-alice-dev-demo", `${CLAUDE_SESSION_ID}.jsonl`),
    });
  });

  test("keeps the row, marks it missing, and serves the transcript from the archive after the file is deleted", async () => {
    const db = openDatabase(":memory:");
    const catalog = new Catalog(db, config);
    await catalog.refresh();
    const sessionPath = join(dir, "claude/projects/-Users-alice-dev-demo", `${CLAUDE_SESSION_ID}.jsonl`);
    rmSync(join(dir, "claude/projects/-Users-alice-dev-demo", CLAUDE_SESSION_ID), {
      recursive: true,
      force: true,
    });
    unlinkSync(sessionPath);

    const stats = await catalog.refresh();
    expect(stats.missing).toBe(1);
    expect(catalog.status().missing).toBe(1);
    const row = catalog.get("claude", CLAUDE_SESSION_ID);
    expect(row).not.toBeNull();
    expect(row?.missingSince).toBeGreaterThan(0);
    expect(row?.source).toBe("file");

    const store = new TranscriptStore(config, catalog);
    const transcript = await store.load("claude", CLAUDE_SESSION_ID);
    expect(transcript?.title).toBe("Repo file listing");
    expect(transcript?.missingSince).toBeGreaterThan(0);
    expect(transcript?.path).toBe(sessionPath);
    expect(transcript?.subagents[0]).toMatchObject({ agentId: "abc123def4567890a", available: true });
    const sub = await store.loadSubagent("claude", CLAUDE_SESSION_ID, "abc123def4567890a");
    expect(sub?.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);

    const again = await catalog.refresh();
    expect(again.missing).toBe(0);
    expect(catalog.status().missing).toBe(1);
  });

  test("rebuilds rows from the archive when the index table is empty", async () => {
    const fresh = new Catalog(openDatabase(":memory:"), config);
    const stats = await fresh.refresh();
    expect(stats.restored).toBeGreaterThanOrEqual(1);
    const row = fresh.get("claude", CLAUDE_SESSION_ID);
    expect(row?.title).toBe("Repo file listing");
    expect(row?.missingSince).toBeGreaterThan(0);
    expect(fresh.status().sessions).toBeGreaterThanOrEqual(7);
  });
});

describe("extra Claude roots", () => {
  test("indexes sessions from Xcode's Claude config directory", async () => {
    const catalog = new Catalog(
      openDatabase(":memory:"),
      fixtureConfig({ claudeExtraRoots: [join(FIXTURES, "claude-extra/projects")] }),
    );
    await catalog.refresh();
    const row = catalog.get("claude", "22222222-2222-2222-2222-222222222222");
    expect(row?.title).toBe("Fix the Xcode build.");
    expect(row?.cwd).toBe("/Users/alice/dev/xcode");
  });
});
