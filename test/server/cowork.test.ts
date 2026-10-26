import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Catalog, discoverFiles } from "../../src/server/catalog";
import { CoworkSidecars, coworkMtimeMs, findCoworkAudits, readCoworkSession } from "../../src/server/cowork";
import { openDatabase } from "../../src/server/db";
import { readSessionText } from "../../src/server/files";
import { TranscriptStore } from "../../src/server/transcripts";
import {
  COWORK_NEW_AUDIT,
  COWORK_NEW_ID,
  COWORK_NEW_SIDECAR,
  COWORK_OLD_AUDIT,
  COWORK_OLD_ID,
  COWORK_OLD_SIDECAR,
  FIXTURES,
  fixtureConfig,
  scratchDir,
} from "../helpers";

describe("Cowork session files", () => {
  test("finds audit logs at the fixed depth and nothing else", async () => {
    const audits = await findCoworkAudits(join(FIXTURES, "cowork"));
    expect(audits.sort()).toEqual([COWORK_NEW_AUDIT, COWORK_OLD_AUDIT].sort());
    expect(await findCoworkAudits("/definitely/not/here")).toEqual([]);
  });

  test("locates the sidecar for both directory naming schemes", async () => {
    const sidecars = new CoworkSidecars();
    expect(await sidecars.locate(COWORK_NEW_AUDIT)).toBe(COWORK_NEW_SIDECAR);
    expect(await sidecars.locate(COWORK_OLD_AUDIT)).toBe(COWORK_OLD_SIDECAR);
  });

  test("reports a missing sidecar as null and an ambiguous short name as an error", async () => {
    const dir = scratchDir("cowork-sidecars");
    try {
      const account = join(dir, "org", "account");
      const lonely = join(account, "local_eeee0005-0000-4000-8000-000000000005", "audit.jsonl");
      const short = join(account, "ffff0006", "audit.jsonl");
      for (const path of [lonely, short]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
      writeFileSync(join(account, "local_ffff0006-0000-4000-8000-000000000006.json"), "{}");
      writeFileSync(join(account, "local_ffff0006-0000-4000-8000-000000000007.json"), "{}");
      const sidecars = new CoworkSidecars();
      expect(await sidecars.locate(lonely)).toBeNull();
      await expect(sidecars.locate(short)).rejects.toThrow(/several Cowork sidecars/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("composes the sidecar as a header line in front of the audit log", async () => {
    const source = await readCoworkSession(COWORK_NEW_AUDIT, COWORK_NEW_SIDECAR);
    const lines = source.text.split("\n").filter(Boolean);
    const header = JSON.parse(lines[0] ?? "{}");
    expect(header.type).toBe("cowork_session");
    expect(header.sidecar.title).toBe("Slack digest");
    expect(lines.slice(1).join("\n")).toBe((await Bun.file(COWORK_NEW_AUDIT).text()).trim());
    expect(source.compressed).toBe(false);
    expect(source.mtimeMs).toBe(await coworkMtimeMs(COWORK_NEW_AUDIT, COWORK_NEW_SIDECAR));

    const bare = await readCoworkSession(COWORK_OLD_AUDIT, null);
    expect(bare.text).toBe(await Bun.file(COWORK_OLD_AUDIT).text());
  });
});

describe("Cowork sessions in the catalog", () => {
  let dir: string;
  let audit: string;
  let sidecar: string;
  beforeAll(() => {
    dir = scratchDir("cowork-catalog");
    cpSync(join(FIXTURES, "cowork"), join(dir, "cowork"), { recursive: true });
    audit = COWORK_NEW_AUDIT.replace(join(FIXTURES, "cowork"), join(dir, "cowork"));
    sidecar = COWORK_NEW_SIDECAR.replace(join(FIXTURES, "cowork"), join(dir, "cowork"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const config = () =>
    fixtureConfig({
      claudeRoot: "/definitely/not/here",
      codexRoot: "/definitely/not/here",
      codexArchivedRoot: "/definitely/not/here",
      geminiRoot: "/definitely/not/here",
      coworkRoot: join(dir, "cowork"),
      archiveDir: join(dir, "archive"),
    });

  test("discovers both files of a session and dates it by the newer one", async () => {
    utimesSync(sidecar, new Date("2026-10-25T12:00:00Z"), new Date("2026-10-25T12:00:00Z"));
    utimesSync(audit, new Date("2026-10-21T06:00:00Z"), new Date("2026-10-21T06:00:00Z"));
    const files = await discoverFiles(config());
    const found = files.find((f) => f.path === audit);
    expect(found).toEqual({
      agent: "cowork",
      path: audit,
      mtimeMs: Date.parse("2026-10-25T12:00:00Z"),
      companion: sidecar,
    });
  });

  test("indexes, archives the composed form, re-indexes on a sidecar change, and survives deletion", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), config());
    const store = new TranscriptStore(config(), catalog);
    expect(await catalog.refresh()).toMatchObject({ added: 2, errors: 0 });

    const listed = catalog.list(
      { q: "", agents: ["cowork"], kinds: null, annotatedOnly: false, includeSubagents: false },
      new Map(),
    );
    expect(listed.map((s) => [s.id, s.title, s.cwd]).sort()).toEqual([
      [COWORK_NEW_ID, "Slack digest", "/Users/alice/Notes"],
      [COWORK_OLD_ID, "Receipt scan", null],
    ]);
    expect(catalog.get("cowork", COWORK_NEW_ID)?.updatedAt).toBe(Date.parse("2026-10-25T12:00:00Z"));

    const archived = catalog.archive.sessionPath("cowork", COWORK_NEW_ID);
    expect(existsSync(archived)).toBe(true);
    expect((await readSessionText(archived)).startsWith('{"type":"cowork_session"')).toBe(true);

    const live = await store.load("cowork", COWORK_NEW_ID);
    expect(live?.title).toBe("Slack digest");
    expect(live?.source).toBe("file");
    expect(live?.entries.some((e) => e.id === "cowork-system-prompt")).toBe(true);

    const renamed = JSON.parse(await Bun.file(sidecar).text());
    renamed.title = "Slack digest (renamed)";
    writeFileSync(sidecar, JSON.stringify(renamed));
    utimesSync(sidecar, new Date("2026-10-26T12:00:00Z"), new Date("2026-10-26T12:00:00Z"));
    expect(await catalog.refresh()).toMatchObject({ added: 0, updated: 1, missing: 0 });
    expect(catalog.get("cowork", COWORK_NEW_ID)?.title).toBe("Slack digest (renamed)");
    expect((await store.load("cowork", COWORK_NEW_ID))?.title).toBe("Slack digest (renamed)");

    rmSync(dirname(audit), { recursive: true });
    rmSync(sidecar);
    expect(await catalog.refresh()).toMatchObject({ missing: 1 });
    const fromArchive = await store.load("cowork", COWORK_NEW_ID);
    expect(fromArchive?.title).toBe("Slack digest (renamed)");
    expect(fromArchive?.missingSince).not.toBeNull();
    expect(fromArchive?.entries.filter((e) => e.kind === "assistant")).toHaveLength(5);
  });

  test("rebuilds the rows for archived Cowork sessions", async () => {
    const catalog = new Catalog(openDatabase(":memory:"), config());
    const stats = await catalog.refresh();
    expect(stats.restored).toBe(1);
    const restored = catalog.get("cowork", COWORK_NEW_ID);
    expect(restored?.title).toBe("Slack digest (renamed)");
    expect(restored?.missingSince).not.toBeNull();
  });
});
