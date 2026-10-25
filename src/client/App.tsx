import { useCallback, useEffect, useState } from "react";
import type { CatalogStatus, SessionSummary } from "../shared/model";
import * as api from "./api";
import { AnnotationsPage } from "./components/AnnotationsPage";
import { defaultFilters, type SessionFilters, SessionList } from "./components/SessionList";
import { SessionView } from "./components/SessionView";
import { useRoute } from "./router";

const FILTERS_KEY = "marginalia.filters";
const IDLE_POLL_MS = 30_000;
const INDEXING_POLL_MS = 1_000;

function loadFilters(): SessionFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return { ...defaultFilters(), ...(JSON.parse(raw) as Partial<SessionFilters>) };
  } catch {
    // Storage unavailable or unreadable: start from defaults.
  }
  return defaultFilters();
}

function statusText(status: CatalogStatus | null): string {
  if (!status) return "";
  if (status.indexing) return `Indexing ${status.done}/${status.total}…`;
  const errors = status.errors > 0 ? ` · ${status.errors} unreadable` : "";
  const missing = status.missing > 0 ? ` · ${status.missing} archived only` : "";
  return `${status.sessions} sessions${missing}${errors}`;
}

export function App() {
  const route = useRoute();
  const [filters, setFilters] = useState<SessionFilters>(loadFilters);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const bumpList = useCallback(() => setListVersion((v) => v + 1), []);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // Persisting filters is a convenience only.
    }
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let wasIndexing = false;
    const tick = async () => {
      let delay = IDLE_POLL_MS;
      try {
        const s = await api.getStatus();
        if (cancelled) return;
        setStatus(s);
        if ((wasIndexing && !s.indexing) || (!s.indexing && document.visibilityState === "visible"))
          bumpList();
        wasIndexing = s.indexing;
        delay = s.indexing ? INDEXING_POLL_MS : IDLE_POLL_MS;
      } catch {
        delay = 5_000;
      }
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, IDLE_POLL_MS);
    void api.getStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      wasIndexing = s.indexing;
      if (s.indexing) {
        window.clearTimeout(timer);
        timer = window.setTimeout(tick, INDEXING_POLL_MS);
      }
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bumpList]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: listVersion exists only to force a refetch
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const list = await api.listSessions(filters);
        if (!cancelled) {
          setSessions(list);
          setListError(null);
        }
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err));
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filters, listVersion]);

  const current = route.page === "session" ? route : null;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          Marginalia
        </a>
        <nav>
          <a className={route.page !== "annotations" ? "active" : ""} href="#/">
            Sessions
          </a>
          <a className={route.page === "annotations" ? "active" : ""} href="#/annotations">
            Annotations
          </a>
        </nav>
        <div
          className="status"
          title={
            status?.lastRefreshAt ? `Last refresh ${new Date(status.lastRefreshAt).toLocaleTimeString()}` : ""
          }
        >
          {statusText(status)}
        </div>
      </header>
      <div className="layout">
        {route.page !== "annotations" && (
          <SessionList
            sessions={sessions}
            filters={filters}
            onFilters={setFilters}
            error={listError}
            selected={current ? { agent: current.agent, id: current.id } : null}
          />
        )}
        <main className="main">
          {route.page === "annotations" ? (
            <AnnotationsPage onChanged={bumpList} />
          ) : current ? (
            <SessionView
              key={`${current.agent}/${current.id}/${current.agentId ?? ""}`}
              agent={current.agent}
              id={current.id}
              agentId={current.agentId}
              focus={current.focus}
              onAnnotationsChanged={bumpList}
            />
          ) : (
            <div className="empty">
              <h2>Pick a session</h2>
              <p>Search on the left, open a transcript, select text or a message, and annotate it.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
