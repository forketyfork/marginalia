import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseTranscript } from "../parsers/parse";
import type { Agent, Block, Transcript } from "../shared/model";
import type { Catalog, SessionLocation } from "./catalog";
import { loadGeminiProjects } from "./catalog";
import type { Config } from "./config";
import { CoworkSidecars, coworkMtimeMs, readCoworkSession } from "./cowork";
import { readSessionText } from "./files";

const CACHE_SIZE = 6;
const SUBAGENT_FILE = /^agent-([0-9a-f]+)\.jsonl(\.zst)?$/i;

interface CacheEntry {
  mtimeMs: number;
  transcript: Transcript;
}

interface Source {
  mtimeMs: number;
  read: () => Promise<string>;
}

/**
 * Parses transcripts on demand and keeps the most recent few in memory. Bytes come from the
 * agent's file while it exists and from Marginalia's archive copy afterwards.
 */
export class TranscriptStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: Config,
    private readonly catalog: Catalog,
  ) {}

  async load(agent: Agent, id: string): Promise<Transcript | null> {
    const location = this.catalog.locate(agent, id);
    if (!location) return null;
    const readable = readablePath(location);
    if (!readable) return null;
    const parsed = await this.parse(agent, readable, location.path, null, readable === location.path);
    if (!parsed) return null;
    const transcript: Transcript = {
      ...parsed,
      source: location.source,
      missingSince: location.missingSince,
    };
    if (agent === "claude") await this.markAvailableSubagents(transcript);
    this.linkChildSessions(transcript);
    return transcript;
  }

  async loadSubagent(agent: Agent, id: string, agentId: string): Promise<Transcript | null> {
    if (agent !== "claude" || !/^[0-9a-f]+$/i.test(agentId)) return null;
    const location = this.catalog.locate(agent, id);
    if (!location) return null;
    const candidates = [
      subagentPath(location.path, id, agentId),
      this.catalog.archive.subagentPath(id, agentId),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    return this.parse(agent, path, candidates[0] ?? path, agentId);
  }

  async block(
    agent: Agent,
    id: string,
    agentId: string | null,
    entryId: string,
    blockIndex: number,
  ): Promise<Block | null> {
    const transcript = agentId ? await this.loadSubagent(agent, id, agentId) : await this.load(agent, id);
    const entry = transcript?.entries.find((e) => e.id === entryId);
    return entry?.blocks[blockIndex] ?? null;
  }

  private async parse(
    agent: Agent,
    readable: string,
    displayPath: string,
    agentId: string | null,
    live = false,
  ): Promise<Transcript | null> {
    let source: Source;
    try {
      source = await openSource(agent, readable, live);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const cached = this.cache.get(readable);
    if (cached && cached.mtimeMs === source.mtimeMs) {
      this.cache.delete(readable);
      this.cache.set(readable, cached);
      return cached.transcript;
    }
    const text = await source.read();
    const geminiProjects =
      agent === "gemini" ? await loadGeminiProjects(this.config.geminiProjectsPath) : new Map();
    const transcript = parseTranscript(agent, text, { path: displayPath, geminiProjects, agentId });
    this.cache.set(readable, { mtimeMs: source.mtimeMs, transcript });
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return transcript;
  }

  private linkChildSessions(transcript: Transcript): void {
    for (const child of this.catalog.children(transcript.agent, transcript.id)) {
      if (transcript.subagents.some((s) => s.sessionId === child.id)) continue;
      transcript.subagents.push({
        agentId: child.id,
        description: child.subagent ? `${child.subagent}: ${child.title}` : child.title,
        toolUseId: null,
        available: true,
        sessionId: child.id,
      });
    }
  }

  private async markAvailableSubagents(transcript: Transcript): Promise<void> {
    const dirs = [
      join(dirname(transcript.path), transcript.id, "subagents"),
      dirname(this.catalog.archive.subagentPath(transcript.id, "0")),
    ];
    const ids = new Set<string>();
    for (const dir of dirs) {
      try {
        for (const name of await readdir(dir)) {
          const match = SUBAGENT_FILE.exec(name);
          if (match?.[1]) ids.add(match[1]);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    for (const ref of transcript.subagents) {
      if (ref.sessionId === null) ref.available = ids.has(ref.agentId);
    }
    for (const id of ids) {
      if (!transcript.subagents.some((s) => s.agentId === id)) {
        transcript.subagents.push({
          agentId: id,
          description: null,
          toolUseId: null,
          available: true,
          sessionId: null,
        });
      }
    }
  }
}

/**
 * A live Cowork session is two files (audit log and sidecar) composed on read, exactly as the
 * catalog composed them for the archive; everything else is a single file.
 */
async function openSource(agent: Agent, readable: string, live: boolean): Promise<Source> {
  if (agent === "cowork" && live) {
    const sidecar = await new CoworkSidecars().locate(readable);
    return {
      mtimeMs: await coworkMtimeMs(readable, sidecar),
      read: async () => (await readCoworkSession(readable, sidecar)).text,
    };
  }
  return { mtimeMs: Math.round((await stat(readable)).mtimeMs), read: () => readSessionText(readable) };
}

function readablePath(location: SessionLocation): string | null {
  if (location.source === "file" && existsSync(location.path)) return location.path;
  if (location.archivePath && existsSync(location.archivePath)) return location.archivePath;
  return null;
}

export function subagentPath(sessionPath: string, sessionId: string, agentId: string): string {
  return join(dirname(sessionPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
}
