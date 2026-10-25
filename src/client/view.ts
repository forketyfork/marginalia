import type { Annotation } from "../shared/annotation";
import type { Block, Entry } from "../shared/model";
import type { HighlightItem } from "./anchoring";

export interface ViewOptions {
  showThinking: boolean;
  showContext: boolean;
  expandTools: boolean;
}

export const defaultViewOptions = (): ViewOptions => ({
  showThinking: true,
  showContext: true,
  expandTools: false,
});

export const AUX_KINDS: ReadonlySet<Entry["kind"]> = new Set([
  "system",
  "meta",
  "attachment",
  "command",
  "compact",
]);

export type ToolUseBlock = Extract<Block, { type: "tool_use" }>;
export type ToolResultBlock = Extract<Block, { type: "tool_result" }>;

export interface PairedResult {
  entry: Entry;
  blockIndex: number;
  block: ToolResultBlock;
}

export function toHighlight(a: Annotation, focusId: string | null): HighlightItem | null {
  if (!a.target.quote) return null;
  return { id: a.id, kind: a.kind, quote: a.target.quote, resolved: a.resolved, focused: a.id === focusId };
}

export function blockAnnotations(all: Annotation[], blockIndex: number): Annotation[] {
  return all.filter((a) => a.target.blockIndex === blockIndex);
}
