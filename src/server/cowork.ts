import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { COWORK_HEADER_TYPE } from "../parsers/cowork";
import type { SessionBytes } from "./files";

const LOCAL_PREFIX = "local_";
const SHORT_DIR_RE = /^[0-9a-f]{8}$/;
const AUDIT_FILE = "audit.jsonl";

/**
 * Lists the audit logs under `<root>/<org>/<account>/<session>/audit.jsonl`. The session
 * directories also hold uploads and outputs, so the walk stops at the known depth instead of
 * listing everything recursively.
 */
export async function findCoworkAudits(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const org of await subdirectories(root)) {
    for (const account of await subdirectories(join(root, org))) {
      for (const session of await subdirectories(join(root, org, account))) {
        const path = join(root, org, account, session, AUDIT_FILE);
        if (await Bun.file(path).exists()) out.push(path);
      }
    }
  }
  return out;
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Finds the `local_<uuid>.json` sidecar the desktop app keeps next to a session directory. Older
 * directories are named `local_<uuid>`, newer ones by the first eight characters of the uuid.
 * Returns null when the app left no sidecar; a short name matching several sidecars is an error.
 */
export class CoworkSidecars {
  private readonly listings = new Map<string, Promise<string[]>>();

  async locate(auditPath: string): Promise<string | null> {
    const sessionDir = dirname(auditPath);
    const accountDir = dirname(sessionDir);
    const dirName = basename(sessionDir);
    const names = await this.list(accountDir);
    if (dirName.startsWith(LOCAL_PREFIX)) {
      const name = `${dirName}.json`;
      return names.includes(name) ? join(accountDir, name) : null;
    }
    if (!SHORT_DIR_RE.test(dirName)) return null;
    const matches = names.filter((n) => n.startsWith(`${LOCAL_PREFIX}${dirName}`) && n.endsWith(".json"));
    if (matches.length > 1) {
      throw new Error(`several Cowork sidecars match ${sessionDir}: ${matches.join(", ")}`);
    }
    return matches[0] ? join(accountDir, matches[0]) : null;
  }

  private list(dir: string): Promise<string[]> {
    let listing = this.listings.get(dir);
    if (!listing) {
      listing = readdir(dir);
      this.listings.set(dir, listing);
    }
    return listing;
  }
}

export interface CoworkSource extends SessionBytes {
  /** Newest of the audit log and the sidecar, so a renamed or starred session counts as updated. */
  mtimeMs: number;
}

export async function coworkMtimeMs(auditPath: string, sidecarPath: string | null): Promise<number> {
  const paths = sidecarPath === null ? [auditPath] : [auditPath, sidecarPath];
  const stats = await Promise.all(paths.map((p) => stat(p)));
  return Math.round(Math.max(...stats.map((s) => s.mtimeMs)));
}

/**
 * Composes the transcript Marginalia archives and parses: the sidecar as a `cowork_session`
 * header line followed by the audit log verbatim. The two files are one session, and keeping them
 * in one JSONL stream means the archived copy and a live read go through the same parser.
 */
export async function readCoworkSession(
  auditPath: string,
  sidecarPath: string | null,
): Promise<CoworkSource> {
  const audit = await Bun.file(auditPath).text();
  let header = "";
  if (sidecarPath !== null) {
    const sidecar: unknown = await Bun.file(sidecarPath).json();
    header = `${JSON.stringify({ type: COWORK_HEADER_TYPE, path: sidecarPath, sidecar })}\n`;
  }
  const text = header + audit;
  return {
    bytes: new TextEncoder().encode(text),
    text,
    compressed: false,
    mtimeMs: await coworkMtimeMs(auditPath, sidecarPath),
  };
}
