# Marginalia

A local reader and annotator for coding-agent session transcripts. It finds every Claude Code,
Claude Cowork (the desktop app's agent mode), Codex, and Gemini CLI session on the machine, renders
each transcript in a readable form
(prompts, assistant text, thinking when it was recorded, tool calls with their results, injected
context, system events, subagents), and lets you attach annotations to any piece of it: a text
selection, a message, a thought, a tool call, or a tool result.

The point is manual analysis. When you meet an unfamiliar term, annotate it to learn later. When the
agent does something unexpected, annotate it so you can fix a guideline, skill, or hook afterwards.
Every annotation is listed in one place so you can come back to it, and the session list shows which
kinds of annotations each session carries.

## Quick start

Requires [Bun](https://bun.sh) 1.3 or newer.

```
bun install
bun run start
```

Open http://127.0.0.1:4747. The first start indexes the whole session history (about 8 seconds for
2,500 sessions); later starts only re-read files whose modification time changed.

`bun run dev` runs the same server with hot reload for development.

## Using it

- **Sessions** (left): type to search across titles, working directories, and every user prompt.
  Chips filter by agent, by annotation kind ("only sessions that have *Unexpected* annotations"),
  by "annotated at all", and optionally include sub-sessions (Codex guardian, review, and spawned
  threads, which are hidden by default). Press `/` to focus the search box.
- **Transcript** (middle): user prompts, assistant messages with thinking, and tool calls appear in
  order. Tool calls are collapsed to one line (tool, summary, status, duration); click to expand the
  input and result. Injected context (`<system-reminder>`, hook output, skill listings, compaction
  summaries, slash commands) is shown as dimmed one-liners that expand on click, and can be hidden
  with the "system & context" toggle. Subagent transcripts are linked from the header and from the
  `Agent` tool result that launched them.
- **Annotating**: select text and press *Annotate selection*, or use *annotate* on a message,
  thought, tool call, or tool result. Pick a kind, write a note (Markdown), add tags, save with
  `⌘↵`. Highlights are coloured by kind; click one to jump to its card.
- **Annotations** (right panel and the top-level page): the panel lists the current session's
  annotations in document order; the *Annotations* page lists everything with filters for kind,
  agent, resolved state, and free text, grouped by session, and links back to the exact spot.

### Annotation kinds

| Kind | Use it for |
| --- | --- |
| Learn | An unfamiliar term, tool, or concept to study later |
| Improve | A guideline, skill, hook, or setup change to make |
| Unexpected | The agent did something surprising or wrong |
| Good | A pattern worth keeping or reusing |
| Note | Anything else |

Annotations can be marked resolved once you have acted on them; resolved ones stay visible but dim.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MARGINALIA_PORT` | `4747` | Listening port |
| `MARGINALIA_HOST` | `127.0.0.1` | Listening address; the server has no authentication, keep it local |
| `MARGINALIA_DATA_DIR` | `~/.local/share/marginalia` | Location of `marginalia.sqlite` (annotations and the session index) |
| `MARGINALIA_CLAUDE_ROOT` | `~/.claude/projects` | Claude Code session files |
| `MARGINALIA_CLAUDE_EXTRA_ROOTS` | Xcode's Claude agent config | Colon-separated extra directories in the Claude layout |
| `MARGINALIA_CLAUDE_HISTORY` | `~/.claude/history.jsonl` | Prompt history used to rebuild deleted sessions |
| `MARGINALIA_CLAUDE_LEGACY_STORE` | `~/.claude/__store.db` | Spring-2025 message store, imported once |
| `MARGINALIA_COWORK_ROOT` | `~/Library/Application Support/Claude/local-agent-mode-sessions` | Claude desktop app (Cowork) session logs and their sidecars |
| `MARGINALIA_ARCHIVE_DIR` | `<data dir>/archive` | Marginalia's own copies of every transcript |
| `MARGINALIA_CODEX_ROOT` | `~/.codex/sessions` | Codex rollout files, plain or zstd-compressed |
| `MARGINALIA_CODEX_ARCHIVED_ROOT` | `~/.codex/archived_sessions` | Codex threads archived from the UI |
| `MARGINALIA_GEMINI_ROOT` | `~/.gemini/tmp` | Gemini CLI chat files |
| `MARGINALIA_GEMINI_PROJECTS` | `~/.gemini/projects.json` | Gemini project-hash to directory map |

## Sessions are never lost

The agents are not careful with their own history: Claude Code deletes transcripts after 30 days of
inactivity (`cleanupPeriodDays`, default 30; raise it in `~/.claude/settings.json`), and Codex
compresses older rollouts in place to `.jsonl.zst` and moves UI-archived threads to
`~/.codex/archived_sessions`. Marginalia therefore keeps its own zstd-compressed copy of every
transcript it indexes under `<data dir>/archive/<agent>/<id>.jsonl.zst`, including Claude subagent
transcripts. A session whose original file disappears stays in the list, marked "archived copy", and
keeps opening from the archive. The index table is only a cache: if it is rebuilt, the rows come
back from the archive. About 2,500 sessions take roughly 800 MB.

Three extra sources fill in what the agents already threw away; each is marked in the list and the
transcript header:

- **Prompt history** (`~/.claude/history.jsonl`, never cleaned up by Claude Code): every prompt of
  every deleted Claude session becomes a "prompts only" session. Entries from before 2025-10-31 carry
  no session id and are grouped per project and day. Groups that hold nothing but bare slash
  commands (`/exit`, `/mcp`) are skipped; commands with arguments count as prompts.
- **Legacy message store** (`~/.claude/__store.db`, spring 2025): full transcripts from before
  Claude Code switched to JSONL files, marked "legacy store".
- **Xcode's Claude agent** (`~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/projects`):
  the same file format in a second location, indexed like the main one.

Claude Cowork sessions are read from the desktop app's
`~/Library/Application Support/Claude/local-agent-mode-sessions` directory, which has no documented
retention either, so they are archived like everything else. Each session is an Agent SDK audit log
plus a `local_<uuid>.json` sidecar holding the title you see in the app, the folders you granted,
the system prompt, and whether the run was a scheduled task; Marginalia stores both as one
transcript, and a renamed or starred session counts as updated.

`scripts/import-fass-carve.ts` is a one-off that turns rows carved out of an old fass index with
SQLite's `.recover` into archived prompt-only sessions; anything placed in the archive directory with
a sidecar is picked up on the next refresh.

Annotations are user data and are never dropped; the session index is a cache that is rebuilt from the archive
when its schema changes or when `POST /api/reindex` is called.

## Development

```
bun run check      # typecheck, lint, tests (what CI runs)
bun test
bun run typecheck
bun run lint       # biome; `bun run lint:fix` formats
```

Design and internals are described in [docs/architecture.md](docs/architecture.md); the session file
formats the parsers understand are documented in
[docs/transcript-formats.md](docs/transcript-formats.md).
