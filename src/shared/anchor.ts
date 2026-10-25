import type { TextQuote } from "./annotation";

export const CONTEXT_CHARS = 32;

const MAX_CANDIDATES = 500;

export function makeQuote(text: string, start: number, end: number): TextQuote {
  if (start < 0 || end > text.length || start >= end) {
    throw new RangeError(`invalid quote range ${start}..${end} for text of length ${text.length}`);
  }
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_CHARS)),
    start,
    end,
  };
}

export interface Resolved {
  start: number;
  end: number;
}

/**
 * Locates a quote in the current text of its block. Offsets are tried first; when the text
 * shifted, the exact string is searched and the candidate whose surroundings best match the
 * recorded prefix/suffix wins. Returns null when the quoted text no longer exists.
 */
export function resolveQuote(text: string, quote: TextQuote): Resolved | null {
  if (quote.exact.length === 0) return null;
  if (text.slice(quote.start, quote.end) === quote.exact) {
    return { start: quote.start, end: quote.end };
  }
  const candidates: number[] = [];
  let from = 0;
  while (candidates.length < MAX_CANDIDATES) {
    const idx = text.indexOf(quote.exact, from);
    if (idx === -1) break;
    candidates.push(idx);
    from = idx + 1;
  }
  if (candidates.length === 0) return null;
  let best = candidates[0] as number;
  let bestScore = -1;
  for (const idx of candidates) {
    const score = contextScore(text, idx, quote);
    if (
      score > bestScore ||
      (score === bestScore && Math.abs(idx - quote.start) < Math.abs(best - quote.start))
    ) {
      best = idx;
      bestScore = score;
    }
  }
  return { start: best, end: best + quote.exact.length };
}

function contextScore(text: string, idx: number, quote: TextQuote): number {
  const before = text.slice(Math.max(0, idx - quote.prefix.length), idx);
  const after = text.slice(idx + quote.exact.length, idx + quote.exact.length + quote.suffix.length);
  return commonSuffixLength(before, quote.prefix) + commonPrefixLength(after, quote.suffix);
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
