import { useEffect, useMemo, useState } from "react";
import {
  ANNOTATION_KINDS,
  type AnnotationKind,
  type AnnotationWithSession,
  KIND_META,
} from "../../shared/annotation";
import { formatDateTime, shortenPath } from "../../shared/format";
import { AGENTS, type Agent } from "../../shared/model";
import * as api from "../api";
import { renderMarkdown } from "../markdown";
import { routeToHash } from "../router";
import { targetLabel } from "./AnnotationPanel";
import { Html } from "./Html";

interface Props {
  onChanged: () => void;
}

type ResolvedFilter = "open" | "all" | "done";

export function AnnotationsPage({ onChanged }: Props) {
  const [list, setList] = useState<AnnotationWithSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AnnotationKind | "">("");
  const [agent, setAgent] = useState<Agent | "">("");
  const [resolved, setResolved] = useState<ResolvedFilter>("open");
  const [q, setQ] = useState("");
  const [version, setVersion] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version exists only to force a refetch
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .listAnnotations({
          kind: kind || undefined,
          agent: agent || undefined,
          resolved: resolved === "all" ? undefined : resolved === "done",
          q: q || undefined,
        })
        .then((l) => {
          if (!cancelled) {
            setList(l);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind, agent, resolved, q, version]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      { title: string; cwd: string | null; agent: Agent; sessionId: string; items: AnnotationWithSession[] }
    >();
    for (const a of list ?? []) {
      const key = `${a.agent}:${a.sessionId}`;
      const g = map.get(key) ?? {
        title: a.sessionTitle ?? a.sessionId,
        cwd: a.sessionCwd,
        agent: a.agent,
        sessionId: a.sessionId,
        items: [],
      };
      g.items.push(a);
      map.set(key, g);
    }
    return [...map.values()];
  }, [list]);

  const refresh = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  return (
    <div className="annotations-page">
      <div className="page-filters">
        <input
          type="search"
          placeholder="Search notes, excerpts, tags…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as AnnotationKind | "")}>
          <option value="">All kinds</option>
          {ANNOTATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_META[k].label}
            </option>
          ))}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value as Agent | "")}>
          <option value="">All agents</option>
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={resolved} onChange={(e) => setResolved(e.target.value as ResolvedFilter)}>
          <option value="open">Open</option>
          <option value="done">Resolved</option>
          <option value="all">All</option>
        </select>
        <span className="muted">{list ? `${list.length} annotations` : ""}</span>
      </div>
      {error && <div className="error">{error}</div>}
      {list && list.length === 0 && <div className="muted pad">Nothing here yet.</div>}
      {groups.map((g) => (
        <section key={`${g.agent}:${g.sessionId}`} className="ann-group">
          <h3>
            <span className={`badge agent-${g.agent}`}>{g.agent}</span>
            <a
              href={routeToHash({
                page: "session",
                agent: g.agent,
                id: g.sessionId,
                agentId: null,
                focus: null,
              })}
            >
              {g.title}
            </a>
            {g.cwd && <span className="muted"> · {shortenPath(g.cwd)}</span>}
          </h3>
          {g.items.map((a) => (
            <div key={a.id} className={`ann-card kind-${a.kind}${a.resolved ? " resolved" : ""}`}>
              <div className="card-head">
                <span className={`pill kind-${a.kind}`}>{KIND_META[a.kind].label}</span>
                <span className="muted">{targetLabel(a.target)}</span>
                <span className="muted">{formatDateTime(a.createdAt)}</span>
                <span className="spacer" />
                <label>
                  <input
                    type="checkbox"
                    checked={a.resolved}
                    onChange={async (e) => {
                      await api.updateAnnotation(a.id, { resolved: e.target.checked });
                      refresh();
                    }}
                  />{" "}
                  done
                </label>
                <a
                  className="link"
                  href={routeToHash({
                    page: "session",
                    agent: a.agent,
                    id: a.sessionId,
                    agentId: a.target.agentId,
                    focus: a.id,
                  })}
                >
                  open →
                </a>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => {
                    if (!window.confirm("Delete this annotation?")) return;
                    await api.deleteAnnotation(a.id);
                    refresh();
                  }}
                >
                  delete
                </button>
              </div>
              {(a.target.quote?.exact ?? a.context) && (
                <blockquote className="excerpt">{a.target.quote?.exact ?? a.context}</blockquote>
              )}
              {a.note && <Html className="note md" html={renderMarkdown(a.note)} />}
              {a.tags.length > 0 && (
                <div className="tags">
                  {a.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
