import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeQuote } from "../../shared/anchor";
import type { Annotation, AnnotationTarget } from "../../shared/annotation";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  preview,
  shortenPath,
} from "../../shared/format";
import { AGENT_LABEL, type Agent, type Entry, type Transcript, textOfEntry } from "../../shared/model";
import { offsetsOfRange } from "../anchoring";
import * as api from "../api";
import { navigate, routeToHash } from "../router";
import { AUX_KINDS, defaultViewOptions, type PairedResult, type ViewOptions } from "../view";
import { AnnotationPanel, type Composer } from "./AnnotationPanel";
import { EntryView } from "./EntryView";
import { SelectionToolbar } from "./SelectionToolbar";

const VIEW_KEY = "marginalia.view";

function loadView(): ViewOptions {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) return { ...defaultViewOptions(), ...(JSON.parse(raw) as Partial<ViewOptions>) };
  } catch {
    // Storage unavailable or unreadable: start from defaults.
  }
  return defaultViewOptions();
}

function elementOf(node: Node): HTMLElement | null {
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
}

interface Props {
  agent: Agent;
  id: string;
  agentId: string | null;
  focus: string | null;
  onAnnotationsChanged: () => void;
}

interface PendingSelection {
  target: AnnotationTarget;
  rect: DOMRect;
}

export function SessionView({ agent, id, agentId, focus, onAnnotationsChanged }: Props) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [options, setOptions] = useState<ViewOptions>(loadView);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(focus);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [orphans, setOrphans] = useState<ReadonlySet<string>>(() => new Set());
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(options));
    } catch {
      // Persisting view options is a convenience only.
    }
  }, [options]);

  useEffect(() => {
    let cancelled = false;
    api
      .getTranscript(agent, id, agentId)
      .then((t) => {
        if (!cancelled) setTranscript(t);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agent, id, agentId]);

  const reloadAnnotations = useCallback(async () => {
    setAnnotations(await api.listAnnotations({ agent, sessionId: id }));
  }, [agent, id]);

  useEffect(() => {
    reloadAnnotations().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [reloadAnnotations]);

  const visible = useMemo(
    () => annotations.filter((a) => a.target.agentId === agentId),
    [annotations, agentId],
  );

  const byEntry = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const a of visible) {
      const list = map.get(a.target.entryId) ?? [];
      list.push(a);
      map.set(a.target.entryId, list);
    }
    return map;
  }, [visible]);

  const results = useMemo(() => {
    const map = new Map<string, PairedResult>();
    if (!transcript) return map;
    for (const entry of transcript.entries) {
      if (entry.kind !== "tool_result") continue;
      entry.blocks.forEach((block, blockIndex) => {
        if (block.type === "tool_result" && block.toolUseId && !map.has(block.toolUseId)) {
          map.set(block.toolUseId, { entry, blockIndex, block });
        }
      });
    }
    return map;
  }, [transcript]);

  const pairedEntries = useMemo(() => new Set([...results.values()].map((r) => r.entry.id)), [results]);
  const entryOrder = useMemo(
    () => new Map(transcript?.entries.map((e, i) => [e.id, i] as const) ?? []),
    [transcript],
  );

  useEffect(() => {
    const compute = () => {
      const sel = window.getSelection();
      const container = transcriptRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) {
        setPending(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setPending(null);
        return;
      }
      const startBlock = elementOf(range.startContainer)?.closest<HTMLElement>("[data-block]");
      const endBlock = elementOf(range.endContainer)?.closest<HTMLElement>("[data-block]");
      if (!startBlock || startBlock !== endBlock) {
        setPending(null);
        return;
      }
      const offsets = offsetsOfRange(startBlock, range);
      if (!offsets) {
        setPending(null);
        return;
      }
      const quote = makeQuote(startBlock.textContent ?? "", offsets.start, offsets.end);
      setPending({
        target: {
          entryId: startBlock.dataset.entry ?? "",
          blockIndex: Number(startBlock.dataset.block),
          agentId,
          quote,
        },
        rect: range.getBoundingClientRect(),
      });
    };
    const onUp = () => window.setTimeout(compute, 0);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
    };
  }, [agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPending(null);
      setComposer(null);
      setEditingId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!focusId || !transcript) return;
    const a = annotations.find((x) => x.id === focusId);
    if (!a) return;
    if (a.target.agentId !== agentId) {
      navigate({ page: "session", agent, id, agentId: a.target.agentId, focus: focusId });
      return;
    }
    document.getElementById(`entry-${a.target.entryId}`)?.scrollIntoView({ block: "center" });
  }, [focusId, transcript, annotations, agent, id, agentId]);

  const startAnnotation = useCallback((target: AnnotationTarget, context: string) => {
    setComposer({ target, context });
    setEditingId(null);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const changed = useCallback(async () => {
    await reloadAnnotations();
    onAnnotationsChanged();
  }, [reloadAnnotations, onAnnotationsChanged]);

  const onOrphans = useCallback((ids: string[]) => {
    setOrphans((prev) => {
      if (ids.every((i) => prev.has(i))) return prev;
      const next = new Set(prev);
      for (const i of ids) next.add(i);
      return next;
    });
  }, []);

  const loadFull = useCallback(
    (entryId: string, blockIndex: number) => api.getBlock(agent, id, agentId, entryId, blockIndex),
    [agent, id, agentId],
  );

  if (error) {
    return (
      <div className="empty">
        <h2>Could not load session</h2>
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!transcript) return <div className="empty muted">Loading transcript…</div>;

  return (
    <div className="session">
      <TranscriptHeader
        transcript={transcript}
        sessionId={id}
        agentId={agentId}
        options={options}
        onOptions={setOptions}
      />
      <div className="session-body">
        <div className="transcript" ref={transcriptRef}>
          {transcript.entries.map((entry) => {
            if (entry.kind === "tool_result" && pairedEntries.has(entry.id)) return null;
            const anns = byEntry.get(entry.id) ?? EMPTY;
            if (AUX_KINDS.has(entry.kind) && !options.showContext && anns.length === 0) return null;
            return (
              <EntryView
                key={entry.id}
                entry={entry}
                transcript={transcript}
                sessionId={id}
                annotations={anns}
                annotationsByEntry={byEntry}
                results={results}
                options={options}
                focusId={focusId}
                onAnnotate={startAnnotation}
                onSelectAnnotation={setFocusId}
                onOrphans={onOrphans}
                loadFull={loadFull}
              />
            );
          })}
        </div>
        <AnnotationPanel
          agent={agent}
          sessionId={id}
          annotations={visible}
          entryOrder={entryOrder}
          orphans={orphans}
          composer={composer}
          editingId={editingId}
          focusId={focusId}
          onCloseComposer={() => setComposer(null)}
          onEdit={setEditingId}
          onFocus={setFocusId}
          onChanged={changed}
        />
      </div>
      {pending && (
        <SelectionToolbar
          rect={pending.rect}
          onAnnotate={() => startAnnotation(pending.target, pending.target.quote?.exact ?? "")}
        />
      )}
    </div>
  );
}

const EMPTY: Annotation[] = [];

interface HeaderProps {
  transcript: Transcript;
  sessionId: string;
  agentId: string | null;
  options: ViewOptions;
  onOptions: (next: ViewOptions) => void;
}

function TranscriptHeader({ transcript: t, sessionId, agentId, options, onOptions }: HeaderProps) {
  const userEntries = t.entries.filter((e) => e.kind === "user");
  const duration = t.startedAt !== null && t.endedAt !== null ? t.endedAt - t.startedAt : null;
  const toggle = (key: keyof ViewOptions) => onOptions({ ...options, [key]: !options[key] });
  const jump = (entry: Entry) =>
    document.getElementById(`entry-${entry.id}`)?.scrollIntoView({ block: "start" });

  return (
    <header className="transcript-head">
      <div className="head-row">
        {agentId && (
          <a
            className="back"
            href={routeToHash({ page: "session", agent: t.agent, id: sessionId, agentId: null, focus: null })}
          >
            ← session
          </a>
        )}
        <span className={`badge agent-${t.agent}`}>{AGENT_LABEL[t.agent]}</span>
        <h1 title={t.title}>{agentId ? `Subagent ${agentId}` : t.title}</h1>
      </div>
      {t.source === "history" && (
        <div className="notice">
          Transcript deleted by Claude Code retention. Showing the prompts recovered from history.jsonl;
          assistant replies and tool calls are lost.
        </div>
      )}
      {t.source === "store" && (
        <div className="notice">
          Imported from the legacy ~/.claude/__store.db message store (spring 2025).
        </div>
      )}
      {t.missingSince !== null && (
        <div className="notice">
          The agent deleted its file on {formatDateTime(t.missingSince)}. Showing Marginalia's archived copy.
        </div>
      )}
      <div className="head-meta">
        {t.cwd && (
          <span title={t.cwd}>
            {shortenPath(t.cwd, 4)}
            {t.info.gitBranch ? ` @ ${t.info.gitBranch}` : ""}
          </span>
        )}
        {t.startedAt !== null && <span>{formatDateTime(t.startedAt)}</span>}
        {duration !== null && duration > 0 && <span>{formatDuration(duration)}</span>}
        {t.info.models.length > 0 && <span>{t.info.models.join(", ")}</span>}
        <span>
          {t.info.counts.user} prompts · {t.info.counts.toolCalls} tool calls
          {t.info.counts.toolErrors > 0 ? ` · ${t.info.counts.toolErrors} errors` : ""}
        </span>
        {t.info.costUsd !== null && t.info.costUsd > 0 && <span>{formatCost(t.info.costUsd)}</span>}
        {t.info.totalTokens && (
          <span title="input / output / cache read tokens">
            {formatTokens(t.info.totalTokens.input)} in · {formatTokens(t.info.totalTokens.output)} out ·{" "}
            {formatTokens(t.info.totalTokens.cacheRead)} cached
          </span>
        )}
        {t.info.permissionMode && <span>{t.info.permissionMode}</span>}
        {Object.entries(t.info.extra).map(([k, v]) => (
          <span key={k} title={k}>
            {k}: {v}
          </span>
        ))}
        {t.info.prLinks.map((url) => (
          <a key={url} href={url} target="_blank" rel="noopener noreferrer">
            {url.replace(/^https:\/\/github\.com\//, "")}
          </a>
        ))}
        <span className="muted" title={t.path}>
          {shortenPath(t.path, 2)}
        </span>
      </div>
      {t.subagents.length > 0 && (
        <div className="head-meta">
          <span>Subagents:</span>
          {t.subagents.map((s) => (
            <a
              key={s.agentId}
              className={s.available ? "" : "muted"}
              href={routeToHash(
                s.sessionId
                  ? { page: "session", agent: t.agent, id: s.sessionId, agentId: null, focus: null }
                  : { page: "session", agent: t.agent, id: sessionId, agentId: s.agentId, focus: null },
              )}
              title={s.available ? s.agentId : `${s.agentId} (transcript file missing)`}
            >
              {s.description ?? s.agentId}
            </a>
          ))}
        </div>
      )}
      <div className="head-controls">
        <label>
          <input type="checkbox" checked={options.showThinking} onChange={() => toggle("showThinking")} />{" "}
          thinking
        </label>
        <label>
          <input type="checkbox" checked={options.showContext} onChange={() => toggle("showContext")} />{" "}
          system & context
        </label>
        <label>
          <input type="checkbox" checked={options.expandTools} onChange={() => toggle("expandTools")} />{" "}
          expand tool calls
        </label>
        {userEntries.length > 1 && (
          <select
            value=""
            onChange={(e) => {
              const entry = userEntries[Number(e.target.value)];
              if (entry) jump(entry);
            }}
          >
            <option value="">Jump to turn…</option>
            {userEntries.map((e, i) => (
              <option key={e.id} value={i}>
                #{e.turn} {preview(textOfEntry(e), 70)}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}
