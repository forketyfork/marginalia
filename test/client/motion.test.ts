import { describe, expect, test } from "bun:test";
import { planRowMotion, type RowLayout } from "../../src/client/motion";

const view = { low: 0, high: 600 };
const row = (key: string, top: number, updatedAt = 1): RowLayout => ({ key, top, updatedAt });

describe("planRowMotion", () => {
  test("shows the list at once on first paint and when rows disappeared", () => {
    expect(planRowMotion(null, [row("a", 0)], view)).toBeNull();
    expect(planRowMotion([row("a", 0), row("b", 60)], [row("a", 0)], view)).toBeNull();
  });

  test("slides moved rows, fades new ones in and flashes changed ones, near the viewport only", () => {
    const before = [row("a", 0), row("b", 60), row("c", 120), row("far", 5000), row("farther", 6000)];
    const after = [
      row("new", 0),
      row("b", 60, 2),
      row("a", 120),
      row("c", 180),
      row("far", 5060),
      row("farther", 6060),
    ];
    expect(planRowMotion(before, after, view)).toEqual([
      { key: "new", slide: null, appear: true, changed: false },
      { key: "b", slide: null, appear: false, changed: true },
      { key: "a", slide: -120, appear: false, changed: false },
      { key: "c", slide: -60, appear: false, changed: false },
    ]);
  });

  test("slides a row that left or entered the viewport but not one that stayed out of it", () => {
    const before = [row("a", 100), row("b", 5000)];
    const after = [row("b", 100), row("a", 5000)];
    expect(planRowMotion(before, after, view)).toEqual([
      { key: "b", slide: 4900, appear: false, changed: false },
      { key: "a", slide: -4900, appear: false, changed: false },
    ]);
    expect(planRowMotion([row("x", 5000, 1)], [row("x", 5100, 2)], view)).toEqual([]);
  });
});
