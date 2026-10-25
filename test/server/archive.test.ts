import { describe, expect, test } from "bun:test";
import { Archive } from "../../src/server/archive";
import { readSessionText } from "../../src/server/files";
import { scratchDir } from "../helpers";

describe("Archive", () => {
  test("stores plain JSONL compressed, keeps compressed input as is, and lists what it holds", async () => {
    const archive = new Archive(scratchDir("archive-unit"));
    const meta = { sourcePath: "/src/a.jsonl", sourceMtimeMs: 123, archivedAt: 456, source: "file" as const };
    const plain = await archive.writeSession(
      "claude",
      "aaa",
      new TextEncoder().encode('{"type":"user"}\n'),
      false,
      meta,
    );
    expect(plain.endsWith("/claude/aaa.jsonl.zst")).toBe(true);
    expect(await readSessionText(plain)).toBe('{"type":"user"}\n');

    const compressed = Bun.zstdCompressSync(Buffer.from('{"type":"session_meta"}\n'));
    const copied = await archive.writeSession("codex", "bbb", compressed, true, { ...meta, source: "file" });
    expect(await readSessionText(copied)).toBe('{"type":"session_meta"}\n');

    await archive.writeSubagent("aaa", "abc", new TextEncoder().encode("{}\n"), false);
    expect(await readSessionText(archive.subagentPath("aaa", "abc"))).toBe("{}\n");

    const listed = await archive.list();
    expect(listed.map((a) => `${a.agent}:${a.id}`).sort()).toEqual(["claude:aaa", "codex:bbb"]);
    expect(await archive.readMeta("claude", "aaa")).toEqual(meta);
  });

  test("refuses ids that could escape the archive directory", async () => {
    const archive = new Archive(scratchDir("archive-unit"));
    expect(() => archive.sessionPath("claude", "../etc")).toThrow(/unsafe id/);
  });
});
