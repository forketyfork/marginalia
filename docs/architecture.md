# Architecture

## Shape

One Bun process serves both the JSON API and the React client (bundled by Bun from
`src/client/index.html` at startup, with hot module reload in development). State lives in a single
SQLite file: annotations (user data) and a session index (a cache). Transcripts are parsed on demand
from the agents' own files while those exist, and from Marginalia's archived copy afterwards.

```
src/shared/     types and pure logic used by both sides: transcript model, annotation model,
                quote anchoring, injected-tag segmentation, formatting
src/parsers/    one parser per agent producing the shared Transcript model, plus summarization
src/server/     config, SQLite schema, session catalog, transcript store, annotation store, HTTP API
src/client/     React UI: session list, transcript view, annotation panel, annotations page
test/           bun tests with synthetic JSONL fixtures per agent
```

## Transcript model

Every agent's file is normalized to a `Transcript`: session facts (`info`) plus an ordered list of
`Entry` objects, each with a `kind` (`user`, `assistant`, `tool_result`, `system`, `meta`,
`attachment`, `compact`, `command`) and a list of `Block`s (`text`, `thinking`, `tool_use`,
`tool_result`, `image`, `data`). The UI only knows this model; agent specifics stop at the parser.

Decisions worth knowing:

- **Entry ids are the agent's own ids** where they exist (Claude and Gemini line uuids) and
  `L<line>` otherwise (Codex). Transcript files are append-only, so both are stable, which is what
  lets annotations point at `(entryId, blockIndex)`.
- **Claude's streamed assistant lines are regrouped by API message id.** Claude Code writes one line
  per content block; the UI shows one message with thinking, text, and tool calls in order.
- **Tool results stay separate entries** and are paired to calls by `tool_use_id` on the client, so a
  result can be annotated independently of its call and orphan results still render.
- **Injected context is kept, not dropped.** Hook output, skill listings, system reminders, slash
  command records and compaction summaries are part of what the agent saw, and often what you want to
  fix. They are classified (`meta`, `attachment`, `command`, `compact`) so the UI can collapse them.
- **Request logs are skipped before JSON parsing.** Claude's `api-request*` and `file-history*` lines
  make up most of the bytes of a large session and contain no conversation; a prefix check on the raw
  line keeps a 75 MB session under 100 ms to load.
- **Large blocks are truncated for transport only.** The server keeps the full parsed transcript in a
  small LRU cache; the client fetches a single full block on request.

## Archive: the durable store

Every file the catalog indexes is copied into `<data dir>/archive/<agent>/<id>.jsonl.zst` together
with a `.meta.json` sidecar (source path, mtime, origin). Plain JSONL is zstd-compressed, already
compressed Codex rollouts are copied byte for byte, and Claude subagent transcripts land under
`<id>/subagents/`. The archive is the source of truth: a refresh marks rows whose file vanished as
`missing_since` instead of deleting them, the transcript store falls back to the archived copy, and an
empty index table is repopulated from the archive directory. Reconstructed sessions (prompt history,
legacy store, one-off salvage scripts) are written straight into the archive in Claude JSONL form and
indexed like any other file, which keeps one parser and one read path for everything. A Cowork
session is two files on disk (the Agent SDK audit log and the desktop app's metadata sidecar); the
catalog composes them into one JSONL stream, sidecar first as a `cowork_session` line, and archives
that, so a live read and an archived read go through the same parser.

## Session catalog

`Catalog` walks the agent roots (Claude has extra roots such as Xcode's agent config, Codex has a
live and an archived one, Cowork's session directory is walked at its fixed depth because it also
holds uploads and outputs), compares file mtimes with the `sessions` table, and re-parses only
changed files; a Cowork session counts as changed when either of its two files does. Rows are never
deleted; see the archive section. Concurrent refreshes share one in-flight run. The list endpoint waits briefly for an
incremental refresh and otherwise serves what is indexed so far, while the client polls `/api/status`
and reloads when indexing finishes. Search is a case-insensitive all-terms substring match over a
per-session corpus (title, cwd, branch, id, and every user prompt), evaluated in process; at a few
thousand sessions that is instant and predictable.

Codex rollouts may be zstd-compressed in place or archived under a second root; discovery accepts
`.jsonl` and `.jsonl.zst` and reads go through one helper that decompresses when needed.

Sub-sessions (Codex guardian/review threads and spawned agents, identified by
`session_meta.payload.source`) are indexed with a `subagent` label and a `parent_id`, hidden from
the default list, and linked from their parent's header. Claude subagents are separate files under
`<session>/subagents/` and are reached through the parent session, never listed on their own. Cowork
logs subagent traffic inline; lines carrying a `parent_tool_use_id` become sidechain entries of the
same transcript.

## Annotations and anchoring

An annotation targets `(agent, sessionId, entryId, blockIndex?, agentId?, quote?)`. `agentId` is set
when the entry lives in a Claude subagent transcript. `quote` follows the W3C TextQuoteSelector idea:
the exact selected text, 32 characters of prefix and suffix, and the character offsets within the
block's rendered text. Resolution tries the offsets first and falls back to searching the exact text
and scoring candidates by context, so highlights survive renderer changes; a quote that cannot be
found is reported as orphaned in the panel rather than silently dropped.

Highlights are applied by splicing `<mark>` elements into the rendered block (text nodes are split at
range boundaries and each covered piece is wrapped), which works across inline markup and gives real
elements to click. Blocks set their HTML imperatively so React does not fight the splicing.

## Rendering

Markdown is rendered with `marked` and sanitized with DOMPurify. Raw HTML in agent output is escaped
rather than interpreted: `<system-reminder>` and friends are content. Known injected tags are split
out of user messages into collapsible boxes before Markdown rendering. Emphasis pseudo-tags such as
`<IMPORTANT>` are marked up wherever they occur in text, plain output and laid-out JSON strings alike,
and a Markdown block that opens with one is rendered as Markdown instead of being frozen as escaped
HTML. Hook output (`stdout`, `stderr`) is a data block, not prose, so JSON output is laid out and
nothing in it is read as Markdown. Tool calls get tool-specific
input rendering for the common cases (shell commands, file edits as diffs, file writes, subagent
prompts, todo lists) and a key/value fallback for the rest. Entries use `content-visibility: auto` so
long sessions stay responsive without a virtualized list.

Code is highlighted with highlight.js from a fixed set of registered grammars; the language comes
from the tool (shell commands), the file path (`Write` content, `Read` results) or the fence info
string in Markdown. A one-line shell command made of several statements is laid out one statement
per line: a small scanner splits it at top-level `;` separators while respecting quotes,
substitutions and comments, compound-command keywords take their own lines, and bodies are
indented; the separators stay in the text, dimmed. The same scanner finds here-documents in multi-line
commands and in `bash` fences: each body is highlighted in the language of what reads it (an
interpreter taking its program from stdin, a database client, the file a `cat` or `tee` writes), the
operator and the terminator line are dimmed, and the shell lines around a body are highlighted in one
pass with the operators masked, so quoting that spans the body keeps its context. JSON in tool inputs, results and data blocks is laid out by a custom renderer
rather than `JSON.stringify`: long or multi-line strings become indented `"""` blocks with their real
line breaks, and a string that itself holds JSON is unfolded into nested JSON, so an MCP result that
wraps a Markdown document in a field reads as the document. `Read` results keep their line numbers in
a gutter drawn from a data attribute, so neither quotes nor copied text include them. Highlight spans
change the DOM but not the text content that quotes anchor to; the JSON layout does change the text,
so quotes anchor to the laid-out form.

Styling is one stylesheet of CSS custom properties. The light theme is the default; dark mode is a
neon theme laid over the same structure: a drifting static texture and scanlines sit above the page
as fixed pseudo-elements, and glow is applied to borders, badges, chips, marks and the brand but never
to body text, so transcripts stay readable. Kind and agent colours travel as `--kind` and `--agent`
custom properties set by the `kind-*` and `agent-*` classes, so chips, pills, badges and cards share
one rule each in both themes. Anything that opens (tool bodies, context entries, data blocks, the
composer) sits in a `reveal` wrapper whose grid row animates from zero to its content height on mount,
so it unfolds rather than pops; the session list slides rows to their new place with a FLIP animation
when a refresh reorders them and flashes a row whose session changed. All motion stops under
`prefers-reduced-motion`.
