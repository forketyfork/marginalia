/**
 * Motion planning for the session list. A refresh reorders rows; each row near the viewport either
 * slides from its old place (FLIP), fades in when it is new, or flashes when its session changed.
 * The plan is pure so it can be tested; the list component applies it to the DOM.
 */

export type RowLayout = { key: string; top: number; updatedAt: number };
export type Viewport = { low: number; high: number };
/** `slide` is the offset the row starts from, relative to where it is now. */
export type RowMotion = { key: string; slide: number | null; appear: boolean; changed: boolean };

/**
 * Null means the list should simply be shown: the first paint, or a narrowed filter (rows gone), where
 * sliding everything that shifted would be noise. Rows outside the viewport before and after get no
 * motion; a flash counts only where the row is now.
 */
export function planRowMotion(
  before: RowLayout[] | null,
  after: RowLayout[],
  view: Viewport,
): RowMotion[] | null {
  if (before === null) return null;
  const previous = new Map(before.map((row) => [row.key, row]));
  const current = new Set(after.map((row) => row.key));
  for (const key of previous.keys()) if (!current.has(key)) return null;
  const inView = (top: number) => top >= view.low && top <= view.high;
  const plan: RowMotion[] = [];
  for (const row of after) {
    const old = previous.get(row.key);
    const appear = old === undefined && inView(row.top);
    const moved = old !== undefined && old.top !== row.top && (inView(row.top) || inView(old.top));
    const slide = moved && old !== undefined ? old.top - row.top : null;
    const changed = old !== undefined && old.updatedAt !== row.updatedAt && inView(row.top);
    if (appear || slide !== null || changed) plan.push({ key: row.key, slide, appear, changed });
  }
  return plan;
}
