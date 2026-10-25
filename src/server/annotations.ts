import type { Database } from "bun:sqlite";
import {
  type Annotation,
  type AnnotationInput,
  type AnnotationKind,
  type AnnotationPatch,
  type AnnotationTarget,
  type AnnotationWithSession,
  emptyCounts,
  type TextQuote,
} from "../shared/annotation";
import type { Agent } from "../shared/model";
import { type SessionAnnotationStats, sessionKey } from "./catalog";

interface AnnotationRow {
  id: string;
  agent: Agent;
  session_id: string;
  entry_id: string;
  block_index: number | null;
  agent_id: string | null;
  quote_json: string | null;
  kind: AnnotationKind;
  note: string;
  tags_json: string;
  resolved: number;
  context: string;
  created_at: number;
  updated_at: number;
  session_title?: string | null;
  session_cwd?: string | null;
}

export interface AnnotationFilter {
  agent?: Agent;
  sessionId?: string;
  kind?: AnnotationKind;
  resolved?: boolean;
  q?: string;
}

const SELECT_WITH_SESSION = `
  SELECT a.*, s.title AS session_title, s.cwd AS session_cwd
  FROM annotations a
  LEFT JOIN sessions s ON s.agent = a.agent AND s.id = a.session_id
`;

export class AnnotationStore {
  constructor(private readonly db: Database) {}

  list(filter: AnnotationFilter = {}): AnnotationWithSession[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.agent) {
      where.push("a.agent = $agent");
      params.agent = filter.agent;
    }
    if (filter.sessionId) {
      where.push("a.session_id = $sessionId");
      params.sessionId = filter.sessionId;
    }
    if (filter.kind) {
      where.push("a.kind = $kind");
      params.kind = filter.kind;
    }
    if (filter.resolved !== undefined) {
      where.push("a.resolved = $resolved");
      params.resolved = filter.resolved ? 1 : 0;
    }
    if (filter.q && filter.q.trim().length > 0) {
      where.push(
        "(instr(lower(a.note), $q) > 0 OR instr(lower(a.context), $q) > 0 OR instr(lower(a.tags_json), $q) > 0)",
      );
      params.q = filter.q.trim().toLowerCase();
    }
    const sql = `${SELECT_WITH_SESSION} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at DESC`;
    return this.db.query<AnnotationRow, Record<string, string | number>>(sql).all(params).map(fromRow);
  }

  get(id: string): AnnotationWithSession | null {
    const row = this.db
      .query<AnnotationRow, { id: string }>(`${SELECT_WITH_SESSION} WHERE a.id = $id`)
      .get({ id });
    return row ? fromRow(row) : null;
  }

  statsBySession(): Map<string, SessionAnnotationStats> {
    const rows = this.db
      .query<{ agent: Agent; session_id: string; kind: AnnotationKind; n: number; unresolved: number }, []>(
        `SELECT agent, session_id, kind, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS unresolved
         FROM annotations GROUP BY agent, session_id, kind`,
      )
      .all();
    const map = new Map<string, SessionAnnotationStats>();
    for (const row of rows) {
      const key = sessionKey(row.agent, row.session_id);
      const stats = map.get(key) ?? { counts: emptyCounts(), unresolved: 0 };
      stats.counts[row.kind] = row.n;
      stats.unresolved += row.unresolved;
      map.set(key, stats);
    }
    return map;
  }

  create(input: AnnotationInput): AnnotationWithSession {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(`
        INSERT INTO annotations (
          id, agent, session_id, entry_id, block_index, agent_id, quote_json, kind, note, tags_json, resolved,
          context, created_at, updated_at
        ) VALUES (
          $id, $agent, $sessionId, $entryId, $blockIndex, $agentId, $quote, $kind, $note, $tags, 0,
          $context, $now, $now
        )
      `)
      .run({
        id,
        agent: input.agent,
        sessionId: input.sessionId,
        entryId: input.target.entryId,
        blockIndex: input.target.blockIndex,
        agentId: input.target.agentId,
        quote: input.target.quote ? JSON.stringify(input.target.quote) : null,
        kind: input.kind,
        note: input.note,
        tags: JSON.stringify(normalizeTags(input.tags)),
        context: input.context,
        now,
      });
    const created = this.get(id);
    if (!created) throw new Error(`annotation ${id} vanished right after insert`);
    return created;
  }

  update(id: string, patch: AnnotationPatch): AnnotationWithSession | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .query(`
        UPDATE annotations SET kind = $kind, note = $note, tags_json = $tags, resolved = $resolved, updated_at = $now
        WHERE id = $id
      `)
      .run({
        id,
        kind: patch.kind ?? existing.kind,
        note: patch.note ?? existing.note,
        tags: JSON.stringify(normalizeTags(patch.tags ?? existing.tags)),
        resolved: (patch.resolved ?? existing.resolved) ? 1 : 0,
        now: Date.now(),
      });
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM annotations WHERE id = $id").run({ id });
    return result.changes > 0;
  }
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length > 0) seen.add(tag);
  }
  return [...seen];
}

function fromRow(row: AnnotationRow): AnnotationWithSession {
  const target: AnnotationTarget = {
    entryId: row.entry_id,
    blockIndex: row.block_index,
    agentId: row.agent_id,
    quote: row.quote_json ? (JSON.parse(row.quote_json) as TextQuote) : null,
  };
  const annotation: Annotation = {
    id: row.id,
    agent: row.agent,
    sessionId: row.session_id,
    target,
    kind: row.kind,
    note: row.note,
    tags: JSON.parse(row.tags_json) as string[],
    resolved: row.resolved === 1,
    context: row.context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { ...annotation, sessionTitle: row.session_title ?? null, sessionCwd: row.session_cwd ?? null };
}
