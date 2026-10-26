import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../src/server/config";

export const FIXTURES = resolve(import.meta.dir, "fixtures");

export const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111";
export const CLAUDE_SESSION_PATH = join(
  FIXTURES,
  "claude/projects/-Users-alice-dev-demo",
  `${CLAUDE_SESSION_ID}.jsonl`,
);
export const CODEX_NEW_PATH = join(
  FIXTURES,
  "codex/sessions/2026/01/20/rollout-2026-01-20T15-51-44-019bdc1a-d3ca-7a13-bb89-3c228628e7f4.jsonl",
);
export const CODEX_SPAWN_PATH = join(
  FIXTURES,
  "codex/sessions/2026/01/21/rollout-2026-01-21T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl",
);
export const CODEX_PARENT_ID = "019bdc1a-d3ca-7a13-bb89-3c228628e7f4";
export const CODEX_COMPRESSED_ID = "0199cccc-dddd-7eee-8fff-000000000001";
export const CODEX_ARCHIVED_ID = "0199cccc-dddd-7eee-8fff-000000000002";
export const CODEX_SPAWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
export const CODEX_LEGACY_PATH = join(
  FIXTURES,
  "codex/sessions/2025/07/23/rollout-2025-07-23T07-35-58-0b5fd170-7c2a-4f91-92f4-95b754916ff6.jsonl",
);
export const COWORK_ACCOUNT = join(
  FIXTURES,
  "cowork/0f0f0f0f-0000-4000-8000-00000000000f/1a1a1a1a-0000-4000-8000-00000000001a",
);
export const COWORK_NEW_ID = "aaaa0001-0000-4000-8000-000000000001";
export const COWORK_NEW_AUDIT = join(COWORK_ACCOUNT, "aaaa0001", "audit.jsonl");
export const COWORK_NEW_SIDECAR = join(COWORK_ACCOUNT, `local_${COWORK_NEW_ID}.json`);
export const COWORK_OLD_ID = "bbbb0002-0000-4000-8000-000000000002";
export const COWORK_OLD_AUDIT = join(COWORK_ACCOUNT, `local_${COWORK_OLD_ID}`, "audit.jsonl");
export const COWORK_OLD_SIDECAR = join(COWORK_ACCOUNT, `local_${COWORK_OLD_ID}.json`);
export const GEMINI_PATH = join(FIXTURES, "gemini/tmp/demo/chats/session-2026-05-04T05-37-77677bcc.jsonl");

export function fixtureConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: ":memory:",
    dbPath: ":memory:",
    claudeRoot: join(FIXTURES, "claude/projects"),
    claudeExtraRoots: [],
    claudeHistoryPath: join(FIXTURES, "claude/no-history.jsonl"),
    claudeLegacyStorePath: join(FIXTURES, "claude/no-store.db"),
    coworkRoot: join(FIXTURES, "cowork"),
    archiveDir: scratchDir("archive"),
    codexRoot: join(FIXTURES, "codex/sessions"),
    codexArchivedRoot: join(FIXTURES, "codex/archived_sessions"),
    geminiRoot: join(FIXTURES, "gemini/tmp"),
    geminiProjectsPath: join(FIXTURES, "gemini/projects.json"),
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    ...overrides,
  };
}

/** A scratch directory under the repository's .tmp so tests never touch the system temp dir. */
export function scratchDir(prefix: string): string {
  const base = resolve(import.meta.dir, "..", ".tmp");
  return mkdtempSync(join(base, `${prefix}-`));
}

/** The rendered text of an HTML fragment: what a reader sees and what quotes anchor to. */
export const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
