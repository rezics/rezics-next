export const SOURCE_OBSERVATION_PROVIDERS = ['vndb', 'bangumi'] as const;
export const SOURCE_OBSERVATION_GENERATED_SEAM =
  'KernelClient GET /v1/subjects/:id/source-statistics/:source/observations' as const;
export const SOURCE_OBSERVATION_PAGE_SIZE = 1;
export const SOURCE_OBSERVATION_MAX_PAYLOAD_BYTES = 32_768;
export const SOURCE_OBSERVATION_MAX_RESPONSE_BYTES = 68_000;

export type SourceObservationProvider = (typeof SOURCE_OBSERVATION_PROVIDERS)[number];
export type SourceObservationScale = { min: number; max: number };
export type SourceObservationFigures = {
  schemaVersion: 1;
  distribution?: {
    unit: 'ratings';
    completeness: 'complete' | 'partial';
    bins: { score: number; count: number }[];
  };
  rank?: { unit: 'subjects'; position: number; population?: number };
};
export type SourceObservationPayload =
  | {
      sourceAlias: string;
      sourceRecordId: string;
      count: 0;
      asOf: string;
    }
  | {
      sourceAlias: string;
      sourceRecordId: string;
      scale: SourceObservationScale;
      mean: number;
      figures?: SourceObservationFigures;
      count: number;
      asOf: string;
      licence: string;
      attribution: string;
    };
export type SourceObservationItem = {
  digest: string;
  payloadVersion: 1;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  nativeOrder: string | null;
  legacy: boolean;
  provenance: { kind: 'unversioned'; digest: string };
  payload: SourceObservationPayload;
};
export type SourceObservationHead = {
  digest: string | null;
  state: 'empty' | 'published' | 'cleared';
  observation: SourceObservationItem | null;
};
export type SourceObservationInspection = {
  source: SourceObservationProvider;
  head: SourceObservationHead;
  selectedObservation?: SourceObservationItem;
  history?: {
    items: SourceObservationItem[];
    nextCursor: string | null;
  };
};

export type SourceObservationRequest = {
  subjectId: string;
  source: SourceObservationProvider;
  digest?: string;
  history?: true;
  cursor?: string;
};

export type SourceObservationOutcome =
  | { kind: 'ready'; inspection: SourceObservationInspection }
  | { kind: 'denied' | 'missing' | 'invalid' | 'conflict' }
  | { kind: 'unavailable'; capability?: typeof SOURCE_OBSERVATION_GENERATED_SEAM };

export type SourceObservationOperation = (
  request: SourceObservationRequest,
) => Promise<{ status: number; data?: unknown }>;
export type SourceObservationInspect = (request: SourceObservationRequest) => Promise<SourceObservationOutcome>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function isSourceObservationProvider(value: unknown): value is SourceObservationProvider {
  return SOURCE_OBSERVATION_PROVIDERS.some((provider) => provider === value);
}

export function isSourceObservationDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function sourceObservationSelection(
  search: Record<string, unknown>,
): { source: SourceObservationProvider; digest: string } | undefined {
  return isSourceObservationProvider(search.provider) && isSourceObservationDigest(search.digest)
    ? { source: search.provider, digest: search.digest }
    : undefined;
}

export function sourceObservationHref(sourcesHref: string, source: unknown, digest: unknown): string | null {
  if (!isSourceObservationProvider(source) || !isSourceObservationDigest(digest)) return null;
  try {
    const url = new URL(sourcesHref, 'https://rezics.invalid');
    if (url.origin !== 'https://rezics.invalid') return null;
    url.searchParams.set('provider', source);
    url.searchParams.set('digest', digest);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validAlias(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

function validRecord(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function validScale(value: unknown): value is SourceObservationScale {
  return (
    isRecord(value) &&
    onlyKeys(value, ['min', 'max']) &&
    Number.isInteger(value.min) &&
    Number.isInteger(value.max) &&
    (value.min as number) >= 0 &&
    (value.max as number) > (value.min as number) &&
    (value.max as number) <= 4096
  );
}

function validFigures(value: unknown, count: number): value is SourceObservationFigures {
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion'], ['distribution', 'rank']) || value.schemaVersion !== 1)
    return false;
  if (!Object.hasOwn(value, 'distribution') && !Object.hasOwn(value, 'rank')) return false;
  if (Object.hasOwn(value, 'distribution')) {
    const distribution = value.distribution;
    if (
      !isRecord(distribution) ||
      !onlyKeys(distribution, ['unit', 'completeness', 'bins']) ||
      distribution.unit !== 'ratings' ||
      (distribution.completeness !== 'complete' && distribution.completeness !== 'partial') ||
      !Array.isArray(distribution.bins) ||
      distribution.bins.length < 1 ||
      distribution.bins.length > 10
    )
      return false;
    let priorScore = 0;
    let total = 0;
    for (const bin of distribution.bins) {
      if (
        !isRecord(bin) ||
        !onlyKeys(bin, ['score', 'count']) ||
        !Number.isInteger(bin.score) ||
        (bin.score as number) <= priorScore ||
        (bin.score as number) > 10 ||
        !Number.isSafeInteger(bin.count) ||
        (bin.count as number) < 0
      )
        return false;
      priorScore = bin.score as number;
      total += bin.count as number;
      if (!Number.isSafeInteger(total) || total > count) return false;
    }
    if (distribution.completeness === 'complete' && (distribution.bins.length !== 10 || total !== count))
      return false;
  }
  if (Object.hasOwn(value, 'rank')) {
    const rank = value.rank;
    if (
      !isRecord(rank) ||
      !onlyKeys(rank, ['unit', 'position'], ['population']) ||
      rank.unit !== 'subjects' ||
      !Number.isSafeInteger(rank.position) ||
      (rank.position as number) < 1 ||
      (Object.hasOwn(rank, 'population') &&
        (!Number.isSafeInteger(rank.population) || (rank.population as number) < (rank.position as number)))
    )
      return false;
  }
  return true;
}

function validPayload(source: SourceObservationProvider, value: unknown): value is SourceObservationPayload {
  if (!isRecord(value) || !validAlias(value.sourceAlias) || !validRecord(value.sourceRecordId) || !validDate(value.asOf))
    return false;
  if (value.count === 0)
    return onlyKeys(value, ['sourceAlias', 'sourceRecordId', 'count', 'asOf']);
  if (
    !onlyKeys(value, ['sourceAlias', 'sourceRecordId', 'scale', 'mean', 'count', 'asOf', 'licence', 'attribution'], [
      'figures',
    ]) ||
    !validScale(value.scale) ||
    typeof value.mean !== 'number' ||
    !Number.isFinite(value.mean) ||
    value.mean < value.scale.min ||
    value.mean > value.scale.max ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 1 ||
    (value.count as number) > 2_147_483_647 ||
    typeof value.licence !== 'string' ||
    value.licence.length < 1 ||
    value.licence.length > 1024 ||
    typeof value.attribution !== 'string' ||
    value.attribution.length < 1 ||
    value.attribution.length > 2000
  )
    return false;
  if (Object.hasOwn(value, 'figures')) {
    if (source !== 'bangumi' || !validFigures(value.figures, value.count as number)) return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= SOURCE_OBSERVATION_MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function validItem(source: SourceObservationProvider, value: unknown): value is SourceObservationItem {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['digest', 'payloadVersion', 'sourceAlias', 'sourceRecordId', 'asOf', 'nativeOrder', 'legacy', 'provenance', 'payload']) ||
    !isSourceObservationDigest(value.digest) ||
    value.payloadVersion !== 1 ||
    !validAlias(value.sourceAlias) ||
    !validRecord(value.sourceRecordId) ||
    !validDate(value.asOf) ||
    (value.nativeOrder !== null && (typeof value.nativeOrder !== 'string' || !/^[1-9][0-9]*$/.test(value.nativeOrder))) ||
    typeof value.legacy !== 'boolean' ||
    value.legacy !== (value.nativeOrder === null) ||
    !isRecord(value.provenance) ||
    !onlyKeys(value.provenance, ['kind', 'digest']) ||
    value.provenance.kind !== 'unversioned' ||
    value.provenance.digest !== value.digest ||
    !validPayload(source, value.payload) ||
    value.payload.sourceAlias !== value.sourceAlias ||
    value.payload.sourceRecordId !== value.sourceRecordId ||
    value.payload.asOf !== value.asOf
  )
    return false;
  return true;
}

function byteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : null;
  } catch {
    return null;
  }
}

/** Decode the mounted route's bounded response and drop its CAS resolution before Web retention. */
export function admitSourceObservation(
  request: SourceObservationRequest,
  value: unknown,
): SourceObservationInspection | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['source', 'head', 'resolution'], ['selectedObservation', 'history']) ||
    value.source !== request.source ||
    byteLength(value) === null ||
    (byteLength(value) as number) > SOURCE_OBSERVATION_MAX_RESPONSE_BYTES ||
    !isRecord(value.head) ||
    !onlyKeys(value.head, ['digest', 'state', 'observation']) ||
    (value.head.digest !== null && !isSourceObservationDigest(value.head.digest)) ||
    (value.head.observation !== null && !validItem(request.source, value.head.observation)) ||
    !isRecord(value.resolution) ||
    !onlyKeys(value.resolution, ['put', 'clear']) ||
    !isRecord(value.resolution.put) ||
    !onlyKeys(value.resolution.put, ['expectedObservation']) ||
    (value.resolution.put.expectedObservation !== null && !isSourceObservationDigest(value.resolution.put.expectedObservation)) ||
    !isRecord(value.resolution.clear) ||
    !onlyKeys(value.resolution.clear, ['expectedObservation']) ||
    (value.resolution.clear.expectedObservation !== null && !isSourceObservationDigest(value.resolution.clear.expectedObservation))
  )
    return null;
  const observation = value.head.observation as SourceObservationItem | null;
  const expectedState = observation === null ? 'empty' : observation.payload.count === 0 ? 'cleared' : 'published';
  const expectedDigest = observation?.digest ?? null;
  if (
    value.head.state !== expectedState ||
    value.head.digest !== expectedDigest ||
    value.resolution.put.expectedObservation !== expectedDigest ||
    value.resolution.clear.expectedObservation !== expectedDigest
  )
    return null;

  if (request.digest !== undefined) {
    if (!Object.hasOwn(value, 'selectedObservation') || !validItem(request.source, value.selectedObservation)) return null;
    if (value.selectedObservation.digest !== request.digest) return null;
  } else if (Object.hasOwn(value, 'selectedObservation')) return null;

  const wantsHistory = request.history === true || request.cursor !== undefined;
  if (wantsHistory !== Object.hasOwn(value, 'history')) return null;
  let history: SourceObservationInspection['history'];
  if (wantsHistory) {
    if (
      !isRecord(value.history) ||
      !onlyKeys(value.history, ['items', 'nextCursor']) ||
      !Array.isArray(value.history.items) ||
      value.history.items.length > SOURCE_OBSERVATION_PAGE_SIZE ||
      !value.history.items.every((item) => validItem(request.source, item)) ||
      (value.history.nextCursor !== null &&
        (typeof value.history.nextCursor !== 'string' || value.history.nextCursor.length > 512))
    )
      return null;
    history = { items: value.history.items, nextCursor: value.history.nextCursor };
  }
  return {
    source: request.source,
    head: { digest: expectedDigest, state: expectedState, observation },
    ...(request.digest !== undefined
      ? { selectedObservation: value.selectedObservation as SourceObservationItem }
      : {}),
    ...(history ? { history } : {}),
  };
}

export async function inspectSourceObservation(
  operation: SourceObservationOperation | null,
  request: SourceObservationRequest,
): Promise<SourceObservationOutcome> {
  if (!validSourceObservationRequest(request)) return { kind: 'invalid' };
  if (!operation) return { kind: 'unavailable', capability: SOURCE_OBSERVATION_GENERATED_SEAM };
  try {
    const response = await operation(request);
    if (response.status !== 200) {
      if (response.status === 404) return { kind: 'missing' };
      if (response.status === 401 || response.status === 403) return { kind: 'denied' };
      if (response.status === 409) return { kind: 'conflict' };
      if (response.status === 400 || response.status === 422) return { kind: 'invalid' };
      return { kind: 'unavailable' };
    }
    const inspection = admitSourceObservation(request, response.data);
    return inspection ? { kind: 'ready', inspection } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function validSourceObservationRequest(value: unknown): value is SourceObservationRequest {
  if (!isRecord(value) || !onlyKeys(value, ['subjectId', 'source'], ['digest', 'cursor', 'history'])) return false;
  if (
    typeof value.subjectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.subjectId) ||
    !isSourceObservationProvider(value.source)
  )
    return false;
  const modeCount =
    Number(Object.hasOwn(value, 'digest')) +
    Number(Object.hasOwn(value, 'cursor')) +
    Number(Object.hasOwn(value, 'history'));
  if (modeCount > 1) return false;
  if (Object.hasOwn(value, 'digest') && !isSourceObservationDigest(value.digest)) return false;
  if (
    Object.hasOwn(value, 'cursor') &&
    (typeof value.cursor !== 'string' || value.cursor.length < 1 || value.cursor.length > 512)
  )
    return false;
  if (Object.hasOwn(value, 'history') && value.history !== true) return false;
  return true;
}
