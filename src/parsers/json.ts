export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(o: JsonObject, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}

export function num(o: JsonObject, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function bool(o: JsonObject, key: string): boolean {
  return o[key] === true;
}

export function obj(o: JsonObject, key: string): JsonObject | null {
  const v = o[key];
  return isObject(v) ? v : null;
}

export function arr(o: JsonObject, key: string): unknown[] | null {
  const v = o[key];
  return Array.isArray(v) ? v : null;
}

/** Accepts ISO-8601 strings, unix seconds, or unix milliseconds and returns unix milliseconds. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function prettyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function omitKeys(o: JsonObject, keys: ReadonlySet<string>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
}
