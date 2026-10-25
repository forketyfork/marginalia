import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Catalog } from "../../src/server/catalog";
import { openDatabase } from "../../src/server/db";
import { readLegacyStore } from "../../src/server/legacy-store";
import { TranscriptStore } from "../../src/server/transcripts";
import { fixtureConfig, scratchDir } from "../helpers";

function createStore(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE base_messages (uuid TEXT PRIMARY KEY, parent_uuid TEXT, session_id TEXT, timestamp INTEGER, message_type TEXT, cwd TEXT, user_type TEXT, version TEXT, isSidechain INTEGER, original_cwd TEXT);
    CREATE TABLE user_messages (uuid TEXT PRIMARY KEY, message TEXT, tool_use_result TEXT, timestamp INTEGER, is_at_mention_read INTEGER, is_meta INTEGER);
    CREATE TABLE assistant_messages (uuid TEXT PRIMARY KEY, cost_usd REAL, duration_ms INTEGER, message TEXT, is_api_error_message INTEGER, timestamp INTEGER, model TEXT);
    CREATE TABLE conversation_summaries (leaf_uuid TEXT, summary TEXT, updated_at INTEGER);
  `);
  const sid = "2694cb43-c878-4791-9506-dd00e75c8ed4";
  db.query("INSERT INTO base_messages VALUES (?, ?, ?, ?, ?, ?, 'external', '0.2.92', 0, ?)").run(
    "u1",
    null,
    sid,
    1746028862,
    "user",
    "/Users/alice/dev/legacy",
    "/Users/alice/dev/legacy",
  );
  db.query("INSERT INTO user_messages VALUES (?, ?, NULL, ?, NULL, NULL)").run(
    "u1",
    JSON.stringify({ role: "user", content: "Create a CLAUDE.md" }),
    1746028862,
  );
  db.query("INSERT INTO base_messages VALUES (?, ?, ?, ?, ?, ?, 'external', '0.2.92', 0, ?)").run(
    "a1",
    "u1",
    sid,
    1746028871,
    "assistant",
    "/Users/alice/dev/legacy",
    "/Users/alice/dev/legacy",
  );
  db.query("INSERT INTO assistant_messages VALUES (?, 0.06, 8247, ?, 0, ?, ?)").run(
    "a1",
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-7-sonnet-20250219",
      content: [
        { type: "text", text: "Sure." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
      ],
    }),
    1746028871,
    "claude-3-7-sonnet-20250219",
  );
  db.query("INSERT INTO base_messages VALUES (?, ?, ?, ?, ?, ?, 'external', '0.2.92', 0, ?)").run(
    "u2",
    "a1",
    sid,
    1746028880,
    "user",
    "/Users/alice/dev/legacy",
    "/Users/alice/dev/legacy",
  );
  db.query("INSERT INTO user_messages VALUES (?, ?, ?, ?, NULL, NULL)").run(
    "u2",
    JSON.stringify({
      role: "user",
      content: [{ tool_use_id: "t1", content: [{ type: "text", text: "file body" }] }],
    }),
    JSON.stringify({ stdout: "file body" }),
    1746028880,
  );
  db.close();
}

describe("legacy __store.db import", () => {
  test("rebuilds sessions as Claude JSONL and indexes them once", async () => {
    const dir = scratchDir("legacy-store");
    const storePath = join(dir, "__store.db");
    createStore(storePath);

    const sessions = readLegacyStore(storePath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe("/Users/alice/dev/legacy");
    expect(sessions[0]?.jsonl.trim().split("\n")).toHaveLength(3);

    const config = fixtureConfig({ claudeLegacyStorePath: storePath });
    const catalog = new Catalog(openDatabase(":memory:"), config);
    const stats = await catalog.refresh();
    expect(stats.imported).toBe(1);
    const row = catalog.get("claude", "2694cb43-c878-4791-9506-dd00e75c8ed4");
    expect(row).toMatchObject({
      source: "store",
      title: "Create a CLAUDE.md",
      model: "claude-3-7-sonnet-20250219",
      toolCalls: 1,
    });
    expect(row?.startedAt).toBe(1746028862000);

    const transcript = await new TranscriptStore(config, catalog).load(
      "claude",
      "2694cb43-c878-4791-9506-dd00e75c8ed4",
    );
    expect(transcript?.source).toBe("store");
    expect(transcript?.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result"]);
    const result = transcript?.entries[2]?.blocks[0];
    expect(result?.type === "tool_result" ? result.toolUseId : null).toBe("t1");
    expect(result?.type === "tool_result" ? result.text : null).toBe("file body");

    expect((await catalog.refresh()).imported).toBe(0);
  });
});
