import { memo, useCallback, useMemo, useState } from "react";
import type { Annotation, AnnotationTarget } from "../../shared/annotation";
import { KIND_META } from "../../shared/annotation";
import { formatDuration, formatTime, formatTokens, preview } from "../../shared/format";
import { segmentInjected } from "../../shared/injected";
import { AGENT_LABEL, type Block, type Entry, type Transcript, textOfEntry } from "../../shared/model";
import type { HighlightItem } from "../anchoring";
import { escapeHtml, renderPlain } from "../html";
import { renderJsonOrPlain } from "../json";
import { renderMarkdown } from "../markdown";
import { renderToolResult } from "../tools";
import { AUX_KINDS, type PairedResult, toHighlight, type ViewOptions } from "../view";
import { BlockView } from "./BlockView";
import { ToolCallCard } from "./ToolCallCard";

export interface EntryProps {
  entry: Entry;
  transcript: Transcript;
  sessionId: string;
  annotations: Annotation[];
  annotationsByEntry: Map<string, Annotation[]>;
  results: Map<string, PairedResult>;
  options: ViewOptions;
  focusId: string | null;
  onAnnotate: (target: AnnotationTarget, context: string) => void;
  onSelectAnnotation: (id: string) => void;
  onOrphans: (ids: string[]) => void;
  loadFull: (entryId: string, blockIndex: number) => Promise<Block>;
}

const NO_HIGHLIGHTS: HighlightItem[] = [];

export function textHtml(text: string): string {
  return segmentInjected(text)
    .map((seg) => {
      if (seg.kind === "text") return `<div class="md">${renderMarkdown(seg.text)}</div>`;
      switch (seg.tag) {
        case "command-name":
          return `<div class="cmd">${escapeHtml(seg.text.trim())}</div>`;
        case "command-message":
          return "";
        case "command-args":
          return seg.text.trim() ? `<div class="cmd-args">${escapeHtml(seg.text.trim())}</div>` : "";
        default:
          return `<div class="injected"><div class="injected-head" data-tag="${escapeHtml(seg.tag)}"></div><div class="injected-body reveal"><div>${renderPlain(seg.text.trim())}</div></div></div>`;
      }
    })
    .join("");
}

function entryTitle(entry: Entry, transcript: Transcript): string {
  switch (entry.kind) {
    case "user":
      return "You";
    case "assistant":
      return AGENT_LABEL[transcript.agent];
    case "tool_result":
      return "Tool result";
    case "compact":
      return "Compact summary";
    case "command":
      return entry.label ? `Command ${entry.label}` : "Command";
    case "attachment":
      return `Context · ${entry.label ?? "attachment"}`;
    case "meta":
      return entry.label ? `Injected · ${entry.label}` : "Injected";
    case "system":
      return `System · ${entry.label ?? "event"}`;
  }
}

export const EntryView = memo(function EntryView(props: EntryProps) {
  const {
    entry,
    transcript,
    annotations,
    options,
    focusId,
    onAnnotate,
    onSelectAnnotation,
    onOrphans,
    loadFull,
  } = props;
  const agentId = transcript.agentId;
  const [auxOpen, setAuxOpen] = useState(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<number, string>>(() => new Map());

  const highlightsByBlock = useMemo(() => {
    const map = new Map<number, HighlightItem[]>();
    for (const a of annotations) {
      if (a.target.blockIndex === null) continue;
      const h = toHighlight(a, focusId);
      if (!h) continue;
      const list = map.get(a.target.blockIndex) ?? [];
      list.push(h);
      map.set(a.target.blockIndex, list);
    }
    return map;
  }, [annotations, focusId]);

  const entryLevel = annotations.filter((a) => a.target.blockIndex === null);
  const blockLevel = (i: number) =>
    annotations.filter((a) => a.target.blockIndex === i && a.target.quote === null);
  const focused = annotations.some((a) => a.id === focusId);
  const isAux = AUX_KINDS.has(entry.kind);

  const loadBlock = useCallback(
    async (i: number) => {
      const full = await loadFull(entry.id, i);
      const text =
        full.type === "image"
          ? ""
          : full.type === "tool_use"
            ? JSON.stringify(full.input, null, 2)
            : full.text;
      setOverrides((prev) => new Map(prev).set(i, text));
    },
    [entry.id, loadFull],
  );

  const annotateEntry = () =>
    onAnnotate(
      { entryId: entry.id, blockIndex: null, agentId, quote: null },
      preview(textOfEntry(entry), 300),
    );

  const renderBlock = (block: Block, i: number) => {
    const highlights = highlightsByBlock.get(i) ?? NO_HIGHLIGHTS;
    const chips = blockLevel(i);
    const text = overrides.get(i);
    switch (block.type) {
      case "text": {
        return (
          <div key={i} className="block-wrap">
            <BlockView
              entryId={entry.id}
              blockIndex={i}
              agentId={agentId}
              html={textHtml(text ?? block.text)}
              className="text"
              highlights={highlights}
              onSelectAnnotation={onSelectAnnotation}
              onOrphans={onOrphans}
            />
            {block.truncated && text === undefined && (
              <button type="button" className="link" onClick={() => void loadBlock(i)}>
                Show all {block.fullLength?.toLocaleString("en-US")} characters
              </button>
            )}
          </div>
        );
      }
      case "thinking": {
        if (!options.showThinking && highlights.length === 0 && chips.length === 0) return null;
        return (
          <details key={i} className="thinking" open>
            <summary>
              Thinking
              {entry.thinkingMs !== null && i === entry.blocks.findIndex((b) => b.type === "thinking")
                ? ` · ${formatDuration(entry.thinkingMs)}`
                : ""}
              <BlockChips chips={chips} onSelect={onSelectAnnotation} />
              <button
                type="button"
                className="link"
                onClick={(e) => {
                  e.preventDefault();
                  onAnnotate(
                    { entryId: entry.id, blockIndex: i, agentId, quote: null },
                    preview(block.text, 300),
                  );
                }}
              >
                annotate
              </button>
            </summary>
            <BlockView
              entryId={entry.id}
              blockIndex={i}
              agentId={agentId}
              html={`<div class="md">${renderMarkdown(text ?? block.text)}</div>`}
              highlights={highlights}
              onSelectAnnotation={onSelectAnnotation}
              onOrphans={onOrphans}
            />
            {block.truncated && text === undefined && (
              <button type="button" className="link" onClick={() => void loadBlock(i)}>
                Show all {block.fullLength?.toLocaleString("en-US")} characters
              </button>
            )}
          </details>
        );
      }
      case "tool_use": {
        const result = props.results.get(block.id) ?? null;
        return (
          <ToolCallCard
            key={i}
            agent={transcript.agent}
            sessionId={props.sessionId}
            agentId={agentId}
            entry={entry}
            blockIndex={i}
            block={block}
            result={result}
            callAnnotations={annotations.filter((a) => a.target.blockIndex === i)}
            resultAnnotations={result ? (props.annotationsByEntry.get(result.entry.id) ?? []) : []}
            options={options}
            focusId={focusId}
            onAnnotate={onAnnotate}
            onSelectAnnotation={onSelectAnnotation}
            onOrphans={onOrphans}
            loadFull={loadFull}
          />
        );
      }
      case "tool_result":
        return (
          <div key={i} className="tool open orphan">
            <div className="tool-head">
              <span className="tool-name">Result for {block.toolUseId || "unknown call"}</span>
              <BlockChips chips={chips} onSelect={onSelectAnnotation} />
            </div>
            <div className="tool-body">
              <BlockView
                entryId={entry.id}
                blockIndex={i}
                agentId={agentId}
                html={renderToolResult({ ...block, text: text ?? block.text }, null)}
                className="tool-result"
                highlights={highlights}
                onSelectAnnotation={onSelectAnnotation}
                onOrphans={onOrphans}
              />
            </div>
          </div>
        );
      case "image":
        return block.image.data ? (
          <img
            key={i}
            className="user-image"
            alt="attached"
            src={`data:${block.image.mediaType};base64,${block.image.data}`}
          />
        ) : (
          <div key={i} className="caption">
            image ({block.image.mediaType}) omitted: too large
          </div>
        );
      case "data":
        return (
          <details key={i} className="data" open={isAux}>
            <summary>
              {block.label}
              <BlockChips chips={chips} onSelect={onSelectAnnotation} />
            </summary>
            <div className="reveal">
              <BlockView
                entryId={entry.id}
                blockIndex={i}
                agentId={agentId}
                html={renderJsonOrPlain(text ?? block.text)}
                highlights={highlights}
                onSelectAnnotation={onSelectAnnotation}
                onOrphans={onOrphans}
              />
              {block.truncated && text === undefined && (
                <button type="button" className="link" onClick={() => void loadBlock(i)}>
                  Show all {block.fullLength.toLocaleString("en-US")} characters
                </button>
              )}
            </div>
          </details>
        );
    }
  };

  const summaryText = isAux ? preview(textOfEntry(entry), 220) : "";

  return (
    <article
      id={`entry-${entry.id}`}
      className={`entry entry-${entry.kind}${focused ? " focus" : ""}${entry.isSidechain ? " sidechain" : ""}${isAux && !auxOpen ? " collapsed" : ""}`}
      data-turn={entry.turn}
    >
      <header className="entry-head" onClick={isAux ? () => setAuxOpen((o) => !o) : undefined}>
        <span className="who">{entryTitle(entry, transcript)}</span>
        {entry.kind === "user" && <span className="turn">#{entry.turn}</span>}
        {entry.model && <span className="muted">{entry.model}</span>}
        {entry.level && entry.level !== "info" && (
          <span className={`level level-${entry.level}`}>{entry.level}</span>
        )}
        {entry.timestamp !== null && <span className="time">{formatTime(entry.timestamp)}</span>}
        {entry.usage && entry.usage.output > 0 && (
          <span className="muted" title="output tokens (thinking)">
            {formatTokens(entry.usage.output)} out
            {entry.usage.thinking > 0 ? ` (${formatTokens(entry.usage.thinking)} thinking)` : ""}
          </span>
        )}
        {entry.stopReason && entry.stopReason !== "tool_use" && entry.stopReason !== "end_turn" && (
          <span className="level level-warning">{entry.stopReason}</span>
        )}
        {isAux && !auxOpen && <span className="aux-summary">{summaryText}</span>}
        <span className="spacer" />
        {entryLevel.map((a) => (
          <button
            type="button"
            key={a.id}
            className={`pill kind-${a.kind}${a.resolved ? " resolved" : ""}${a.id === focusId ? " focus" : ""}`}
            title={a.note || KIND_META[a.kind].label}
            onClick={(e) => {
              e.stopPropagation();
              onSelectAnnotation(a.id);
            }}
          >
            {KIND_META[a.kind].label}
          </button>
        ))}
        <button
          type="button"
          className="link annotate"
          onClick={(e) => {
            e.stopPropagation();
            annotateEntry();
          }}
        >
          annotate
        </button>
      </header>
      {!isAux && <div className="entry-body">{entry.blocks.map(renderBlock)}</div>}
      {isAux && auxOpen && (
        <div className="reveal">
          <div className="entry-body">{entry.blocks.map(renderBlock)}</div>
        </div>
      )}
    </article>
  );
});

export function BlockChips({ chips, onSelect }: { chips: Annotation[]; onSelect: (id: string) => void }) {
  if (chips.length === 0) return null;
  return (
    <span className="chips inline">
      {chips.map((a) => (
        <button
          type="button"
          key={a.id}
          className={`pill kind-${a.kind}${a.resolved ? " resolved" : ""}`}
          title={a.note || KIND_META[a.kind].label}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(a.id);
          }}
        >
          {KIND_META[a.kind].label}
        </button>
      ))}
    </span>
  );
}
