import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { animateReveal } from "../motion";

/**
 * Content that unfolds when `open` turns true and folds away when it turns false. The children stay
 * mounted, and the last ones shown are kept, until the closing animation has finished. The initial
 * state is shown without motion, so a page of open blocks does not animate as it scrolls into view.
 */
export function Reveal({
  open,
  children,
  onClosed,
}: {
  open: boolean;
  children: ReactNode;
  onClosed?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const previous = useRef(open);
  const content = useRef(children);
  const [rendered, setRendered] = useState(open);
  if (open) content.current = children;
  if (open && !rendered) setRendered(true);

  useLayoutEffect(() => {
    if (open === previous.current) return;
    previous.current = open;
    const el = ref.current;
    if (!el) return;
    animation.current?.cancel();
    const current = animateReveal(el, open);
    animation.current = current;
    if (open) return;
    current.finished.then(
      () => {
        setRendered(false);
        onClosed?.();
      },
      () => {},
    );
  }, [open, onClosed]);

  if (!rendered) return null;
  return (
    <div ref={ref} className="reveal">
      {content.current}
    </div>
  );
}

/**
 * A `<details>` whose content unfolds and folds. The element stays open while the content is closing,
 * so the marker turns only once the motion is done. Clicks that a control inside the summary has
 * already handled (default prevented) do not toggle it.
 */
export function Disclosure({
  className,
  defaultOpen = false,
  summary,
  children,
}: {
  className: string;
  defaultOpen?: boolean;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(defaultOpen);
  const onClosed = useCallback(() => setShown(false), []);
  return (
    <details className={className} open={shown}>
      <summary
        onClick={(e) => {
          if (e.isDefaultPrevented()) return;
          e.preventDefault();
          if (open) setOpen(false);
          else {
            setShown(true);
            setOpen(true);
          }
        }}
      >
        {summary}
      </summary>
      <Reveal open={open} onClosed={onClosed}>
        {children}
      </Reveal>
    </details>
  );
}
