# Transcript formats

What the parsers expect from each agent's session files, and how the lines map to the shared model.
Shapes were taken from real local sessions; where a shape has not been observed locally it is noted.

## Claude Code

`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, one JSON object per line. Subagent
transcripts live in `<encoded-cwd>/<session-uuid>/subagents/agent-<id>.jsonl` with the same shape
and `isSidechain: true`.

| Line `type` | Mapping |
| --- | --- |
| `user` | `user` entry; `tool_result` entry when the content holds tool results; `meta` when `isMeta`; `compact` when `isCompactSummary`; `command` when the text is a `<command-name>` record. `toolUseResult` becomes the result's `details` (minus `originalFile`). `toolUseResult.agentId` registers a subagent. |
| `assistant` | `assistant` entry. Consecutive lines with the same `message.id` are one entry. Empty `thinking` blocks (summarized thinking) are dropped; `thinkingDurationMs` is kept. `isApiErrorMessage` lines become `system` entries. |
| `system` | `system` entry labelled by `subtype` (`turn_duration`, `stop_hook_summary`, `compact_boundary`, `informational`, `model_refusal_fallback`, `away_summary`, ...); `local_command` becomes a `command` entry. |
| `attachment` | `attachment` entry labelled by `attachment.type` (`environment`, `skill_listing`, `hook_success`, `deferred_tools_record`, `prompt_snapshot`, ...). |
| `ai-title`, `agent-name`, `summary` | Session title (agent name wins over the AI title, which wins over a legacy summary, which wins over the first prompt). |
| `cost-state` | Total cost and token totals. |
| `pr-link` | Linked pull requests. |
| `permission-mode`, `mode` | Session facts. |
| `api-request`, `api-request-blob`, `api-request-shape`, `file-history-snapshot`, `file-history-delta` | Skipped before JSON parsing; counted in `info.counts.skippedLines`. |
| `last-prompt`, `atis-latch`, `queue-operation`, others | Skipped and counted. |

Session facts come from the line envelope: `cwd`, `gitBranch`, `version`, timestamps.

## Codex

`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<uuid>.jsonl`. Codex periodically compresses
older rollouts in place to `rollout-…jsonl.zst` (zstd, original mtime kept), and threads archived
from the UI live as `.jsonl.zst` under `~/.codex/archived_sessions`. All three are discovered and
decompressed on read. Two generations of the line format exist.

**Current format**: every line is `{timestamp, type, payload}`.

| Line | Mapping |
| --- | --- |
| `session_meta` | id, cwd, start time, CLI version, git branch and repository, originator. `payload.source` is a string for top-level sessions and an object for sub-sessions: `{subagent: "review"}`, `{subagent: {other: "guardian"}}`, `{subagent: {thread_spawn: {parent_thread_id, agent_nickname}}}`. |
| `turn_context` | Model, reasoning effort, approval policy, sandbox type. |
| `response_item` / `message` | `user` (or `meta` for AGENTS.md, environment, and permission wrappers, and for developer-role messages) or assistant text appended to the current assistant entry. |
| `response_item` / `reasoning` | `thinking` block from the summary texts; encrypted-only reasoning is skipped and counted. |
| `response_item` / `function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`, `tool_search_call` | `tool_use` blocks grouped with the preceding reasoning. |
| `response_item` / `function_call_output`, `custom_tool_call_output`, `tool_search_output` | `tool_result` entries. JSON envelopes `{output, metadata}` are unwrapped; failure is detected from `metadata.exit_code` or a leading `Exit code: N`. |
| `response_item` / `agent_message` | `meta` entry labelled with author and recipient (inter-agent traffic). |
| `response_item` / `compacted` | `compact` entry. |
| `response_item` / `additional_tools`, `world_state` | `attachment` entries. |
| `event_msg` / `token_count` | Token totals (last wins). |
| `event_msg` / `turn_aborted` | `system` entry. |
| other `event_msg` | Skipped and counted. |

**Legacy format (2025)**: a header line `{id, timestamp, instructions}`, `{record_type: "state"}`
lines, and response items at the top level without a `payload` wrapper. The same item handling
applies; the instructions become a `meta` entry.

## Gemini CLI

`~/.gemini/tmp/<project>/chats/session-<timestamp>-<short-id>.jsonl`.

| Line | Mapping |
| --- | --- |
| header `{sessionId, projectHash, startTime, lastUpdated}` | id, start time; `projectHash` is SHA-256 of the project directory and is resolved through `~/.gemini/projects.json`. |
| `{"$set": {lastUpdated}}` | End time. |
| `type: "user"` | `user` entry from `content[].text` or a string. |
| `type: "gemini"` | `assistant` entry: `thoughts[]` become `thinking` blocks (`**subject**` + description), `content` the text, `tokens` the usage, `model` the model. A `toolCalls[]` field is mapped to `tool_use`/`tool_result` blocks on a best-effort basis; no local session contained one, so that shape is unverified. |
| `type: "info"`, `"error"`, `"warning"` | `system` entries. |

## Reconstructed Claude sessions

Two Claude sources outlive the transcripts and are turned into Claude-format JSONL so the regular
parser reads them; both are written to the archive with `source` set in the sidecar.

- **`~/.claude/history.jsonl`**: one line per prompt, `{display, pastedContents, project, timestamp,
  sessionId?}`; `sessionId` appears from 2025-10-31. Grouped by session id, or by project and local
  day before that, and rendered as a `system` notice followed by one `user` line per prompt (`h0`,
  `h1`, ...). Bare slash commands become `<command-name>` records; groups with no real prompt are
  skipped.
- **`~/.claude/__store.db`**: tables `base_messages` (uuid, parent, session, seconds timestamp,
  type, cwd), `user_messages` (JSON message, `tool_use_result`, `is_meta`) and `assistant_messages`
  (JSON API message, model). Rows are joined by uuid and emitted as today's `user`/`assistant` lines;
  tool-result parts that predate the `type` field get it added.

## Marginalia archive

`<data dir>/archive/<agent>/<id>.jsonl.zst` holds the bytes of each indexed session, next to
`<id>.meta.json` (`sourcePath`, `sourceMtimeMs`, `archivedAt`, `source`: `file`, `history` or
`store`). Claude subagents sit under `<id>/subagents/agent-<agentId>.jsonl.zst`. Dropping a file and
sidecar into this layout is enough for the next refresh to index it.
