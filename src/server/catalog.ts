import type { Database } from "bun:sqlite";
import { type Dirent, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseClaude } from "../parsers/claude";
import { parseTranscript } from "../parsers/parse";
import { type IndexedSession, summarize, withCounts } from "../parsers/summary";
import type { AnnotationCounts, AnnotationKind } from "../shared/annotation";
import type { Agent, CatalogStatus, SessionSource, SessionSummary } from "../shared/model";
import { Archive, type ArchivedSession } from "./archive";
import type { Config } from "./config";
import { CoworkSidecars, coworkMtimeMs, findCoworkAudits, readCoworkSession } from "./cowork";
import { isSessionFile, readSessionBytes, readSessionText, type SessionBytes } from "./files";
import { groupHistory, hasRealPrompt, historyToClaudeJsonl, parseHistory } from "./history";
import { readLegacyStore } from "./legacy-store";

const log = {
  info: (msg: string) => console.log(`[catalog] ${msg}`),
  warn: (msg: string) => console.warn(`[catalog] ${msg}`),
};

export interface DiscoveredFile {
  agent: Agent;
  path: string;
  /** Newest modification time of the session's files. */
  mtimeMs: number;
  /** Cowork sessions pair the audit log with the app's metadata sidecar, when the app wrote one. */
  companion: string | null;
}

export interface RefreshStats {
  added: number;
  updated: number;
  /** Sessions whose file disappeared since the last refresh; they are kept and served from the archive. */
  missing: number;
  restored: number;
  imported: number;
  errors: number;
  durationMs: number;
}

export interface SessionFilter {
  q: string;
  agents: Agent[] | null;
  kinds: AnnotationKind[] | null;
  annotatedOnly: boolean;
  /** Sub-sessions (Codex guardian, review, spawned threads) are hidden unless asked for. */
  includeSubagents: boolean;
}

export interface SessionAnnotationStats {
  counts: AnnotationCounts;
  unresolved: number;
}

/** Where a session's bytes can be read from. */
export interface SessionLocation {
  path: string;
  archivePath: string | null;
  source: SessionSource;
  missingSince: number | null;
}

interface SessionRow {
  agent: Agent;
  id: string;
  path: string;
  cwd: string | null;
  git_branch: string | null;
  title: string;
  first_prompt: string;
  started_at: number | null;
  updated_at: number;
  model: string | null;
  version: string | null;
  user_messages: number;
  assistant_messages: number;
  tool_calls: number;
  cost_usd: number | null;
  subagents: number;
  subagent: string | null;
  parent_id: string | null;
  source: SessionSource;
  archive_path: string | null;
  missing_since: number | null;
  search_corpus: string;
}

async function walk(
  root: string,
  accept: (relativePath: string, name: string) => boolean,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (accept(full.slice(root.length), entry.name)) out.push(full);
  }
  return out;
}

export async function discoverFiles(config: Config): Promise<DiscoveredFile[]> {
  const isRollout = (name: string) => name.startsWith("rollout-") && isSessionFile(name);
  const isClaude = (rel: string, name: string) => isSessionFile(name) && !rel.includes("/subagents/");
  const claudeRoots = [config.claudeRoot, ...config.claudeExtraRoots];
  const [claudeLists, codexLive, codexArchived, gemini, coworkAudits] = await Promise.all([
    Promise.all(claudeRoots.map((root) => walk(root, isClaude))),
    walk(config.codexRoot, (_rel, name) => isRollout(name)),
    walk(config.codexArchivedRoot, (_rel, name) => isRollout(name)),
    walk(
      config.geminiRoot,
      (rel, name) => rel.includes("/chats/") && name.startsWith("session-") && isSessionFile(name),
    ),
    findCoworkAudits(config.coworkRoot),
  ]);
  const tagged: Array<[Agent, string[]]> = [
    ["claude", claudeLists.flat()],
    ["codex", [...codexLive, ...codexArchived]],
    ["gemini", gemini],
  ];
  const files: DiscoveredFile[] = [];
  for (const [agent, paths] of tagged) {
    const stats = await Promise.all(paths.map((p) => stat(p)));
    paths.forEach((path, i) => {
      const s = stats[i];
      if (s) files.push({ agent, path, mtimeMs: Math.round(s.mtimeMs), companion: null });
    });
  }
  const sidecars = new CoworkSidecars();
  for (const path of coworkAudits) {
    try {
      const companion = await sidecars.locate(path);
      files.push({ agent: "cowork", path, mtimeMs: await coworkMtimeMs(path, companion), companion });
    } catch (err) {
      log.warn(`skipping ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return files;
}

function readDiscovered(file: DiscoveredFile): Promise<SessionBytes> {
  return file.agent === "cowork" ? readCoworkSession(file.path, file.companion) : readSessionBytes(file.path);
}

/** Gemini keys sessions by SHA-256 of the project directory; `projects.json` maps directory → short name. */
export async function loadGeminiProjects(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = Bun.file(path);
  if (!(await file.exists())) return map;
  const parsed: unknown = await file.json();
  if (typeof parsed !== "object" || parsed === null) return map;
  const projects = (parsed as Record<string, unknown>).projects;
  const source = typeof projects === "object" && projects !== null ? projects : parsed;
  for (const cwd of Object.keys(source as Record<string, unknown>)) {
    const hash = new Bun.CryptoHasher("sha256").update(cwd).digest("hex");
    map.set(hash, cwd);
  }
  return map;
}

const SUBAGENT_FILE = /^agent-([0-9a-f]+)\.jsonl(\.zst)?$/i;

/**
 * The session index. Rows are only ever added or updated: when an agent deletes a file the row is
 * marked missing and the transcript keeps being served from the archive, and a dropped table is
 * rebuilt from the archive directory.
 */
export class Catalog {
  readonly archive: Archive;
  private inFlight: Promise<RefreshStats> | null = null;
  private progress = { done: 0, total: 0 };
  private lastRefreshAt: number | null = null;
  private lastErrors = 0;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {
    this.archive = new Archive(config.archiveDir);
  }

  status(): CatalogStatus {
    const total = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get();
    const missing = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions WHERE missing_since IS NOT NULL")
      .get();
    return {
      indexing: this.inFlight !== null,
      done: this.progress.done,
      total: this.progress.total,
      sessions: total?.n ?? 0,
      lastRefreshAt: this.lastRefreshAt,
      errors: this.lastErrors,
      missing: missing?.n ?? 0,
    };
  }

  /** Incrementally re-indexes changed files. Concurrent callers share one run. */
  refresh(opts: { force?: boolean } = {}): Promise<RefreshStats> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(opts.force ?? false).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(force: boolean): Promise<RefreshStats> {
    const startedAt = Date.now();
    const stats: RefreshStats = {
      added: 0,
      updated: 0,
      missing: 0,
      restored: 0,
      imported: 0,
      errors: 0,
      durationMs: 0,
    };
    const files = await discoverFiles(this.config);
    const known = new Map<
      string,
      { updated_at: number; archive_path: string | null; missing_since: number | null; source: SessionSource }
    >();
    for (const row of this.db
      .query<
        {
          path: string;
          updated_at: number;
          archive_path: string | null;
          missing_since: number | null;
          source: SessionSource;
        },
        []
      >("SELECT path, updated_at, archive_path, missing_since, source FROM sessions")
      .all()) {
      known.set(row.path, row);
    }
    const pending = files.filter((f) => {
      const row = known.get(f.path);
      return force || !row || row.updated_at !== f.mtimeMs || row.archive_path === null;
    });
    this.progress = { done: 0, total: pending.length };
    if (pending.length > 0) log.info(`indexing ${pending.length} of ${files.length} session files`);

    const geminiProjects = await loadGeminiProjects(this.config.geminiProjectsPath);
    for (const file of pending) {
      try {
        const { bytes, text, compressed } = await readDiscovered(file);
        const transcript = parseTranscript(file.agent, text, { path: file.path, geminiProjects });
        const archivePath = await this.archive.writeSession(file.agent, transcript.id, bytes, compressed, {
          sourcePath: file.path,
          sourceMtimeMs: file.mtimeMs,
          archivedAt: Date.now(),
          source: "file",
        });
        if (file.agent === "claude") await this.archiveSubagents(transcript.id, file.path);
        this.upsert(summarize(transcript, file.mtimeMs), { source: "file", archivePath, missingSince: null });
        if (known.has(file.path)) stats.updated += 1;
        else stats.added += 1;
      } catch (err) {
        stats.errors += 1;
        log.warn(`failed to index ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.progress.done += 1;
    }

    const discovered = new Set(files.map((f) => f.path));
    const markMissing = this.db.query(
      "UPDATE sessions SET missing_since = $now WHERE path = $path AND missing_since IS NULL",
    );
    const markPresent = this.db.query(
      "UPDATE sessions SET missing_since = NULL WHERE path = $path AND missing_since IS NOT NULL",
    );
    const now = Date.now();
    for (const [path, row] of known) {
      if (row.source !== "file") continue;
      if (discovered.has(path)) {
        if (row.missing_since !== null) markPresent.run({ path });
      } else if (row.missing_since === null) {
        markMissing.run({ path, now });
        stats.missing += 1;
      }
    }

    try {
      stats.restored = await this.restoreFromArchive(geminiProjects);
    } catch (err) {
      stats.errors += 1;
      log.warn(`archive sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      stats.imported += await this.importHistory(force);
    } catch (err) {
      stats.errors += 1;
      log.warn(`history import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      stats.imported += await this.importLegacyStore(force);
    } catch (err) {
      stats.errors += 1;
      log.warn(`legacy store import failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    stats.durationMs = Date.now() - startedAt;
    this.lastRefreshAt = Date.now();
    this.lastErrors = stats.errors;
    if (pending.length > 0 || stats.missing > 0 || stats.restored > 0 || stats.imported > 0) {
      log.info(
        `index refreshed in ${stats.durationMs} ms: +${stats.added} ~${stats.updated}, ${stats.missing} newly missing, ${stats.restored} restored from archive, ${stats.imported} imported, ${stats.errors} errors`,
      );
    }
    return stats;
  }

  /** Copies new or changed Claude subagent transcripts next to their session in the archive. */
  private async archiveSubagents(sessionId: string, sessionPath: string): Promise<void> {
    const dir = join(dirname(sessionPath), sessionId, "subagents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      const match = SUBAGENT_FILE.exec(name);
      if (!match?.[1]) continue;
      const source = join(dir, name);
      const sourceMtime = Math.round((await stat(source)).mtimeMs);
      const archived = await this.archive.mtimeMs(this.archive.subagentPath(sessionId, match[1]));
      if (archived !== null && archived >= sourceMtime) continue;
      const { bytes, compressed } = await readSessionBytes(source);
      await this.archive.writeSubagent(sessionId, match[1], bytes, compressed);
    }
  }

  /** Recreates rows for archived sessions that have none, which is how a rebuilt table gets its history back. */
  private async restoreFromArchive(geminiProjects: Map<string, string>): Promise<number> {
    let restored = 0;
    for (const archived of await this.archive.list()) {
      if (this.has(archived.agent, archived.id)) continue;
      try {
        restored += await this.restoreOne(archived, geminiProjects);
      } catch (err) {
        log.warn(
          `failed to restore ${archived.archivePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return restored;
  }

  private async restoreOne(archived: ArchivedSession, geminiProjects: Map<string, string>): Promise<number> {
    const text = await readSessionText(archived.archivePath);
    const source = archived.meta?.source ?? "file";
    const originalPath = source === "file" && archived.meta ? archived.meta.sourcePath : archived.archivePath;
    const transcript = parseTranscript(archived.agent, text, { path: originalPath, geminiProjects });
    const updatedAt =
      archived.meta?.sourceMtimeMs || (await this.archive.mtimeMs(archived.archivePath)) || Date.now();
    const missingSince = source === "file" && !existsSync(originalPath) ? Date.now() : null;
    this.upsert(summarize(transcript, updatedAt), {
      source,
      archivePath: archived.archivePath,
      missingSince,
    });
    return 1;
  }

  /** Adds prompt-only sessions for Claude transcripts that only survive in `history.jsonl`. */
  private async importHistory(force: boolean): Promise<number> {
    const path = this.config.claudeHistoryPath;
    const mtime = await this.archive.mtimeMs(path);
    if (mtime === null) return 0;
    if (!force && this.meta("history_mtime") === String(mtime)) return 0;
    const groups = groupHistory(parseHistory(await Bun.file(path).text()));
    let imported = 0;
    let commandOnly = 0;
    for (const group of groups) {
      if (group.entries.length === 0 || this.has("claude", group.id)) continue;
      if (!hasRealPrompt(group)) {
        commandOnly += 1;
        continue;
      }
      const jsonl = historyToClaudeJsonl(group);
      const archivePath = await this.archive.writeSession(
        "claude",
        group.id,
        new TextEncoder().encode(jsonl),
        false,
        {
          sourcePath: path,
          sourceMtimeMs: mtime,
          archivedAt: Date.now(),
          source: "history",
        },
      );
      const transcript = parseClaude(jsonl, { path: archivePath, id: group.id });
      const last = group.entries[group.entries.length - 1];
      this.upsert(summarize(transcript, last?.timestamp ?? mtime), {
        source: "history",
        archivePath,
        missingSince: null,
      });
      imported += 1;
    }
    this.setMeta("history_mtime", String(mtime));
    if (imported > 0 || commandOnly > 0) {
      log.info(
        `imported ${imported} prompt-only sessions from ${basename(path)}; skipped ${commandOnly} that held only bare slash commands`,
      );
    }
    return imported;
  }

  /** Imports the spring-2025 SQLite message store once. */
  private async importLegacyStore(force: boolean): Promise<number> {
    const path = this.config.claudeLegacyStorePath;
    const mtime = await this.archive.mtimeMs(path);
    if (mtime === null) return 0;
    if (!force && this.meta("legacy_store_mtime") === String(mtime)) return 0;
    let imported = 0;
    for (const session of readLegacyStore(path)) {
      if (this.has("claude", session.id)) continue;
      const archivePath = await this.archive.writeSession(
        "claude",
        session.id,
        new TextEncoder().encode(session.jsonl),
        false,
        {
          sourcePath: path,
          sourceMtimeMs: mtime,
          archivedAt: Date.now(),
          source: "store",
        },
      );
      const transcript = parseClaude(session.jsonl, { path: archivePath, id: session.id });
      this.upsert(summarize(transcript, transcript.endedAt ?? session.startedAt), {
        source: "store",
        archivePath,
        missingSince: null,
      });
      imported += 1;
    }
    this.setMeta("legacy_store_mtime", String(mtime));
    if (imported > 0) log.info(`imported ${imported} sessions from the legacy store ${basename(path)}`);
    return imported;
  }

  private has(agent: Agent, id: string): boolean {
    return (
      (this.db
        .query<{ n: number }, { agent: string; id: string }>(
          "SELECT COUNT(*) AS n FROM sessions WHERE agent = $agent AND id = $id",
        )
        .get({ agent, id })?.n ?? 0) > 0
    );
  }

  private meta(key: string): string | null {
    return (
      this.db
        .query<{ value: string }, { key: string }>("SELECT value FROM meta WHERE key = $key")
        .get({ key })?.value ?? null
    );
  }

  private setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ($key, $value)").run({ key, value });
  }

  private upsert(
    summary: IndexedSession,
    extra: { source: SessionSource; archivePath: string | null; missingSince: number | null },
  ): void {
    // Resuming with a different cwd can produce a second file for the same session id; the newest wins.
    this.db.transaction(() => {
      this.db.query("DELETE FROM sessions WHERE path = $path AND NOT (agent = $agent AND id = $id)").run({
        path: summary.path,
        agent: summary.agent,
        id: summary.id,
      });
      this.db
        .query(`
          INSERT OR REPLACE INTO sessions (
            agent, id, path, cwd, git_branch, title, first_prompt, started_at, updated_at, model, version,
            user_messages, assistant_messages, tool_calls, cost_usd, subagents, subagent, parent_id,
            source, archive_path, missing_since, search_corpus
          ) VALUES (
            $agent, $id, $path, $cwd, $gitBranch, $title, $firstPrompt, $startedAt, $updatedAt, $model, $version,
            $userMessages, $assistantMessages, $toolCalls, $costUsd, $subagents, $subagent, $parentId,
            $source, $archivePath, $missingSince, $searchCorpus
          )
        `)
        .run({
          ...toParams(summary),
          source: extra.source,
          archivePath: extra.archivePath,
          missingSince: extra.missingSince,
        });
    })();
  }

  list(
    filter: SessionFilter,
    annotationStats: ReadonlyMap<string, SessionAnnotationStats>,
  ): SessionSummary[] {
    const rows = this.db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC").all();
    const terms = filter.q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const out: SessionSummary[] = [];
    for (const row of rows) {
      if (filter.agents && !filter.agents.includes(row.agent)) continue;
      if (row.subagent !== null && !filter.includeSubagents) continue;
      const stats = annotationStats.get(sessionKey(row.agent, row.id));
      if (filter.annotatedOnly && !stats) continue;
      if (filter.kinds && !filter.kinds.some((k) => (stats?.counts[k] ?? 0) > 0)) continue;
      if (terms.length > 0 && !terms.every((t) => row.search_corpus.includes(t))) continue;
      const summary = withCounts(fromRow(row));
      if (stats) {
        summary.annotations = stats.counts;
        summary.unresolved = stats.unresolved;
      }
      out.push(summary);
    }
    return out;
  }

  /** Indexed sessions that declare `id` as their parent (Codex spawned threads). */
  children(agent: Agent, id: string): SessionSummary[] {
    return this.db
      .query<SessionRow, { agent: string; id: string }>(
        "SELECT * FROM sessions WHERE agent = $agent AND parent_id = $id ORDER BY started_at",
      )
      .all({ agent, id })
      .map((row) => withCounts(fromRow(row)));
  }

  get(agent: Agent, id: string): SessionSummary | null {
    const row = this.db
      .query<SessionRow, { agent: string; id: string }>(
        "SELECT * FROM sessions WHERE agent = $agent AND id = $id",
      )
      .get({ agent, id });
    return row ? withCounts(fromRow(row)) : null;
  }

  locate(agent: Agent, id: string): SessionLocation | null {
    const row = this.db
      .query<
        Pick<SessionRow, "path" | "archive_path" | "source" | "missing_since">,
        { agent: string; id: string }
      >("SELECT path, archive_path, source, missing_since FROM sessions WHERE agent = $agent AND id = $id")
      .get({ agent, id });
    return row
      ? { path: row.path, archivePath: row.archive_path, source: row.source, missingSince: row.missing_since }
      : null;
  }
}

export function sessionKey(agent: Agent, id: string): string {
  return `${agent}:${id}`;
}

function toParams(s: IndexedSession) {
  return {
    agent: s.agent,
    id: s.id,
    path: s.path,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    title: s.title,
    firstPrompt: s.firstPrompt,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    model: s.model,
    version: s.version,
    userMessages: s.userMessages,
    assistantMessages: s.assistantMessages,
    toolCalls: s.toolCalls,
    costUsd: s.costUsd,
    subagents: s.subagents,
    subagent: s.subagent,
    parentId: s.parentId,
    searchCorpus: s.searchCorpus,
  };
}

function fromRow(row: SessionRow): IndexedSession {
  return {
    agent: row.agent,
    id: row.id,
    path: row.path,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    title: row.title,
    firstPrompt: row.first_prompt,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    model: row.model,
    version: row.version,
    userMessages: row.user_messages,
    assistantMessages: row.assistant_messages,
    toolCalls: row.tool_calls,
    costUsd: row.cost_usd,
    subagents: row.subagents,
    subagent: row.subagent,
    parentId: row.parent_id,
    source: row.source,
    missingSince: row.missing_since,
    searchCorpus: row.search_corpus,
  };
}
