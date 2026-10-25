import { isObject, type JsonObject } from "./json";

export interface RawLine {
  /** 1-based line number in the source file. */
  line: number;
  value: JsonObject;
}

export interface JsonlResult {
  lines: RawLine[];
  malformed: number;
  skipped: Map<string, number>;
}

/**
 * Parses JSONL text. `classify` may return a label to skip a raw line before it is JSON-parsed,
 * which is how multi-megabyte request logs are kept out of the hot path.
 */
export function parseJsonl(text: string, classify?: (line: string) => string | null): JsonlResult {
  const lines: RawLine[] = [];
  const skipped = new Map<string, number>();
  let malformed = 0;
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo += 1;
    const line = raw.trim();
    if (line.length === 0) continue;
    if (classify) {
      const label = classify(line);
      if (label !== null) {
        skipped.set(label, (skipped.get(label) ?? 0) + 1);
        continue;
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isObject(value)) {
      malformed += 1;
      continue;
    }
    lines.push({ line: lineNo, value });
  }
  return { lines, malformed, skipped };
}
