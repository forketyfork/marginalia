import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnnotationStore } from "../../src/server/annotations";
import { createServer } from "../../src/server/api";
import { Catalog } from "../../src/server/catalog";
import { openDatabase } from "../../src/server/db";
import { TranscriptStore } from "../../src/server/transcripts";
import type { AnnotationWithSession } from "../../src/shared/annotation";
import type { SessionSummary, Transcript } from "../../src/shared/model";
import {
  CLAUDE_SESSION_ID,
  CODEX_ARCHIVED_ID,
  CODEX_COMPRESSED_ID,
  CODEX_PARENT_ID,
  CODEX_SPAWN_ID,
  fixtureConfig,
} from "../helpers";

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  const config = fixtureConfig();
  const db = openDatabase(":memory:");
  const catalog = new Catalog(db, config);
  server = createServer(
    { catalog, transcripts: new TranscriptStore(config, catalog), annotations: new AnnotationStore(db) },
    { port: 0, hostname: "127.0.0.1", development: false },
  );
  base = server.url.toString().replace(/\/$/, "");
  await catalog.refresh();
});

afterAll(() => server.stop(true));

const get = <T>(path: string) =>
  fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: (await r.json()) as T }));
const send = <T>(method: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : ((await r.json()) as T) }));

describe("API", () => {
  test("lists sessions with annotation counts and validates filters", async () => {
    const ok = await get<SessionSummary[]>("/api/sessions?agent=claude");
    expect(ok.status).toBe(200);
    expect(ok.body.map((s) => s.id)).toEqual([CLAUDE_SESSION_ID]);
    const bad = await get<{ error: string }>("/api/sessions?agent=nope");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("unknown agent");
  });

  test("serves transcripts, subagent transcripts, and single blocks", async () => {
    const t = await get<Transcript>(`/api/sessions/claude/${CLAUDE_SESSION_ID}`);
    expect(t.status).toBe(200);
    expect(t.body.title).toBe("Repo file listing");
    expect(t.body.subagents[0]).toMatchObject({ agentId: "abc123def4567890a", available: true });

    const sub = await get<Transcript>(
      `/api/sessions/claude/${CLAUDE_SESSION_ID}/subagents/abc123def4567890a`,
    );
    expect(sub.status).toBe(200);
    expect(sub.body.agentId).toBe("abc123def4567890a");
    expect(sub.body.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);

    const block = await get<{ type: string; text: string }>(
      `/api/sessions/claude/${CLAUDE_SESSION_ID}/block?entry=r1&block=0`,
    );
    expect(block.status).toBe(200);
    expect(block.body).toMatchObject({ type: "tool_result", text: "README.md\nsrc" });

    const parent = await get<Transcript>(`/api/sessions/codex/${CODEX_PARENT_ID}`);
    expect(parent.body.subagents).toEqual([
      {
        agentId: CODEX_SPAWN_ID,
        description: "spawn:Mill: Review the Russian translation.",
        toolUseId: null,
        available: true,
        sessionId: CODEX_SPAWN_ID,
      },
    ]);
    const hidden = await get<SessionSummary[]>("/api/sessions?agent=codex");
    expect(hidden.body.map((s) => s.id)).not.toContain(CODEX_SPAWN_ID);
    const shown = await get<SessionSummary[]>("/api/sessions?agent=codex&subagents=1");
    expect(shown.body.map((s) => s.id)).toContain(CODEX_SPAWN_ID);

    for (const { id, prompt } of [
      { id: CODEX_COMPRESSED_ID, prompt: "Compressed rollout prompt." },
      { id: CODEX_ARCHIVED_ID, prompt: "Archived rollout prompt." },
    ]) {
      const zst = await get<Transcript>(`/api/sessions/codex/${id}`);
      expect(zst.status).toBe(200);
      expect(zst.body.title).toBe(prompt);
      expect(zst.body.path.endsWith(".jsonl.zst")).toBe(true);
    }

    expect((await get(`/api/sessions/claude/missing`)).status).toBe(404);
    expect((await get(`/api/sessions/claude/${CLAUDE_SESSION_ID}/subagents/../etc`)).status).toBe(404);
  });

  test("round-trips annotations and reflects them in session counts", async () => {
    const created = await send<AnnotationWithSession>("POST", "/api/annotations", {
      agent: "claude",
      sessionId: CLAUDE_SESSION_ID,
      target: {
        entryId: "a1",
        blockIndex: 1,
        agentId: null,
        quote: { exact: "Listing", prefix: "", suffix: " the", start: 0, end: 7 },
      },
      kind: "learn",
      note: "why list first?",
      tags: ["flow"],
      context: "Listing the files now.",
    });
    expect(created.status).toBe(201);
    expect(created.body?.sessionTitle).toBe("Repo file listing");

    const sessions = await get<SessionSummary[]>("/api/sessions?kind=learn");
    expect(sessions.body.map((s) => s.id)).toEqual([CLAUDE_SESSION_ID]);
    expect(sessions.body[0]?.annotations.learn).toBe(1);
    expect(sessions.body[0]?.unresolved).toBe(1);

    const id = created.body?.id ?? "";
    const patched = await send<AnnotationWithSession>("PATCH", `/api/annotations/${id}`, {
      resolved: true,
      kind: "good",
    });
    expect(patched.body).toMatchObject({ resolved: true, kind: "good" });

    const listed = await get<AnnotationWithSession[]>(
      `/api/annotations?sessionId=${CLAUDE_SESSION_ID}&resolved=1`,
    );
    expect(listed.body.map((a) => a.id)).toEqual([id]);

    expect((await send("DELETE", `/api/annotations/${id}`, undefined)).status).toBe(204);
    expect((await send("DELETE", `/api/annotations/${id}`, undefined)).status).toBe(404);
  });

  test("rejects malformed annotation input with a reason", async () => {
    const noTarget = await send<{ error: string }>("POST", "/api/annotations", {
      agent: "claude",
      sessionId: "s",
      kind: "learn",
    });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body?.error).toContain("target");
    const badKind = await send<{ error: string }>("POST", "/api/annotations", {
      agent: "claude",
      sessionId: "s",
      kind: "wat",
      target: { entryId: "e", blockIndex: null, agentId: null, quote: null },
    });
    expect(badKind.status).toBe(400);
    expect(badKind.body?.error).toContain("kind");
    const quoteWithoutBlock = await send<{ error: string }>("POST", "/api/annotations", {
      agent: "claude",
      sessionId: "s",
      kind: "note",
      target: {
        entryId: "e",
        blockIndex: null,
        agentId: null,
        quote: { exact: "a", prefix: "", suffix: "", start: 0, end: 1 },
      },
    });
    expect(quoteWithoutBlock.status).toBe(400);
  });
});
