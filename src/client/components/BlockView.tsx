import { memo, useLayoutEffect, useRef } from "react";
import { applyHighlights, type HighlightItem } from "../anchoring";

interface Props {
  entryId: string;
  blockIndex: number;
  agentId: string | null;
  html: string;
  className?: string;
  highlights: HighlightItem[];
  onSelectAnnotation: (id: string) => void;
  onOrphans?: (ids: string[]) => void;
}

/**
 * An annotatable piece of content. The HTML is set imperatively so highlight marks can be spliced
 * into the rendered DOM without React fighting over the children.
 */
export const BlockView = memo(function BlockView({
  entryId,
  blockIndex,
  agentId,
  html,
  className,
  highlights,
  onSelectAnnotation,
  onOrphans,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    const orphans = applyHighlights(el, highlights);
    if (orphans.length > 0) onOrphans?.(orphans);
  }, [html, highlights, onOrphans]);

  return (
    <div
      ref={ref}
      className={`block${className ? ` ${className}` : ""}`}
      data-entry={entryId}
      data-block={blockIndex}
      data-agent={agentId ?? ""}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const mark = target.closest<HTMLElement>("mark.ann");
        if (mark?.dataset.ann) {
          e.stopPropagation();
          onSelectAnnotation(mark.dataset.ann);
          return;
        }
        const head = target.closest<HTMLElement>(".injected-head");
        if (head?.parentElement) head.parentElement.classList.toggle("open");
      }}
    />
  );
});
