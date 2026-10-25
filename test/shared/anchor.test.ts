import { describe, expect, test } from "bun:test";
import { makeQuote, resolveQuote } from "../../src/shared/anchor";

describe("quote anchoring", () => {
  const text = "The quick brown fox jumps over the lazy dog. The quick brown cat sleeps.";

  test("makeQuote captures exact text with surrounding context", () => {
    const q = makeQuote(text, 4, 9);
    expect(q).toEqual({
      exact: "quick",
      prefix: "The ",
      suffix: " brown fox jumps over the lazy d",
      start: 4,
      end: 9,
    });
  });

  test("resolves by offsets when the text is unchanged", () => {
    const q = makeQuote(text, 49, 54);
    expect(resolveQuote(text, q)).toEqual({ start: 49, end: 54 });
  });

  test("falls back to the occurrence whose context matches after the text shifted", () => {
    const q = makeQuote(text, 49, 54);
    const shifted = `PREFIX ${text}`;
    expect(resolveQuote(shifted, q)).toEqual({ start: 56, end: 61 });
    const first = makeQuote(text, 4, 9);
    expect(resolveQuote(shifted, first)).toEqual({ start: 11, end: 16 });
  });

  test("returns null when the quoted text no longer exists", () => {
    const q = makeQuote(text, 10, 15);
    expect(resolveQuote("completely different", q)).toBeNull();
    expect(resolveQuote(text, { ...q, exact: "" })).toBeNull();
  });

  test("rejects invalid ranges", () => {
    expect(() => makeQuote(text, 5, 5)).toThrow(RangeError);
    expect(() => makeQuote(text, -1, 3)).toThrow(RangeError);
  });
});
