import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Json, KernelCall } from './semantic-first-public-native.ts';

export type NativeObservation = {
  method: string;
  url: string;
  credential: string;
  key?: string;
  ifMatch?: string;
  body?: unknown;
  status?: number;
  response?: unknown;
  etag?: string;
  correlation?: string;
};

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problemRequestId(body: Json): string | undefined {
  return typeof body?.request_id === 'string' && requestIdPattern.test(body.request_id) ? body.request_id : undefined;
}

/** Preserve exact request operands and causal session evidence without retaining bearer secrets. */
export function nativeWalkCall(
  kernel: string,
  trace: NativeObservation[],
  fetchImpl: typeof fetch = fetch,
): KernelCall {
  const sessions = new Map<string, string>();
  return async (method, path, options = {}) => {
    const url = new URL(path, kernel);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const key = method === 'GET' ? undefined : randomUUID();
    const credential = options.bearer
      ? `bearer-sha256:${createHash('sha256').update(options.bearer).digest('hex')}`
      : 'anonymous';
    const session = sessions.get(credential);
    const observation: NativeObservation = {
      method,
      url: url.href,
      credential,
      ...(key === undefined ? {} : { key }),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.body === undefined ? {} : { body: options.body }),
    };
    trace.push(observation);
    const response = await fetchImpl(url, {
      method,
      signal: options.signal ?? AbortSignal.timeout(60_000),
      ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(options.ifMatch ? { 'if-match': `"${options.ifMatch}"` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(session ? { 'rezics-session-token': session } : {}),
        'accept-language': 'en',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const nextSession = response.headers.get('rezics-session-token');
    if (nextSession) sessions.set(credential, nextSession);
    observation.status = response.status;
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Json) : {};
    const etag = response.headers.get('etag') ?? undefined;
    const correlation = problemRequestId(body) ?? response.headers.get('x-request-id') ?? undefined;
    Object.assign(observation, {
      response: body,
      ...(etag === undefined ? {} : { etag }),
      ...(correlation === undefined ? {} : { correlation }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body,
      ...(etag === undefined ? {} : { etag }),
    };
  };
}

/** Keep the scoped result small, including for repeated read attempts. */
export function summarizeBoundaryRequest({
  method,
  url,
  credential,
  key,
  status,
  response,
  correlation,
}: NativeObservation) {
  const problem = response as Json | undefined;
  const effect = problem?.effect_status;
  const successful = status !== undefined && status >= 200 && status < 300;
  return {
    method,
    url,
    persona: credential === 'anonymous' ? 'anonymous' : 'editor',
    ...(key === undefined ? {} : { key }),
    status: status ?? null,
    requestId: correlation && requestIdPattern.test(correlation) ? correlation : null,
    code: typeof problem?.code === 'string' && /^[a-z_]{1,64}$/.test(problem.code) ? problem.code : null,
    effect:
      effect === 'applied' || effect === 'not_applied' || effect === 'not_applicable'
        ? effect
        : successful
          ? method === 'GET'
            ? 'not_applicable'
            : 'applied'
          : null,
  };
}

const phases = [
  'before_command',
  'command_overhead',
  'time_mint',
  'access_prepare',
  'gate_wait',
  'transaction_pool_wait',
  'transaction_body',
  'commit',
  'writable_wait',
  'contention_pause',
  'request_completion',
] as const;

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export async function kernelDeadlineTimings(logPath: string, trace: NativeObservation[]) {
  const pending = new Map<string, string>();
  for (const { method, status, response } of trace) {
    const problem = response as Json | undefined;
    if (status !== 503 || problem?.code !== 'deadline_exceeded') continue;
    const id = problemRequestId(problem);
    if (id) pending.set(id, method);
  }
  if (!pending.size) return [];

  const records = [];
  const stream = createReadStream(logPath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith('{') || !line.includes('"event":"deadline_exceeded"')) continue;
      let record: Json;
      try {
        record = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      const { event, request_id, method, elapsed_ms, phases_ms, contention_retries, dominant_phase } = record;
      if (
        event !== 'deadline_exceeded' ||
        typeof request_id !== 'string' ||
        typeof method !== 'string' ||
        pending.get(request_id) !== method ||
        !nonnegative(elapsed_ms) ||
        !nonnegative(contention_retries) ||
        !phases.some((phase) => phase === dominant_phase)
      )
        continue;
      const timing = phases.map((phase) => [phase, (phases_ms as Json | undefined)?.[phase]] as const);
      if (!timing.every(([, ms]) => nonnegative(ms))) continue;
      records.push({
        event,
        request_id,
        method,
        elapsed_ms,
        phases_ms: Object.fromEntries(timing),
        contention_retries,
        dominant_phase,
      });
      pending.delete(request_id);
      if (!pending.size) break;
    }
  } catch {
    // Timing is optional when the owned log is unavailable.
  } finally {
    lines.close();
    stream.destroy();
  }
  return records;
}
