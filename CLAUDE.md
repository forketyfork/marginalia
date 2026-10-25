# Marginalia

Local reader and annotator for Claude Code, Codex, and Gemini CLI session transcripts. Bun +
TypeScript + React, SQLite via `bun:sqlite`, no build step beyond Bun's HTML bundling.

## Commands

- `bun run dev` starts the server with hot reload on http://127.0.0.1:4747
- `bun run check` runs typecheck, Biome lint, and tests; CI runs the same
- `bun test` runs the tests alone; fixtures live under `test/fixtures/`

## Layout

- `src/shared/` types and pure logic shared by server and client
- `src/parsers/` per-agent JSONL parsers producing the shared `Transcript` model
- `src/server/` catalog (session index), transcript store, annotation store, API
- `src/client/` React UI
- `docs/architecture.md` design decisions; `docs/transcript-formats.md` the line formats

## Conventions

- Agent-specific knowledge stays in `src/parsers/<agent>.ts`; the UI only knows the shared model.
- Parser changes need a fixture-backed test. Fixtures are synthetic and must not contain real
  session content.
- The `sessions` table is a cache: bump `SESSIONS_SCHEMA_VERSION` when its columns change. Rows are
  never deleted by a refresh; a vanished file is marked `missing_since` and served from the archive.
  The archive directory and the `annotations` table are user data and must never be dropped,
  rebuilt, or pruned.
- Unknown line or item types are counted in `info.counts.skippedLines`, never silently ignored;
  check that counter against real sessions when adding support for new agent versions.
- Scratch files go to `.tmp/` (git-ignored), including test scratch directories.
