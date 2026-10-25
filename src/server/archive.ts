import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Agent, isAgent, type SessionSource } from "../shared/model";

export interface ArchiveMeta {
  sourcePath: string;
  sourceMtimeMs: number;
  archivedAt: number;
  source: SessionSource;
}

export interface ArchivedSession {
  agent: Agent;
  id: string;
  archivePath: string;
  meta: ArchiveMeta | null;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Marginalia's own copy of every transcript it has indexed, as zstd-compressed JSONL plus a small
 * sidecar describing where the bytes came from. The agents delete or rewrite their files; this
 * directory is what makes "sessions are never deleted" true, and it is enough to rebuild the index.
 */
export class Archive {
  constructor(readonly dir: string) {}

  sessionPath(agent: Agent, id: string): string {
    return join(this.dir, agent, `${checkId(id)}.jsonl.zst`);
  }

  metaPath(agent: Agent, id: string): string {
    return join(this.dir, agent, `${checkId(id)}.meta.json`);
  }

  subagentPath(sessionId: string, agentId: string): string {
    return join(this.dir, "claude", checkId(sessionId), "subagents", `agent-${checkId(agentId)}.jsonl.zst`);
  }

  async writeSession(
    agent: Agent,
    id: string,
    data: Uint8Array,
    alreadyCompressed: boolean,
    meta: ArchiveMeta,
  ): Promise<string> {
    const path = this.sessionPath(agent, id);
    await writeAtomic(path, alreadyCompressed ? data : Bun.zstdCompressSync(data));
    await writeAtomic(
      this.metaPath(agent, id),
      new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`),
    );
    return path;
  }

  async writeSubagent(
    sessionId: string,
    agentId: string,
    data: Uint8Array,
    alreadyCompressed: boolean,
  ): Promise<string> {
    const path = this.subagentPath(sessionId, agentId);
    await writeAtomic(path, alreadyCompressed ? data : Bun.zstdCompressSync(data));
    return path;
  }

  async readMeta(agent: Agent, id: string): Promise<ArchiveMeta | null> {
    const file = Bun.file(this.metaPath(agent, id));
    if (!(await file.exists())) return null;
    const parsed: unknown = await file.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    if (typeof m.sourcePath !== "string" || typeof m.source !== "string") return null;
    return {
      sourcePath: m.sourcePath,
      sourceMtimeMs: typeof m.sourceMtimeMs === "number" ? m.sourceMtimeMs : 0,
      archivedAt: typeof m.archivedAt === "number" ? m.archivedAt : 0,
      source: m.source === "history" || m.source === "store" ? m.source : "file",
    };
  }

  async mtimeMs(path: string): Promise<number | null> {
    try {
      return Math.round((await stat(path)).mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Every archived top-level session (subagent copies live one level deeper and are not listed). */
  async list(): Promise<ArchivedSession[]> {
    const out: ArchivedSession[] = [];
    let agents: string[];
    try {
      agents = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const agent of agents) {
      if (!isAgent(agent)) continue;
      for (const name of await readdir(join(this.dir, agent))) {
        if (!name.endsWith(".jsonl.zst")) continue;
        const id = name.slice(0, -".jsonl.zst".length);
        out.push({
          agent,
          id,
          archivePath: join(this.dir, agent, name),
          meta: await this.readMeta(agent, id),
        });
      }
    }
    return out;
  }
}

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`refusing to archive session with unsafe id "${id}"`);
  return id;
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, bytes);
  await rename(tmp, path);
}
