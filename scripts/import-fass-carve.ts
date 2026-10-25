#!/usr/bin/env bun
/**
 * One-off salvage: turns session rows that SQLite's `.recover` carved out of an old fass index
 * (its `lost_and_found` table) into prompt-only Claude sessions in Marginalia's archive, for
 * sessions that exist neither on disk nor in the archive. The next catalog refresh indexes them.
 *
 *   sqlite3 ~/.cache/fass/index.sqlite ".recover" | sqlite3 recovered.sqlite
 *   bun scripts/import-fass-carve.ts recovered.sqlite
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { Archive } from "../src/server/archive";
import { loadConfig } from "../src/server/config";
import { type HistoryEntry, type HistoryGroup, historyToClaudeJsonl } from "../src/server/history";

const recoveredPath = Bun.argv[2];
if (!recoveredPath) {
  console.error("usage: bun scripts/import-fass-carve.ts <recovered.sqlite>");
  process.exit(2);
}

interface SessionRow {
  path: string;
  id: string;
  cwd: string | null;
  started_at: number;
  first_prompt: string;
}

const db = new Database(recoveredPath, { readonly: true });
const archive = new Archive(loadConfig().archiveDir);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const candidates = db
  .query<SessionRow, []>(
    `SELECT c0 AS path, c2 AS id, c3 AS cwd, c4 AS started_at, c6 AS first_prompt
     FROM lost_and_found WHERE nfield = 8 AND c1 = 'claude'
     UNION ALL
     SELECT path, id, cwd, started_at, first_prompt FROM sessions WHERE agent = 'claude'`,
  )
  .all()
  .filter((r) => typeof r.path === "string" && typeof r.id === "string" && UUID.test(r.id));

const prompts = db.query<{ idx: number; ts: number; text: string }, { path: string }>(
  `SELECT c1 AS idx, c2 AS ts, c3 AS text FROM lost_and_found WHERE nfield = 4 AND c0 = $path
   UNION ALL
   SELECT idx, ts, text FROM user_prompts WHERE session_path = $path
   ORDER BY idx`,
);

const seen = new Set<string>();
let written = 0;
for (const row of candidates) {
  if (seen.has(row.id)) continue;
  seen.add(row.id);
  if (existsSync(row.path) || existsSync(archive.sessionPath("claude", row.id))) continue;
  const byIdx = new Map<number, HistoryEntry>();
  for (const p of prompts.all({ path: row.path })) {
    if (typeof p.text !== "string" || p.text.length === 0 || byIdx.has(p.idx)) continue;
    byIdx.set(p.idx, { display: p.text, pasted: [], project: row.cwd, timestamp: (p.ts || row.started_at) * 1000, sessionId: row.id });
  }
  const entries = [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  if (entries.length === 0 && row.first_prompt) {
    entries.push({ display: row.first_prompt, pasted: [], project: row.cwd, timestamp: row.started_at * 1000, sessionId: row.id });
  }
  if (entries.length === 0) continue;
  const group: HistoryGroup = { id: row.id, project: row.cwd, dayGroup: false, entries };
  const jsonl = historyToClaudeJsonl(group, "an old fass index (the transcript file was already gone)");
  await archive.writeSession("claude", row.id, new TextEncoder().encode(jsonl), false, {
    sourcePath: recoveredPath,
    sourceMtimeMs: Date.now(),
    archivedAt: Date.now(),
    source: "history",
  });
  written += 1;
  console.log(`archived ${row.id} (${entries.length} prompts) from ${row.cwd ?? "?"}`);
}
console.log(`${written} prompt-only sessions written to ${archive.dir}`);
