import { useLayoutEffect, useRef } from "react";

interface Props {
  /** Already sanitized HTML (see `renderMarkdown`); set imperatively to keep the sanitization boundary in one place. */
  html: string;
  className?: string;
}

export function Html({ html, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return <div ref={ref} className={className} />;
}
