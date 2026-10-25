/**
 * Agent CLIs wrap injected context in pseudo-XML tags inside otherwise plain user messages.
 * Splitting them out lets the reader collapse the noise while keeping the user's own words legible.
 */
export const INJECTED_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "task-notification",
  "tools-used-before-summary",
  "user_instructions",
  "environment_context",
  "permissions instructions",
  "turn_aborted",
] as const;

export type InjectedTag = (typeof INJECTED_TAGS)[number];

export type Segment = { kind: "text"; text: string } | { kind: "tag"; tag: InjectedTag; text: string };

const escaped = INJECTED_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s"));
const TAG_RE = new RegExp(`<(${escaped.join("|")})>([\\s\\S]*?)</\\1>`, "g");

export function segmentInjected(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(TAG_RE)) {
    const idx = match.index;
    const tag = match[1] as InjectedTag;
    const body = match[2] ?? "";
    if (idx > last) {
      const between = text.slice(last, idx);
      if (between.trim().length > 0) segments.push({ kind: "text", text: between });
    }
    segments.push({ kind: "tag", tag, text: body });
    last = idx + match[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    if (rest.trim().length > 0 || segments.length === 0) segments.push({ kind: "text", text: rest });
  }
  return segments;
}

export function startsWithInjectedTag(text: string, tags: readonly InjectedTag[]): boolean {
  const stripped = text.trimStart();
  return tags.some((t) => stripped.startsWith(`<${t}>`));
}
