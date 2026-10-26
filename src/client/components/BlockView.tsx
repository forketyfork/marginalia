import { memo, useLayoutEffect, useRef } from "react";
import { applyHighlights, type HighlightItem } from "../anchoring";
import { animateReveal } from "../motion";

/**
 * Injected tags live in rendered HTML rather than in a component, so their unfolding and folding is
 * driven here. A click while the body is folding reopens it.
 */
function toggleInjected(injected: HTMLElement, body: HTMLElement): void {
  for (const running of body.getAnimations()) running.cancel();
  const opening = !injected.classList.contains("open") || body.classList.contains("closing");
  body.classList.toggle("closing", !opening);
  injected.classList.add("open");
  animateReveal(body, opening).finished.then(
    () => {
      if (opening) return;
      injected.classList.remove("open");
      body.classList.remove("closing");
      for (const held of body.getAnimations()) held.cancel();
    },
    () => {},
  );
}

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
        const injected = target.closest<HTMLElement>(".injected-head")?.parentElement;
        const body = injected?.querySelector<HTMLElement>(":scope > .injected-body");
        if (injected && body) toggleInjected(injected, body);
      }}
    />
  );
});
