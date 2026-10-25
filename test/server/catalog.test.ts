import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Catalog, discoverFiles } from "../../src/server/catalog";
import { openDatabase } from "../../src/server/db";
import {
  CLAUDE_SESSION_ID,
  CODEX_ARCHIVED_ID,
  CODEX_COMPRESSED_ID,
  CODEX_PARENT_ID,
  CODEX_SPAWN_ID,
  FIXTURES,
  fixtureConfig,
  scratchDir,
} from "../helpers";

describe("discoverFiles", () => {
  test("finds main session files for every agent and skips subagent transcripts", async () => {
    const files = await discoverFiles(fixtureConfig());
    const byAgent = Object.groupBy(files, (f) => f.agent);
    expect(byAgent.claude?.map((f) => f.path.split("/").pop())).toEqual([`${CLAUDE_SESSION_ID}.jsonl`]);
    expect(byAgent.codex).toHaveLength(5);
    expect(byAgent.codex?.filter((f) => f.path.endsWith(".jsonl.zst"))).toHaveLength(2);
    expect(byAgent.gemini).toHaveLength(1);
    expect(files.every((f) => f.mtimeMs > 0)).toBe(true);
  });

  test("treats a missing root as an agent that is not installed", async () => {
    const files = await discoverFiles(
      fixtureConfig({ codexRoot: "/definitely/not/here", codexArchivedRoot: "/definitely/not/here/either" }),
    );
    expect(files.some((f) => f.agent === "codex")).toBe(false);
    expect(files.some((f) => f.agent === "claude")).toBe(true);
  });
});

describe("Catalog", () => {
  let dir: string;
  beforeAll(() => {
    dir = scratchDir("catalog");
    cpSync(FIXTURES, dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const config = () =>
    fixtureConfig({
      claudeRoot: join(dir, "claude/projects"),
      codexRoot: join(dir, "codex/sessions"),
      geminiRoot: join(dir, "gemini/tmp"),
      geminiProjectsPath: join(dir, "gemini/projects.json"),
      archiveDir: join(dir, "archive"),
    });

  test("indexes incrementally by mtime and marks vanished files missing", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), config());
    const first = await catalog.refresh();
    expect(first).toMatchObject({ added: 7, updated: 0, missing: 0, errors: 0 });
    expect(catalog.status()).toMatchObject({ indexing: false, sessions: 7, errors: 0 });

    const second = await catalog.refresh();
    expect(second).toMatchObject({ added: 0, updated: 0, missing: 0 });

    const claudePath = join(dir, "claude/projects/-Users-alice-dev-demo", `${CLAUDE_SESSION_ID}.jsonl`);
    const later = new Date(Date.now() + 5_000);
    utimesSync(claudePath, later, later);
    const third = await catalog.refresh();
    expect(third).toMatchObject({ added: 0, updated: 1, missing: 0 });

    const legacy = join(
      dir,
      "codex/sessions/2025/07/23/rollout-2025-07-23T07-35-58-0b5fd170-7c2a-4f91-92f4-95b754916ff6.jsonl",
    );
    unlinkSync(legacy);
    const fourth = await catalog.refresh();
    expect(fourth).toMatchObject({ added: 0, updated: 0, missing: 1 });
    expect(catalog.get("codex", "0b5fd170-7c2a-4f91-92f4-95b754916ff6")?.missingSince).toBeGreaterThan(0);
  });

  test("lists newest first with substring search over prompts, agents, and annotation filters", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), fixtureConfig());
    await catalog.refresh();
    const all = catalog.list(
      { q: "", agents: null, kinds: null, annotatedOnly: false, includeSubagents: false },
      new Map(),
    );
    expect(all.map((s) => s.agent).sort()).toEqual(["claude", "codex", "codex", "codex", "codex", "gemini"]);
    expect(all.every((s) => s.subagent === null)).toBe(true);
    expect(all.map((s) => s.updatedAt)).toEqual([...all.map((s) => s.updatedAt)].sort((a, b) => b - a));
    expect(all.find((s) => s.agent === "claude")).toMatchObject({
      id: CLAUDE_SESSION_ID,
      title: "Repo file listing",
      userMessages: 2,
      toolCalls: 2,
      costUsd: 0.42,
      subagents: 1,
      annotations: { learn: 0, improve: 0, unexpected: 0, good: 0, note: 0 },
    });

    const byPrompt = catalog.list(
      { q: "summarize files", agents: null, kinds: null, annotatedOnly: false, includeSubagents: false },
      new Map(),
    );
    expect(byPrompt.map((s) => s.id)).toEqual([CLAUDE_SESSION_ID]);

    const codexOnly = catalog.list(
      { q: "", agents: ["codex"], kinds: null, annotatedOnly: false, includeSubagents: false },
      new Map(),
    );
    expect(codexOnly).toHaveLength(4);
    expect(codexOnly.map((s) => s.id)).toEqual(
      expect.arrayContaining([CODEX_COMPRESSED_ID, CODEX_ARCHIVED_ID]),
    );

    const stats = new Map([
      [
        `claude:${CLAUDE_SESSION_ID}`,
        { counts: { learn: 2, improve: 0, unexpected: 1, good: 0, note: 0 }, unresolved: 1 },
      ],
    ]);
    const annotated = catalog.list(
      { q: "", agents: null, kinds: null, annotatedOnly: true, includeSubagents: false },
      stats,
    );
    expect(annotated.map((s) => s.id)).toEqual([CLAUDE_SESSION_ID]);
    expect(annotated[0]?.annotations.learn).toBe(2);
    expect(annotated[0]?.unresolved).toBe(1);
    expect(
      catalog.list(
        { q: "", agents: null, kinds: ["good"], annotatedOnly: false, includeSubagents: false },
        stats,
      ),
    ).toHaveLength(0);
    expect(
      catalog.list(
        { q: "", agents: null, kinds: ["unexpected"], annotatedOnly: false, includeSubagents: false },
        stats,
      ),
    ).toHaveLength(1);
  });

  test("shares one in-flight refresh between concurrent callers", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), fixtureConfig());
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(a).toBe(b);
    expect(a.added).toBe(7);
  });
});

describe("Catalog sub-sessions", () => {
  test("hides sub-sessions by default and links them to their parent", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), fixtureConfig());
    await catalog.refresh();
    const base = { q: "", agents: ["codex" as const], kinds: null, annotatedOnly: false };
    expect(catalog.list({ ...base, includeSubagents: false }, new Map()).map((s) => s.id)).not.toContain(
      CODEX_SPAWN_ID,
    );
    const withSubs = catalog.list({ ...base, includeSubagents: true }, new Map());
    const spawn = withSubs.find((s) => s.id === CODEX_SPAWN_ID);
    expect(spawn).toMatchObject({ subagent: "spawn:Mill", parentId: CODEX_PARENT_ID });
    expect(catalog.children("codex", CODEX_PARENT_ID).map((s) => s.id)).toEqual([CODEX_SPAWN_ID]);
    expect(catalog.children("codex", CODEX_SPAWN_ID)).toEqual([]);
  });
});
