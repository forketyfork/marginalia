import { isObject } from "../parsers/json";
import { forTransport } from "../parsers/parse";
import {
  type AnnotationInput,
  type AnnotationPatch,
  type AnnotationTarget,
  isAnnotationKind,
  type TextQuote,
} from "../shared/annotation";
import { type Agent, isAgent } from "../shared/model";
import type { AnnotationStore } from "./annotations";
import type { Catalog } from "./catalog";
import type { TranscriptStore } from "./transcripts";

export interface ApiDeps {
  catalog: Catalog;
  transcripts: TranscriptStore;
  annotations: AnnotationStore;
}

export interface ServerOptions {
  port: number;
  hostname: string;
  development: boolean;
  /** The bundled client page; omitted by API tests. */
  html?: Bun.HTMLBundle;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const QUICK_REFRESH_WAIT_MS = 1_500;

const badRequest = (message: string) => new HttpError(400, message);
const notFound = (message: string) => new HttpError(404, message);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function guard<T extends Request>(
  handler: (req: T) => Promise<Response> | Response,
): (req: T) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, err);
      return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
    }
  };
}

function requireAgent(value: string): Agent {
  if (!isAgent(value)) throw badRequest(`unknown agent "${value}"`);
  return value;
}

function parseTarget(value: unknown): AnnotationTarget {
  if (!isObject(value)) throw badRequest("target must be an object");
  const entryId = value.entryId;
  if (typeof entryId !== "string" || entryId.length === 0) throw badRequest("target.entryId is required");
  const blockIndex = value.blockIndex ?? null;
  if (
    blockIndex !== null &&
    (typeof blockIndex !== "number" || !Number.isInteger(blockIndex) || blockIndex < 0)
  ) {
    throw badRequest("target.blockIndex must be a non-negative integer or null");
  }
  const agentId = value.agentId ?? null;
  if (agentId !== null && typeof agentId !== "string")
    throw badRequest("target.agentId must be a string or null");
  const quote = value.quote ?? null;
  if (quote !== null) {
    if (!isObject(quote)) throw badRequest("target.quote must be an object or null");
    for (const key of ["exact", "prefix", "suffix"]) {
      if (typeof quote[key] !== "string") throw badRequest(`target.quote.${key} must be a string`);
    }
    for (const key of ["start", "end"]) {
      if (typeof quote[key] !== "number") throw badRequest(`target.quote.${key} must be a number`);
    }
    if (blockIndex === null) throw badRequest("a quote requires target.blockIndex");
  }
  return { entryId, blockIndex, agentId, quote: quote as TextQuote | null };
}

function parseTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string"))
    throw badRequest("tags must be strings");
  return value;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("request body must be JSON");
  }
  if (!isObject(body)) throw badRequest("request body must be a JSON object");
  return body;
}

function parseAnnotationInput(body: Record<string, unknown>): AnnotationInput {
  if (typeof body.agent !== "string") throw badRequest("agent is required");
  const agent = requireAgent(body.agent);
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0)
    throw badRequest("sessionId is required");
  if (!isAnnotationKind(body.kind)) throw badRequest("kind must be one of the annotation kinds");
  const note = typeof body.note === "string" ? body.note : "";
  const context = typeof body.context === "string" ? body.context : "";
  return {
    agent,
    sessionId: body.sessionId,
    target: parseTarget(body.target),
    kind: body.kind,
    note,
    tags: parseTags(body.tags),
    context: context.slice(0, 500),
  };
}

function parseAnnotationPatch(body: Record<string, unknown>): AnnotationPatch {
  const patch: AnnotationPatch = {};
  if (body.kind !== undefined) {
    if (!isAnnotationKind(body.kind)) throw badRequest("kind must be one of the annotation kinds");
    patch.kind = body.kind;
  }
  if (body.note !== undefined) {
    if (typeof body.note !== "string") throw badRequest("note must be a string");
    patch.note = body.note;
  }
  if (body.tags !== undefined) patch.tags = parseTags(body.tags);
  if (body.resolved !== undefined) {
    if (typeof body.resolved !== "boolean") throw badRequest("resolved must be a boolean");
    patch.resolved = body.resolved;
  }
  return patch;
}

export function createServer(deps: ApiDeps, opts: ServerOptions) {
  const { catalog, transcripts, annotations } = deps;

  const routes = {
    "/api/status": { GET: guard(() => json(catalog.status())) },

    "/api/sessions": {
      GET: guard(async (req) => {
        // An incremental refresh is quick; the initial build of a large history is not, so serve
        // what is indexed so far and let the client re-fetch when the status flips to idle.
        await Promise.race([catalog.refresh(), Bun.sleep(QUICK_REFRESH_WAIT_MS)]);
        const url = new URL(req.url);
        const agents = url.searchParams.getAll("agent").map(requireAgent);
        const kinds = url.searchParams.getAll("kind").map((k) => {
          if (!isAnnotationKind(k)) throw badRequest(`unknown annotation kind "${k}"`);
          return k;
        });
        return json(
          catalog.list(
            {
              q: url.searchParams.get("q") ?? "",
              agents: agents.length > 0 ? agents : null,
              kinds: kinds.length > 0 ? kinds : null,
              annotatedOnly: url.searchParams.get("annotated") === "1",
              includeSubagents: url.searchParams.get("subagents") === "1",
            },
            annotations.statsBySession(),
          ),
        );
      }),
    },

    "/api/sessions/:agent/:id": {
      GET: guard(async (req: Bun.BunRequest<"/api/sessions/:agent/:id">) => {
        const agent = requireAgent(req.params.agent);
        const transcript = await transcripts.load(agent, req.params.id);
        if (!transcript) throw notFound("session not found");
        return json(forTransport(transcript));
      }),
    },

    "/api/sessions/:agent/:id/subagents/:agentId": {
      GET: guard(async (req: Bun.BunRequest<"/api/sessions/:agent/:id/subagents/:agentId">) => {
        const agent = requireAgent(req.params.agent);
        const transcript = await transcripts.loadSubagent(agent, req.params.id, req.params.agentId);
        if (!transcript) throw notFound("subagent transcript not found");
        return json(forTransport(transcript));
      }),
    },

    "/api/sessions/:agent/:id/block": {
      GET: guard(async (req: Bun.BunRequest<"/api/sessions/:agent/:id/block">) => {
        const agent = requireAgent(req.params.agent);
        const url = new URL(req.url);
        const entryId = url.searchParams.get("entry");
        const blockIndex = Number.parseInt(url.searchParams.get("block") ?? "", 10);
        if (!entryId || !Number.isInteger(blockIndex)) throw badRequest("entry and block are required");
        const block = await transcripts.block(
          agent,
          req.params.id,
          url.searchParams.get("agentId"),
          entryId,
          blockIndex,
        );
        if (!block) throw notFound("block not found");
        return json(block);
      }),
    },

    "/api/annotations": {
      GET: guard((req) => {
        const url = new URL(req.url);
        const agentParam = url.searchParams.get("agent");
        const kindParam = url.searchParams.get("kind");
        const resolvedParam = url.searchParams.get("resolved");
        if (kindParam !== null && !isAnnotationKind(kindParam))
          throw badRequest(`unknown annotation kind "${kindParam}"`);
        return json(
          annotations.list({
            agent: agentParam ? requireAgent(agentParam) : undefined,
            sessionId: url.searchParams.get("sessionId") ?? undefined,
            kind: kindParam ?? undefined,
            resolved: resolvedParam === null ? undefined : resolvedParam === "1",
            q: url.searchParams.get("q") ?? undefined,
          }),
        );
      }),
      POST: guard(async (req) => json(annotations.create(parseAnnotationInput(await readJson(req))), 201)),
    },

    "/api/annotations/:id": {
      GET: guard((req: Bun.BunRequest<"/api/annotations/:id">) => {
        const found = annotations.get(req.params.id);
        if (!found) throw notFound("annotation not found");
        return json(found);
      }),
      PATCH: guard(async (req: Bun.BunRequest<"/api/annotations/:id">) => {
        const updated = annotations.update(req.params.id, parseAnnotationPatch(await readJson(req)));
        if (!updated) throw notFound("annotation not found");
        return json(updated);
      }),
      DELETE: guard((req: Bun.BunRequest<"/api/annotations/:id">) => {
        if (!annotations.delete(req.params.id)) throw notFound("annotation not found");
        return new Response(null, { status: 204 });
      }),
    },

    "/api/reindex": {
      POST: guard(async () => json(await catalog.refresh({ force: true }))),
    },
  };

  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    development: opts.development ? { hmr: true, console: true } : false,
    routes: {
      ...routes,
      "/": opts.html ?? new Response("marginalia API", { headers: { "content-type": "text/plain" } }),
    },
    fetch() {
      return json({ error: "not found" }, 404);
    },
  });
}
