import type {
  AnnotationInput,
  AnnotationKind,
  AnnotationPatch,
  AnnotationWithSession,
} from "../shared/annotation";
import type { Agent, Block, CatalogStatus, SessionSummary, Transcript } from "../shared/model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const getStatus = () => request<CatalogStatus>("/api/status");

export interface SessionQuery {
  q: string;
  agents: Agent[];
  kinds: AnnotationKind[];
  annotatedOnly: boolean;
  includeSubagents: boolean;
}

export function listSessions(query: SessionQuery): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const a of query.agents) params.append("agent", a);
  for (const k of query.kinds) params.append("kind", k);
  if (query.annotatedOnly) params.set("annotated", "1");
  if (query.includeSubagents) params.set("subagents", "1");
  const qs = params.toString();
  return request<SessionSummary[]>(`/api/sessions${qs ? `?${qs}` : ""}`);
}

export function getTranscript(agent: Agent, id: string, agentId: string | null): Promise<Transcript> {
  const base = `/api/sessions/${agent}/${encodeURIComponent(id)}`;
  return request<Transcript>(agentId ? `${base}/subagents/${encodeURIComponent(agentId)}` : base);
}

export function getBlock(
  agent: Agent,
  id: string,
  agentId: string | null,
  entryId: string,
  blockIndex: number,
): Promise<Block> {
  const params = new URLSearchParams({ entry: entryId, block: String(blockIndex) });
  if (agentId) params.set("agentId", agentId);
  return request<Block>(`/api/sessions/${agent}/${encodeURIComponent(id)}/block?${params}`);
}

export interface AnnotationQuery {
  agent?: Agent;
  sessionId?: string;
  kind?: AnnotationKind;
  resolved?: boolean;
  q?: string;
}

export function listAnnotations(query: AnnotationQuery = {}): Promise<AnnotationWithSession[]> {
  const params = new URLSearchParams();
  if (query.agent) params.set("agent", query.agent);
  if (query.sessionId) params.set("sessionId", query.sessionId);
  if (query.kind) params.set("kind", query.kind);
  if (query.resolved !== undefined) params.set("resolved", query.resolved ? "1" : "0");
  if (query.q) params.set("q", query.q);
  const qs = params.toString();
  return request<AnnotationWithSession[]>(`/api/annotations${qs ? `?${qs}` : ""}`);
}

export const createAnnotation = (input: AnnotationInput) =>
  request<AnnotationWithSession>("/api/annotations", jsonInit("POST", input));

export const updateAnnotation = (id: string, patch: AnnotationPatch) =>
  request<AnnotationWithSession>(`/api/annotations/${id}`, jsonInit("PATCH", patch));

export const deleteAnnotation = (id: string) => request<void>(`/api/annotations/${id}`, { method: "DELETE" });

export const reindex = () => request<unknown>("/api/reindex", { method: "POST" });
