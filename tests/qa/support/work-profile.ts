import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commandCounters,
  commandPhases,
} from '../../../packages/observability/src/http-measurement.ts';
import { attributes, decode } from '../../../packages/observability/tests/otlp.ts';

export interface WorkSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  /** OpenTelemetry API kinds: INTERNAL=0, SERVER=1, CLIENT=2. */
  kind: number;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
}
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes?: { key: string; value: Record<string, unknown> }[];
}
interface WireTraces {
  resourceSpans?: {
    resource?: { attributes?: { key: string; value: Record<string, unknown> }[] };
    scopeSpans?: { spans?: WireSpan[] }[];
  }[];
}

export function decodeWorkSpans(bytes: Uint8Array): WorkSpan[] {
  const message = decode('Traces', bytes) as WireTraces;
  return (message.resourceSpans ?? []).flatMap((resource) => {
    const service = attributes(resource.resource?.attributes ?? [])['service.name'];
    return (resource.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({
        traceId: Buffer.from(span.traceId, 'base64').toString('hex'),
        spanId: Buffer.from(span.spanId, 'base64').toString('hex'),
        parentSpanId: Buffer.from(span.parentSpanId ?? '', 'base64').toString('hex'),
        service: typeof service === 'string' ? service : 'unknown',
        name: span.name,
        kind: span.kind - 1,
        startMs: span.startTimeUnixNano / 1e6,
        endMs: span.endTimeUnixNano / 1e6,
        attributes: attributes(span.attributes ?? []),
      })),
    );
  });
}

export interface WorkProfileSource {
  /** The source must include all owner services, not only Main. */
  collect(traceId: string, parentSpanId: string): Promise<WorkSpan[]>;
  /** Release only after the complete profile has retained its own evidence. */
  release?(traceId: string): void;
}

/** Deduplicate exporter retries. A bounded sink refuses dropped evidence. */
export function startWorkProfileSink(
  options: { maxSpans?: number; settleMs?: number; timeoutMs?: number } = {},
) {
  const records = new Map<string, WorkSpan>();
  const updated = new Map<string, number>();
  const token = randomBytes(24).toString('hex');
  let failure: Error | undefined;
  const maxSpans = options.maxSpans ?? 100_000;
  const settleMs = options.settleMs ?? 1_250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(maxSpans) ||
    maxSpans < 1 ||
    !Number.isFinite(settleMs) ||
    settleMs < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= settleMs
  )
    throw new Error('Invalid work profile sink bounds');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || !['/v1/traces', '/v1/metrics', '/v1/logs'].includes(path))
        return new Response(null, { status: 404 });
      if (!request.headers.get('content-type')?.includes('application/x-protobuf'))
        return new Response(null, { status: 415 });
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > 16_777_216) throw new Error('OTLP batch exceeds sink bound');
        if (path === '/v1/traces') {
          for (const span of decodeWorkSpans(bytes)) {
            if (
              !/^[0-9a-f]{32}$/.test(span.traceId) ||
              !/^[0-9a-f]{16}$/.test(span.spanId) ||
              !Number.isFinite(span.startMs) ||
              !Number.isFinite(span.endMs) ||
              span.endMs < span.startMs
            )
              throw new Error('Malformed OTLP span');
            const key = `${span.traceId}:${span.spanId}`;
            if (records.has(key)) continue;
            if (records.size >= maxSpans)
              throw new Error(
                `Work profile sink capacity exhausted (${records.size}/${maxSpans} retained spans)`,
              );
            records.set(key, span);
            updated.set(span.traceId, performance.now());
          }
        }
        return new Response(null, { status: 200 });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        failure ??= new Error(`OTLP ingestion failed; counts are incomplete: ${cause.message}`, {
          cause,
        });
        return new Response(cause.message, { status: 400 });
      }
    },
  });
  const source: WorkProfileSource = {
    async collect(traceId, parentSpanId) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (failure) throw failure;
        const spans = [...records.values()].filter((span) => span.traceId === traceId);
        if (
          spans.some((span) => span.kind === 1 && span.parentSpanId === parentSpanId) &&
          performance.now() - (updated.get(traceId) ?? Infinity) >= settleMs
        )
          return spans;
        await Bun.sleep(25);
      }
      throw new Error(
        'Request trace did not settle; telemetry is missing, sampled out or unfinished',
      );
    },
    release(traceId) {
      for (const [key, span] of records) if (span.traceId === traceId) records.delete(key);
      updated.delete(traceId);
    },
  };
  return {
    ...source,
    url: server.url.origin,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: server.url.origin,
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${token}`,
      OTEL_TRACES_SAMPLER_ARG: '1',
      OTEL_SDK_DISABLED: 'false',
    },
    snapshot: () =>
      [...records.values()].map((span) => ({ ...span, attributes: { ...span.attributes } })),
    clear() {
      records.clear();
      updated.clear();
    },
    stop: () => server.stop(true),
  };
}

export interface WorkProfile {
  traceId: string;
  request: { service: string; route: string; status: number | null };
  mainCalls: number | null;
  fusekiRequests: number | null;
  fusekiSentBytes: number | null;
  fusekiReceivedBytes: number | null;
  fusekiEngineMs: number | null;
  /** Allowlisted native counters summed across this request's Fuseki calls. */
  nativeVisits: Record<string, number>;
  nativeVisitTotal: number;
  postgresStatements: number | null;
  accountCalls: number | null;
  otherFetches: number | null;
  unclassifiedFetches: number;
  serverLatencyMs: number;
  totalLatencyMs: number;
  fusekiCalls: {
    spanId: string;
    durationMs: number;
    headersMs: number | null;
    bodyReadMs: number | null;
    sentBytes: number | null;
    receivedBytes: number | null;
    engineMs: number | null;
    /** Nested native phase times and mutation counts; absent on query calls.
     * Numeric native fields survive reports that omit the full span inventory. */
    nativeWork: Record<string, number> | null;
  }[];
  postgres: { spanId: string; service: string; operation: string | null; durationMs: number }[];
  /** Missing byte/engine attributes remain unknown, never a measured zero. */
  unobserved: string[];
  spans: WorkSpan[];
}

export interface WorkProfileOptions {
  service?: string;
  /** For pre-existing spans lacking the bounded peer tag, exact origins identify owners. */
  peers?: { fuseki?: string; account?: string; main?: string; other?: string };
}

function peer(span: WorkSpan, options: WorkProfileOptions): string {
  const tag = span.attributes['rezics.peer.service'];
  if (typeof tag === 'string' && ['fuseki', 'account', 'main', 'other'].includes(tag)) return tag;
  for (const [name, origin] of Object.entries(options.peers ?? {})) {
    if (!origin) continue;
    const url = new URL(origin);
    if (
      span.attributes['server.address'] === url.hostname &&
      Number(span.attributes['server.port']) ===
        Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    )
      return name;
  }
  return 'unclassified';
}

export function summarizeWorkProfile(
  all: WorkSpan[],
  traceId: string,
  parentSpanId: string,
  totalLatencyMs: number,
  options: WorkProfileOptions = {},
): WorkProfile {
  const spans = [
    ...new Map(
      all.filter((span) => span.traceId === traceId).map((span) => [span.spanId, span]),
    ).values(),
  ];
  const roots = spans.filter(
    (span) =>
      span.kind === 1 &&
      span.parentSpanId === parentSpanId &&
      (!options.service || span.service === options.service),
  );
  if (roots.length !== 1) throw new Error('Expected exactly one completed request server span');
  const root = roots[0]!;
  // A reused trace can contain siblings. Only this request's descendants count.
  const byParent = new Map<string, WorkSpan[]>();
  for (const span of spans) {
    const siblings = byParent.get(span.parentSpanId) ?? [];
    siblings.push(span);
    byParent.set(span.parentSpanId, siblings);
  }
  const included = new Set([root.spanId]);
  const pending = [root.spanId];
  for (let index = 0; index < pending.length; index++) {
    for (const span of byParent.get(pending[index]!) ?? [])
      if (!included.has(span.spanId)) {
        included.add(span.spanId);
        pending.push(span.spanId);
      }
  }
  const children = spans.filter((span) => included.has(span.spanId));
  const fetches = children.filter(
    (span) => span.kind === 2 && span.attributes['http.request.method'],
  );
  const fuseki = fetches.filter((span) => peer(span, options) === 'fuseki');
  const unobserved = [
    'native Jena operators',
    'SQL plan rows/buffers/WAL',
    'untraced background work',
  ];
  const unclassifiedFetches = fetches.filter(
    (span) => peer(span, options) === 'unclassified',
  ).length;
  if (unclassifiedFetches) unobserved.push('fetch peer classification');
  const serverParents = new Set(
    children.filter((span) => span.kind === 1).map((span) => span.parentSpanId),
  );
  for (const name of ['account', 'main']) {
    if (fetches.some((span) => peer(span, options) === name && !serverParents.has(span.spanId)))
      unobserved.push(`${name} SQL descendants`);
  }
  const sum = (field: string, complete = false): number | null => {
    if (
      unclassifiedFetches ||
      fuseki.some(
        (span) =>
          typeof span.attributes[field] !== 'number' ||
          !Number.isFinite(span.attributes[field]) ||
          Number(span.attributes[field]) < 0 ||
          (complete && span.attributes['rezics.http.body.complete'] !== true),
      )
    ) {
      unobserved.push(field);
      return null;
    }
    return fuseki.reduce((total, span) => total + Number(span.attributes[field]), 0);
  };
  const status = root.attributes['http.response.status_code'];
  const statements = children.filter(
    (span) => span.kind === 2 && span.attributes['db.system.name'] === 'postgresql',
  );
  const numeric = (span: WorkSpan, field: string) => {
    const value = span.attributes[field];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const nativeVisits: Record<string, number> = {};
  const counters = new Set<string>(commandCounters);
  const timers = new Set(['engine_ms', ...commandPhases.map((name) => `${name}_ms`)]);
  let nativeVisitTotal = 0;
  for (const span of fuseki) {
    for (const [attribute, value] of Object.entries(span.attributes)) {
      if (!attribute.startsWith('rezics.fuseki.')) continue;
      const name = attribute.slice('rezics.fuseki.'.length);
      if (timers.has(name)) continue;
      if (!counters.has(name))
        throw new Error(`Work profile native counter is not allowlisted: ${name}`);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`Work profile native counter is invalid: ${name}`);
      const sum = (nativeVisits[name] ?? 0) + value;
      nativeVisitTotal += value;
      if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(nativeVisitTotal))
        throw new Error(`Work profile native counter sum exceeds safe integer bounds: ${name}`);
      nativeVisits[name] = sum;
    }
  }
  return {
    traceId,
    request: {
      service: root.service,
      route: String(root.attributes['http.route'] ?? 'unmatched'),
      status: typeof status === 'number' ? status : null,
    },
    mainCalls: unclassifiedFetches
      ? null
      : fetches.filter((span) => peer(span, options) === 'main').length,
    fusekiRequests: unclassifiedFetches ? null : fuseki.length,
    fusekiSentBytes: sum('http.request.body.size'),
    fusekiReceivedBytes: sum('http.response.body.size', true),
    fusekiEngineMs: sum('rezics.fuseki.engine_ms'),
    nativeVisits,
    nativeVisitTotal,
    postgresStatements:
      unclassifiedFetches || unobserved.some((gap) => gap.endsWith('SQL descendants'))
        ? null
        : statements.length,
    accountCalls: unclassifiedFetches
      ? null
      : fetches.filter((span) => peer(span, options) === 'account').length,
    otherFetches: unclassifiedFetches
      ? null
      : fetches.filter((span) => peer(span, options) === 'other').length,
    unclassifiedFetches,
    serverLatencyMs: root.endMs - root.startMs,
    totalLatencyMs,
    fusekiCalls: fuseki.map((span) => {
      const headersMs = numeric(span, 'rezics.http.headers_ms');
      const durationMs = span.endMs - span.startMs;
      return {
        spanId: span.spanId,
        durationMs,
        headersMs,
        bodyReadMs: headersMs === null ? null : Math.max(0, durationMs - headersMs),
        sentBytes: numeric(span, 'http.request.body.size'),
        receivedBytes:
          span.attributes['rezics.http.body.complete'] === true
            ? numeric(span, 'http.response.body.size')
            : null,
        engineMs: numeric(span, 'rezics.fuseki.engine_ms'),
        nativeWork:
          span.attributes['rezics.fuseki.commit_ms'] === undefined
            ? null
            : Object.fromEntries(
                [...commandPhases.map((name) => `${name}_ms`), ...commandCounters].flatMap(
                  (name) => {
                    const value = numeric(span, `rezics.fuseki.${name}`);
                    return value === null ? [] : [[name, value]];
                  },
                ),
              ),
      };
    }),
    postgres: statements.map((span) => ({
      spanId: span.spanId,
      service: span.service,
      operation:
        typeof span.attributes['db.operation.name'] === 'string'
          ? span.attributes['db.operation.name']
          : null,
      durationMs: span.endMs - span.startMs,
    })),
    unobserved,
    spans: children,
  };
}

/** Invoke must consume the response and assert its contents before it resolves. */
export async function profileRequest<T>(
  source: WorkProfileSource,
  invoke: (headers: Headers) => Promise<T>,
  options: WorkProfileOptions & {
    flush?: () => Promise<void>;
  } = {},
): Promise<{ result: T; profile: WorkProfile }> {
  const traceId = randomBytes(16).toString('hex'),
    parentSpanId = randomBytes(8).toString('hex');
  const headers = new Headers({ traceparent: `00-${traceId}-${parentSpanId}-01` });
  const started = performance.now();
  const result = await invoke(headers);
  const totalMs = performance.now() - started;
  await options.flush?.();
  const spans = await source.collect(traceId, parentSpanId);
  const profile = summarizeWorkProfile(spans, traceId, parentSpanId, totalMs, options);
  source.release?.(traceId);
  return { result, profile };
}

type NativeWorkCostField = `nativeVisits.${(typeof commandCounters)[number]}` | 'nativeVisitTotal';
export type WorkCostField =
  | NativeWorkCostField
  | {
      [K in keyof WorkProfile]: WorkProfile[K] extends number | null ? K : never;
    }[keyof WorkProfile];
export type WorkCostGrowthClass = 'constant' | 'logarithmic' | 'linear' | 'linearithmic';
type WorkCostGrowthDimension = WorkCostField | 'threads';
export type WorkCostGrowthDeclaration = {
  class: WorkCostGrowthClass;
  dimension: WorkCostGrowthDimension;
  reason?: string;
};
type NativeWorkCostGrowthDeclaration = WorkCostGrowthDeclaration &
  ({ class: 'constant' } | { class: Exclude<WorkCostGrowthClass, 'constant'>; reason: string });
export type WorkMinimumObserved = Partial<Record<'postgresStatements' | 'fusekiRequests', number>>;
export type WorkCostContract = Partial<Record<WorkCostField, number>> & {
  growth?: {
    [K in WorkCostField]?: K extends NativeWorkCostField
      ? NativeWorkCostGrowthDeclaration
      : WorkCostGrowthDeclaration;
  };
  minimumObserved?: WorkMinimumObserved;
};
export const WORK_COST_GROWTH_MARGIN = 1.2;

type WorkCostGrowthBreach = {
  counter: WorkCostField;
  dimension: WorkCostGrowthDimension | 'profileIndex';
  growthClass: WorkCostGrowthClass;
  smallerScale: number;
  largerScale: number;
  smallerValue: number;
  largerValue: number;
  allowedRatio: number;
  observedRatio: number | 'Infinity';
};

function workCostValue(profile: WorkProfile, field: WorkCostField): number | null | undefined {
  return field.startsWith('nativeVisits.')
    ? profile.nativeVisits[field.slice('nativeVisits.'.length)]
    : profile[field as Exclude<WorkCostField, `nativeVisits.${string}`>];
}

export class WorkMeterBlindError extends Error {
  readonly code = 'WORK_PROFILE_METER_BLIND';
  constructor(
    readonly traceId: string,
    detail: string,
  ) {
    super(`Work cost meter is blind: ${detail} (trace ${traceId})`);
    this.name = 'WorkMeterBlindError';
  }
}

/** The same attribution proof serves a single restored read and each growth scale. */
export function assertWorkMeterObserved(
  profile: WorkProfile,
  minimumObserved?: WorkMinimumObserved,
): void {
  for (const [field, minimum] of Object.entries(minimumObserved ?? {})) {
    if (!Number.isSafeInteger(minimum) || minimum < 1)
      throw new Error(`Invalid minimum observed cost: ${field}`);
  }
  if (
    (profile.postgresStatements === 0 || profile.postgresStatements === null) &&
    (profile.fusekiRequests === 0 || profile.fusekiRequests === null) &&
    ((profile.otherFetches ?? 0) > 0 || profile.unclassifiedFetches > 0)
  )
    throw new WorkMeterBlindError(
      profile.traceId,
      'fetches observed without SQL or Fuseki attribution',
    );
  if (profile.request.status !== 200 || minimumObserved === undefined) return;
  if (
    profile.postgresStatements === 0 &&
    profile.fusekiRequests === 0 &&
    profile.otherFetches === 0
  )
    throw new WorkMeterBlindError(profile.traceId, 'successful read has no observed calls');
  for (const [field, minimum] of Object.entries(minimumObserved)) {
    const observed = profile[field as keyof WorkMinimumObserved];
    if (observed === null || observed < minimum)
      throw new WorkMeterBlindError(
        profile.traceId,
        `${field}: ${observed ?? 'unobserved'} < ${minimum}`,
      );
  }
}

function writeWorkCostGrowthArtifact(label: string, facts: WorkCostGrowthBreach): void {
  const directory = process.env.REZICS_QA_ARTIFACT_DIR;
  if (!directory) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label))
    throw new Error(`Invalid work cost artifact label: ${label}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${label}.json`), `${JSON.stringify(facts, null, 2)}\n`);
}

/** Absolute maxima compose caller fan-out. Unknown evidence fails an asserted bound. */
export function assertWorkCost(
  profile: WorkProfile,
  contract: Partial<Record<WorkCostField, number>>,
  options: { statuses?: readonly number[] } = {},
): void {
  const failures: string[] = [];
  const status = profile.request.status;
  if (
    status === null ||
    (options.statuses ? !options.statuses.includes(status) : status < 200 || status >= 300)
  )
    failures.push(`request status: ${status ?? 'unobserved'}`);
  for (const [field, maximum] of Object.entries(contract)) {
    if (!Number.isFinite(maximum) || maximum < 0) throw new Error(`Invalid cost maximum: ${field}`);
    const observed = workCostValue(profile, field as WorkCostField);
    if (
      profile.unclassifiedFetches &&
      !['serverLatencyMs', 'totalLatencyMs', 'unclassifiedFetches'].includes(field)
    )
      failures.push(`${field}: unobserved fetch peer classification`);
    if (
      field === 'postgresStatements' &&
      profile.unobserved.some((gap) => gap.endsWith('SQL descendants'))
    )
      failures.push(`${field}: unobserved owner SQL descendants`);
    if (
      observed === null ||
      observed === undefined ||
      !Number.isFinite(observed) ||
      observed > maximum
    )
      failures.push(`${field}: ${observed ?? 'unobserved'} > ${maximum}`);
  }
  if (failures.length) throw new Error(`Request cost contract failed: ${failures.join('; ')}`);
}

/** Absolute maxima and optional growth classes apply across every measured scale. */
export function assertWorkCostAtScales(
  profiles: (WorkProfile & { dimensions?: { threads?: number } })[],
  contract: WorkCostContract,
  label = 'work-cost',
): void {
  if (profiles.length < 3) throw new Error('Cost growth checks require at least three scales');
  const { growth = {}, minimumObserved, ...maxima } = contract;
  for (const profile of profiles) assertWorkMeterObserved(profile, minimumObserved);
  const nativeFields = new Set<NativeWorkCostField>(['nativeVisitTotal']);
  for (const profile of profiles) {
    for (const name of Object.keys(profile.nativeVisits)) {
      if (!(commandCounters as readonly string[]).includes(name))
        throw new Error(`Work profile native counter is not allowlisted: ${name}`);
      nativeFields.add(`nativeVisits.${name}` as NativeWorkCostField);
    }
  }
  for (const field of nativeFields) {
    if (profiles.some((profile) => workCostValue(profile, field) === undefined))
      throw new Error(`Cost growth contract failed: ${field} is absent at a scale`);
  }
  for (const profile of profiles) assertWorkCost(profile, maxima);

  const factor = (growthClass: WorkCostGrowthClass, n: number) => {
    const logarithmic = 1 + Math.log2(n);
    switch (growthClass) {
      case 'constant':
        return 1;
      case 'logarithmic':
        return logarithmic;
      case 'linear':
        return n;
      case 'linearithmic':
        return n * logarithmic;
    }
  };

  const fields = new Set<WorkCostField>([
    ...(Object.keys(growth) as WorkCostField[]),
    ...nativeFields,
  ]);
  for (const field of fields) {
    const declaration = growth[field];
    if (!declaration && !nativeFields.has(field as NativeWorkCostField)) continue;
    const growthClass = declaration?.class ?? 'constant';
    const dimension = declaration?.dimension ?? 'profileIndex';
    if (
      nativeFields.has(field as NativeWorkCostField) &&
      growthClass !== 'constant' &&
      !declaration?.reason?.trim()
    )
      throw new Error(`Native cost growth allowance requires a reason: ${field}`);
    const scales = profiles.map((profile, index) => {
      const observed =
        dimension === 'profileIndex'
          ? index + 1
          : dimension === 'threads'
            ? profile.dimensions?.threads
            : workCostValue(profile, dimension);
      if (
        observed === null ||
        observed === undefined ||
        !Number.isFinite(observed) ||
        observed <= 0
      )
        throw new Error(
          `Cost growth contract requires an observed positive ${dimension} scale at profile ${index}`,
        );
      return observed;
    });
    const values = profiles.map((profile) => workCostValue(profile, field));

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const smallerValue = values[i];
        const largerValue = values[j];
        if (
          smallerValue === null ||
          largerValue === null ||
          smallerValue === undefined ||
          largerValue === undefined ||
          !Number.isFinite(smallerValue) ||
          !Number.isFinite(largerValue)
        )
          throw new Error(`Cost growth contract failed: ${field} is unobserved`);
        if (smallerValue < 0 || largerValue < 0)
          throw new Error(`Cost growth contract failed: ${field} has a negative observed value`);
        if (smallerValue === 0 && largerValue === 0) continue;

        const smallerScale = scales[i]!;
        const largerScale = scales[j]!;
        const allowedRatio =
          WORK_COST_GROWTH_MARGIN *
          (factor(growthClass, largerScale) / factor(growthClass, smallerScale));
        if (!Number.isFinite(allowedRatio) || allowedRatio < 0)
          throw new Error(`Cost growth contract requires finite growth factors for ${dimension}`);
        const rawObservedRatio = smallerValue === 0 ? Infinity : largerValue / smallerValue;
        if (rawObservedRatio <= allowedRatio) continue;

        const facts: WorkCostGrowthBreach = {
          counter: field,
          dimension,
          growthClass,
          smallerScale,
          largerScale,
          smallerValue,
          largerValue,
          allowedRatio,
          observedRatio: Number.isFinite(rawObservedRatio) ? rawObservedRatio : 'Infinity',
        };
        writeWorkCostGrowthArtifact(label, facts);
        throw new Error(
          `Cost growth contract failed: ${field} (${growthClass}) by ${dimension} ` +
            `at scales ${smallerScale} and ${largerScale}, values ${smallerValue} and ${largerValue}; ` +
            `allowed ratio ${allowedRatio}, observed ratio ${facts.observedRatio}`,
        );
      }
    }
  }
}
