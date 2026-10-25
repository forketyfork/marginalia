import { resolveQuote } from "../shared/anchor";
import type { AnnotationKind, TextQuote } from "../shared/annotation";

export interface HighlightItem {
  id: string;
  kind: AnnotationKind;
  quote: TextQuote;
  resolved: boolean;
  focused: boolean;
}

function textNodesOf(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

/** Character offsets of a selection range relative to `root.textContent`; null when the range leaves the root. */
export function offsetsOfRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

/**
 * Wraps the quoted ranges in `<mark>` elements. Text nodes are split at range boundaries and each
 * covered piece is wrapped individually, so a quote may span inline markup freely. Returns the ids
 * whose quote could not be found in the current text.
 */
export function applyHighlights(root: HTMLElement, items: HighlightItem[]): string[] {
  const orphans: string[] = [];
  for (const item of items) {
    const text = root.textContent ?? "";
    const resolved = resolveQuote(text, item.quote);
    if (!resolved) {
      orphans.push(item.id);
      continue;
    }
    wrap(root, resolved.start, resolved.end, item);
  }
  return orphans;
}

function wrap(root: HTMLElement, start: number, end: number, item: HighlightItem): void {
  const nodes = textNodesOf(root);
  let offset = 0;
  for (const node of nodes) {
    const length = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + length;
    offset = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end || length === 0) continue;
    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(length, end - nodeStart);
    let target = node;
    if (localEnd < length) target.splitText(localEnd);
    if (localStart > 0) target = target.splitText(localStart);
    const mark = document.createElement("mark");
    mark.className = `ann ann-${item.kind}${item.resolved ? " ann-resolved" : ""}${item.focused ? " ann-focus" : ""}`;
    mark.dataset.ann = item.id;
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
  }
}
