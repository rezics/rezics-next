/** Only the numeric Jena timer is retained; descriptions may contain query text. */
export function fusekiEngineTime(headers: Headers): number | undefined {
  const timing = headers.get('server-timing');
  const match = timing?.match(/(?:^|,)\s*jena\s*;\s*dur=(\d+(?:\.\d+)?)(?:\s*;[^,]*)?(?=,|$)/i);
  const value = match ? Number(match[1]) : undefined;
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Fixed numeric native fields only. Never export RDF values, request text,
 * arbitrary metric names or descriptions supplied by an upstream service. */
export const commandPhases = [
  'parse',
  'queue',
  'preflight',
  'update',
  'invariants',
  'validation',
  'projections',
  'journal',
  'commit',
  'qualification',
  'text_index',
  'text_prepare',
  'text_commit',
  'current_graph',
  'revisions_graph',
  'other_graph',
] as const;
export const commandCounters = [
  'current_adds',
  'current_deletes',
  'current_literal_bytes',
  'revisions_adds',
  'revisions_deletes',
  'revisions_literal_bytes',
  'other_adds',
  'other_deletes',
  'other_literal_bytes',
  'max_literal_bytes',
  'text_adds',
  'text_updates',
  'text_deletes',
  'validation_focuses',
  'durable_commits',
] as const;

export function fusekiCommandWork(headers: Headers): Record<string, number> {
  const result: Record<string, number> = {};
  const timing = headers.get('server-timing') ?? '';
  const counters = headers.get('x-rezics-command-work') ?? '';
  for (const phase of commandPhases) {
    const match = timing.match(
      new RegExp(`(?:^|,)\\s*${phase}\\s*;\\s*dur=(\\d+(?:\\.\\d+)?)(?:\\s*;[^,]*)?(?=,|$)`),
    );
    const value = match ? Number(match[1]) : undefined;
    if (value !== undefined && Number.isFinite(value)) result[`rezics.fuseki.${phase}_ms`] = value;
  }
  for (const counter of commandCounters) {
    const match = counters.match(new RegExp(`(?:^|,)${counter}=(\\d+)(?=,|$)`));
    const value = match ? Number(match[1]) : undefined;
    if (value !== undefined && Number.isSafeInteger(value))
      result[`rezics.fuseki.${counter}`] = value;
  }
  return result;
}

/** Streams and FormData have no known encoded length without consuming them. */
export function requestBodyBytes(
  input: string | URL | Request,
  init?: RequestInit,
): number | undefined {
  const body = init?.body;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body === null || (!(input instanceof Request) && body === undefined)) return 0;
  if (input instanceof Request && !input.body && body === undefined) return 0;
  return undefined;
}

/** Replacing a body must retain fetch's URL/redirect/type semantics, including clones. */
export function preserveResponseMetadata(original: Response, observed: Response): Response {
  const clone = observed.clone.bind(observed);
  Object.defineProperties(observed, {
    url: { value: original.url },
    redirected: { value: original.redirected },
    type: { value: original.type },
    clone: { value: () => preserveResponseMetadata(original, clone()) },
  });
  return observed;
}
