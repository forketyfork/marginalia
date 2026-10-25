import { describe, expect, test } from "bun:test";
import { AnnotationStore, normalizeTags } from "../../src/server/annotations";
import { openDatabase } from "../../src/server/db";
import type { AnnotationInput } from "../../src/shared/annotation";

const input = (overrides: Partial<AnnotationInput> = {}): AnnotationInput => ({
  agent: "claude",
  sessionId: "s1",
  target: {
    entryId: "e1",
    blockIndex: 0,
    agentId: null,
    quote: { exact: "foo", prefix: "", suffix: "", start: 0, end: 3 },
  },
  kind: "learn",
  note: "what is foo?",
  tags: ["Zig", " zig ", ""],
  context: "foo bar",
  ...overrides,
});

describe("AnnotationStore", () => {
  test("creates, reads, updates, and deletes annotations", () => {
    const store = new AnnotationStore(openDatabase(":memory:"));
    const created = store.create(input());
    expect(created).toMatchObject({
      kind: "learn",
      note: "what is foo?",
      tags: ["zig"],
      resolved: false,
      context: "foo bar",
    });
    expect(created.target.quote?.exact).toBe("foo");
    expect(store.get(created.id)?.id).toBe(created.id);

    const updated = store.update(created.id, { resolved: true, note: "foo is a bar" });
    expect(updated).toMatchObject({ resolved: true, note: "foo is a bar", kind: "learn", tags: ["zig"] });
    expect(updated?.updatedAt ?? 0).toBeGreaterThanOrEqual(created.updatedAt);

    expect(store.update("missing", { note: "x" })).toBeNull();
    expect(store.delete(created.id)).toBe(true);
    expect(store.delete(created.id)).toBe(false);
    expect(store.get(created.id)).toBeNull();
  });

  test("filters lists and aggregates per-session stats", () => {
    const store = new AnnotationStore(openDatabase(":memory:"));
    store.create(input());
    store.create(input({ kind: "unexpected", note: "ran rm -rf", sessionId: "s1" }));
    const other = store.create(input({ kind: "good", sessionId: "s2", agent: "codex", note: "nice plan" }));
    store.update(other.id, { resolved: true });

    expect(store.list({ sessionId: "s1" })).toHaveLength(2);
    expect(store.list({ kind: "good" }).map((a) => a.sessionId)).toEqual(["s2"]);
    expect(store.list({ resolved: true })).toHaveLength(1);
    expect(store.list({ agent: "codex" })).toHaveLength(1);
    expect(store.list({ q: "RM -RF" }).map((a) => a.kind)).toEqual(["unexpected"]);

    const stats = store.statsBySession();
    expect(stats.get("claude:s1")).toEqual({
      counts: { learn: 1, improve: 0, unexpected: 1, good: 0, note: 0 },
      unresolved: 2,
    });
    expect(stats.get("codex:s2")).toEqual({
      counts: { learn: 0, improve: 0, unexpected: 0, good: 1, note: 0 },
      unresolved: 0,
    });
  });

  test("normalizes tags", () => {
    expect(normalizeTags([" A ", "a", "b", ""])).toEqual(["a", "b"]);
  });
});
