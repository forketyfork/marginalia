export interface SessionBytes {
  bytes: Uint8Array;
  text: string;
  /** True when the bytes on disk are already zstd-compressed (Codex rollouts, Marginalia's archive). */
  compressed: boolean;
}

/** Reads a transcript file, decompressing zstd when the extension says so. */
export async function readSessionBytes(path: string): Promise<SessionBytes> {
  const bytes = await Bun.file(path).bytes();
  const compressed = path.endsWith(".zst");
  const text = new TextDecoder().decode(compressed ? Bun.zstdDecompressSync(bytes) : bytes);
  return { bytes, text, compressed };
}

export async function readSessionText(path: string): Promise<string> {
  return (await readSessionBytes(path)).text;
}

export function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
}
