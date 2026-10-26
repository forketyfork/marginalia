import { useEffect, useMemo, useState } from "react";
import { isObject } from "../../parsers/json";
import type { Annotation, AnnotationTarget } from "../../shared/annotation";
import { formatBytes, formatDuration, formatTime, preview } from "../../shared/format";
import type { Agent, Block, Entry } from "../../shared/model";
import { routeToHash } from "../router";
import { renderToolInput, renderToolResult, resultDetailsHtml, toolSummary } from "../tools";
import { type PairedResult, type ToolUseBlock, toHighlight, type ViewOptions } from "../view";
import { BlockView } from "./BlockView";
import { BlockChips } from "./EntryView";
import { Html } from "./Html";

interface Props {
  agent: Agent;
  sessionId: string;
  agentId: string | null;
  entry: Entry;
  blockIndex: number;
  block: ToolUseBlock;
  result: PairedResult | null;
  callAnnotations: Annotation[];
  resultAnnotations: Annotation[];
  options: ViewOptions;
  focusId: string | null;
  onAnnotate: (target: AnnotationTarget, context: string) => void;
  onSelectAnnotation: (id: string) => void;
  onOrphans: (ids: string[]) => void;
  loadFull: (entryId: string, blockIndex: number) => Promise<Block>;
}

const nonNull = <T,>(x: T | null): x is T => x !== null;

export function ToolCallCard(props: Props) {
  const { agent, sessionId, agentId, entry, blockIndex, block, result, callAnnotations, resultAnnotations } =
    props;
  const { options, focusId, onAnnotate, onSelectAnnotation, onOrphans, loadFull } = props;
  const [open, setOpen] = useState(options.expandTools);
  const [fullText, setFullText] = useState<string | null>(null);

  useEffect(() => setOpen(options.expandTools), [options.expandTools]);

  const resultBlockAnnotations = useMemo(
    () => (result ? resultAnnotations.filter((a) => a.target.blockIndex === result.blockIndex) : []),
    [result, resultAnnotations],
  );
  const anyFocused = [...callAnnotations, ...resultBlockAnnotations].some((a) => a.id === focusId);
  useEffect(() => {
    if (anyFocused) setOpen(true);
  }, [anyFocused]);

  const callHighlights = useMemo(
    () => callAnnotations.map((a) => toHighlight(a, focusId)).filter(nonNull),
    [callAnnotations, focusId],
  );
  const resultHighlights = useMemo(
    () => resultBlockAnnotations.map((a) => toHighlight(a, focusId)).filter(nonNull),
    [resultBlockAnnotations, focusId],
  );
  const chips = [...callAnnotations, ...resultBlockAnnotations].filter((a) => a.target.quote === null);

  const inputHtml = useMemo(() => renderToolInput(block, result?.block.details ?? null), [block, result]);
  const resultHtml = useMemo(() => {
    if (!result) return "";
    return renderToolResult(fullText === null ? result.block : { ...result.block, text: fullText }, block);
  }, [result, fullText, block]);
  const detailsHtml = useMemo(() => (result ? resultDetailsHtml(result.block.details) : null), [result]);

  const isError = result?.block.isError ?? false;
  const elapsed =
    result && result.entry.timestamp !== null && entry.timestamp !== null
      ? result.entry.timestamp - entry.timestamp
      : null;
  const details = result?.block.details;
  const subagentId = isObject(details) && typeof details.agentId === "string" ? details.agentId : null;
  const summary = toolSummary(block);

  return (
    <div className={`tool${isError ? " error" : ""}${open ? " open" : ""}${anyFocused ? " focus" : ""}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary" title={summary}>
          {summary}
        </span>
        <span className={`tool-status ${!result ? "pending" : isError ? "error" : "ok"}`}>
          {!result ? "no result" : isError ? "error" : "ok"}
        </span>
        {elapsed !== null && elapsed >= 0 && <span className="muted">{formatDuration(elapsed)}</span>}
        <BlockChips chips={chips} onSelect={onSelectAnnotation} />
        <span className="spacer" />
        <span className="tool-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="link"
            onClick={() =>
              onAnnotate(
                { entryId: entry.id, blockIndex, agentId, quote: null },
                `${block.name}: ${preview(summary, 200)}`,
              )
            }
          >
            annotate call
          </button>
          {result && (
            <button
              type="button"
              className="link"
              onClick={() =>
                onAnnotate(
                  { entryId: result.entry.id, blockIndex: result.blockIndex, agentId, quote: null },
                  preview(result.block.text, 300),
                )
              }
            >
              annotate result
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="section-label">Input</div>
            <BlockView
              entryId={entry.id}
              blockIndex={blockIndex}
              agentId={agentId}
              html={inputHtml}
              className="tool-input"
              highlights={callHighlights}
              onSelectAnnotation={onSelectAnnotation}
              onOrphans={onOrphans}
            />
          </div>
          {result && (
            <div className="tool-section">
              <div className="section-label">
                Result{result.entry.timestamp !== null ? ` · ${formatTime(result.entry.timestamp)}` : ""}
              </div>
              <BlockView
                entryId={result.entry.id}
                blockIndex={result.blockIndex}
                agentId={agentId}
                html={resultHtml}
                className={`tool-result${isError ? " error" : ""}`}
                highlights={resultHighlights}
                onSelectAnnotation={onSelectAnnotation}
                onOrphans={onOrphans}
              />
              {result.block.truncated && fullText === null && (
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    const full = await loadFull(result.entry.id, result.blockIndex);
                    if (full.type === "tool_result") setFullText(full.text);
                  }}
                >
                  Show full result ({formatBytes(result.block.fullLength)})
                </button>
              )}
              {subagentId && (
                <a
                  className="subagent-link"
                  href={routeToHash({
                    page: "session",
                    agent,
                    id: sessionId,
                    agentId: subagentId,
                    focus: null,
                  })}
                >
                  Open subagent transcript →
                </a>
              )}
              {detailsHtml && (
                <details className="data">
                  <summary>Details</summary>
                  <Html className="tool-details" html={detailsHtml} />
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
