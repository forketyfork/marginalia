import { describe, expect, test } from "bun:test";
import { isSessionFile, readSessionText } from "../../src/server/files";
import { CODEX_NEW_PATH, FIXTURES } from "../helpers";

describe("readSessionText", () => {
  test("reads plain JSONL and zstd-compressed JSONL alike", async () => {
    const plain = await readSessionText(CODEX_NEW_PATH);
    expect(plain.startsWith('{"timestamp"')).toBe(true);
    const compressed = await readSessionText(
      `${FIXTURES}/codex/sessions/2026/02/01/rollout-2026-02-01T10-00-00-0199cccc-dddd-7eee-8fff-000000000001.jsonl.zst`,
    );
    expect(compressed.split("\n").filter(Boolean)).toHaveLength(3);
    expect(compressed).toContain("Compressed rollout prompt.");
  });

  test("recognises both session file extensions", () => {
    expect(isSessionFile("rollout-x.jsonl")).toBe(true);
    expect(isSessionFile("rollout-x.jsonl.zst")).toBe(true);
    expect(isSessionFile("rollout-x.zst")).toBe(false);
    expect(isSessionFile("notes.md")).toBe(false);
  });
});
