import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Bump when the shape of the `sessions` cache changes; the cache is rebuilt, annotations are never dropped. */
export const SESSIONS_SCHEMA_VERSION = 3;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      block_index INTEGER,
      agent_id TEXT,
      quote_json TEXT,
      kind TEXT NOT NULL,
      note TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      context TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS annotations_session ON annotations(agent, session_id);
  `);
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'sessions_schema'").get();
  if (row && Number.parseInt(row.value, 10) !== SESSIONS_SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS sessions");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      agent TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      cwd TEXT,
      git_branch TEXT,
      title TEXT NOT NULL,
      first_prompt TEXT NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      model TEXT,
      version TEXT,
      user_messages INTEGER NOT NULL,
      assistant_messages INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL,
      cost_usd REAL,
      subagents INTEGER NOT NULL,
      subagent TEXT,
      parent_id TEXT,
      source TEXT NOT NULL DEFAULT 'file',
      archive_path TEXT,
      missing_since INTEGER,
      search_corpus TEXT NOT NULL,
      PRIMARY KEY (agent, id)
    );
    CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(agent, parent_id);
  `);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('sessions_schema', ?)").run(
    String(SESSIONS_SCHEMA_VERSION),
  );
  return db;
}
