import { useEffect, useLayoutEffect, useRef } from "react";
import { ANNOTATION_KINDS, type AnnotationKind, KIND_META } from "../../shared/annotation";
import { formatCost, formatRelative, shortenPath } from "../../shared/format";
import { AGENT_LABEL, AGENTS, type Agent, type SessionSummary, SOURCE_LABEL } from "../../shared/model";
import { planRowMotion, type RowLayout } from "../motion";
import { routeToHash } from "../router";

export interface SessionFilters {
  q: string;
  agents: Agent[];
  kinds: AnnotationKind[];
  annotatedOnly: boolean;
  includeSubagents: boolean;
}

export const defaultFilters = (): SessionFilters => ({
  q: "",
  agents: [],
  kinds: [],
  annotatedOnly: false,
  includeSubagents: false,
});

interface Props {
  sessions: SessionSummary[] | null;
  filters: SessionFilters;
  onFilters: (next: SessionFilters) => void;
  error: string | null;
  selected: { agent: Agent; id: string } | null;
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Rows this close to the visible part of the list animate; the rest simply take their new place. */
const VIEW_MARGIN = 200;
const MOVE_MS = 320;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function dayLabel(ms: number, now: Date): string {
  const d = new Date(ms);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SessionList({ sessions, filters, onFilters, error, selected }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useRef<RowLayout[] | null>(null);

  /**
   * A refresh reorders the list: rows slide from where they were to where they are (FLIP), new rows
   * fade in, and a row whose session changed flashes. Only rows near the viewport animate. The first
   * paint and a narrowed filter (some rows gone) show the new list at once.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || sessions === null) return;
    const updatedAt = new Map(sessions.map((s) => [`${s.agent}:${s.id}`, s.updatedAt]));
    const rows = new Map(
      [...list.querySelectorAll<HTMLElement>("[data-key]")].map((row) => [row.dataset.key ?? "", row]),
    );
    const after = [...rows].map(([key, row]) => ({
      key,
      top: row.offsetTop,
      updatedAt: updatedAt.get(key) ?? 0,
    }));
    const view = {
      low: list.scrollTop - VIEW_MARGIN,
      high: list.scrollTop + list.clientHeight + VIEW_MARGIN,
    };
    const plan = planRowMotion(layout.current, after, view);
    layout.current = after;
    if (plan === null || reducedMotion()) return;
    const timing = { duration: MOVE_MS, easing: "ease-out" };
    for (const motion of plan) {
      const row = rows.get(motion.key);
      if (!row) continue;
      if (motion.appear) row.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      if (motion.slide !== null)
        row.animate([{ transform: `translateY(${motion.slide}px)` }, { transform: "none" }], timing);
      if (motion.changed) {
        const link = row.querySelector<HTMLElement>(".session-row");
        if (link) {
          link.classList.add("touched");
          link.addEventListener("animationend", () => link.classList.remove("touched"), { once: true });
        }
      }
    }
  }, [sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = new Date();
  let lastDay = "";

  return (
    <aside className="sidebar">
      <div className="filters">
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Search prompts, titles, paths…  ( / )"
          value={filters.q}
          onChange={(e) => onFilters({ ...filters, q: e.target.value })}
        />
        <div className="chips">
          {AGENTS.map((agent) => (
            <button
              type="button"
              key={agent}
              className={`chip agent-${agent}${filters.agents.includes(agent) ? " on" : ""}`}
              onClick={() => onFilters({ ...filters, agents: toggle(filters.agents, agent) })}
              title={AGENT_LABEL[agent]}
            >
              {agent}
            </button>
          ))}
        </div>
        <div className="chips">
          {ANNOTATION_KINDS.map((kind) => (
            <button
              type="button"
              key={kind}
              className={`chip kind-${kind}${filters.kinds.includes(kind) ? " on" : ""}`}
              onClick={() => onFilters({ ...filters, kinds: toggle(filters.kinds, kind) })}
              title={`Only sessions with “${KIND_META[kind].label}” annotations`}
            >
              {KIND_META[kind].label}
            </button>
          ))}
          <button
            type="button"
            className={`chip${filters.annotatedOnly ? " on" : ""}`}
            onClick={() => onFilters({ ...filters, annotatedOnly: !filters.annotatedOnly })}
            title="Only sessions with any annotation"
          >
            annotated
          </button>
          <button
            type="button"
            className={`chip${filters.includeSubagents ? " on" : ""}`}
            onClick={() => onFilters({ ...filters, includeSubagents: !filters.includeSubagents })}
            title="Also list sub-sessions (Codex guardian, review, and spawned threads)"
          >
            sub-sessions
          </button>
        </div>
      </div>
      <div className="session-list" ref={listRef}>
        {error && <div className="error">{error}</div>}
        {sessions === null && !error && <div className="muted pad">Loading…</div>}
        {sessions && sessions.length === 0 && <div className="muted pad">No sessions match.</div>}
        {sessions?.map((s) => {
          const day = dayLabel(s.updatedAt, now);
          const header = day !== lastDay ? <div className="day">{day}</div> : null;
          lastDay = day;
          const isSelected = selected?.agent === s.agent && selected.id === s.id;
          const total = Object.values(s.annotations).reduce((a, b) => a + b, 0);
          return (
            <div key={`${s.agent}:${s.id}`} data-key={`${s.agent}:${s.id}`}>
              {header}
              <a
                className={`session-row${isSelected ? " selected" : ""}`}
                href={routeToHash({ page: "session", agent: s.agent, id: s.id, agentId: null, focus: null })}
                title={s.firstPrompt}
              >
                <div className="row-top">
                  <span className={`badge agent-${s.agent}`}>{s.agent}</span>
                  {s.subagent && <span className="badge sub">{s.subagent}</span>}
                  {s.source !== "file" && <span className="badge sub">{SOURCE_LABEL[s.source]}</span>}
                  {s.missingSince !== null && (
                    <span
                      className="badge sub"
                      title="The agent deleted its file; Marginalia serves its archived copy"
                    >
                      archived copy
                    </span>
                  )}
                  <span className="title">{s.title}</span>
                </div>
                <div className="row-meta">
                  {s.cwd && <span className="cwd">{shortenPath(s.cwd)}</span>}
                  <span>{formatRelative(s.updatedAt)}</span>
                  <span>{s.userMessages} prompts</span>
                  {s.costUsd !== null && s.costUsd > 0 && <span>{formatCost(s.costUsd)}</span>}
                  {s.subagents > 0 && <span>{s.subagents} subagents</span>}
                </div>
                {total > 0 && (
                  <div className="row-ann">
                    {ANNOTATION_KINDS.filter((k) => s.annotations[k] > 0).map((k) => (
                      <span key={k} className={`pill kind-${k}`} title={KIND_META[k].label}>
                        {s.annotations[k]}
                      </span>
                    ))}
                    {s.unresolved === 0 && <span className="pill done">all resolved</span>}
                  </div>
                )}
              </a>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
