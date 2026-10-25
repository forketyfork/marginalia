import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  claudeRoot: string;
  /** Other directories in the Claude Code layout, such as Xcode's coding-assistant config. */
  claudeExtraRoots: string[];
  claudeHistoryPath: string;
  claudeLegacyStorePath: string;
  codexRoot: string;
  codexArchivedRoot: string;
  geminiRoot: string;
  geminiProjectsPath: string;
  /** Where Marginalia keeps its own compressed copy of every transcript it has indexed. */
  archiveDir: string;
  port: number;
  hostname: string;
  development: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = homedir();
  const dataDir = env.MARGINALIA_DATA_DIR ?? join(home, ".local", "share", "marginalia");
  const portRaw = env.MARGINALIA_PORT ?? "4747";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MARGINALIA_PORT must be a port number, got "${portRaw}"`);
  }
  return {
    dataDir,
    dbPath: join(dataDir, "marginalia.sqlite"),
    claudeRoot: env.MARGINALIA_CLAUDE_ROOT ?? join(home, ".claude", "projects"),
    claudeExtraRoots:
      env.MARGINALIA_CLAUDE_EXTRA_ROOTS === undefined
        ? [join(home, "Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig", "projects")]
        : env.MARGINALIA_CLAUDE_EXTRA_ROOTS.split(":").filter((p) => p.length > 0),
    claudeHistoryPath: env.MARGINALIA_CLAUDE_HISTORY ?? join(home, ".claude", "history.jsonl"),
    claudeLegacyStorePath: env.MARGINALIA_CLAUDE_LEGACY_STORE ?? join(home, ".claude", "__store.db"),
    codexRoot: env.MARGINALIA_CODEX_ROOT ?? join(home, ".codex", "sessions"),
    codexArchivedRoot: env.MARGINALIA_CODEX_ARCHIVED_ROOT ?? join(home, ".codex", "archived_sessions"),
    geminiRoot: env.MARGINALIA_GEMINI_ROOT ?? join(home, ".gemini", "tmp"),
    geminiProjectsPath: env.MARGINALIA_GEMINI_PROJECTS ?? join(home, ".gemini", "projects.json"),
    archiveDir: env.MARGINALIA_ARCHIVE_DIR ?? join(dataDir, "archive"),
    port,
    hostname: env.MARGINALIA_HOST ?? "127.0.0.1",
    development: env.NODE_ENV !== "production",
  };
}
