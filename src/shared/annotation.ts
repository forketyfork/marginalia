import type { Agent } from "./model";

export const ANNOTATION_KINDS = ["learn", "improve", "unexpected", "good", "note"] as const;

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return typeof value === "string" && (ANNOTATION_KINDS as readonly string[]).includes(value);
}

export interface KindMeta {
  label: string;
  description: string;
  shortcut: string;
}

export const KIND_META: Record<AnnotationKind, KindMeta> = {
  learn: { label: "Learn", description: "Unfamiliar term or concept to study later", shortcut: "1" },
  improve: { label: "Improve", description: "Guideline, skill, or setup change to make", shortcut: "2" },
  unexpected: {
    label: "Unexpected",
    description: "The agent did something surprising or wrong",
    shortcut: "3",
  },
  good: { label: "Good", description: "Pattern worth keeping or reusing", shortcut: "4" },
  note: { label: "Note", description: "General remark", shortcut: "5" },
};

export type AnnotationCounts = Record<AnnotationKind, number>;

export function emptyCounts(): AnnotationCounts {
  return { learn: 0, improve: 0, unexpected: 0, good: 0, note: 0 };
}

/** A text range inside one block, described the way the W3C TextQuoteSelector does so it survives re-rendering. */
export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface AnnotationTarget {
  entryId: string;
  /** null targets the whole entry. */
  blockIndex: number | null;
  /** Set when the entry lives in a Claude subagent transcript of the session. */
  agentId: string | null;
  /** null targets the whole block (or entry). */
  quote: TextQuote | null;
}

export interface Annotation {
  id: string;
  agent: Agent;
  sessionId: string;
  target: AnnotationTarget;
  kind: AnnotationKind;
  note: string;
  tags: string[];
  resolved: boolean;
  /** Short excerpt of the annotated content captured at creation, for lists outside the transcript. */
  context: string;
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationWithSession extends Annotation {
  sessionTitle: string | null;
  sessionCwd: string | null;
}

export interface AnnotationInput {
  agent: Agent;
  sessionId: string;
  target: AnnotationTarget;
  kind: AnnotationKind;
  note: string;
  tags: string[];
  context: string;
}

export interface AnnotationPatch {
  kind?: AnnotationKind;
  note?: string;
  tags?: string[];
  resolved?: boolean;
}

export function sameTarget(a: AnnotationTarget, b: AnnotationTarget): boolean {
  return a.entryId === b.entryId && a.blockIndex === b.blockIndex && a.agentId === b.agentId;
}
