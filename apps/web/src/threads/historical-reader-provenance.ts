import type { Query, QueryClient } from '@tanstack/react-query';
import type { ReadCredentialMode } from '../reader/lifetime/contract';

export type HistoricalReaderState = 'unknown' | 'signed-in' | 'signed-out' | 'preparing' | 'unavailable';

export type HistoricalReaderExpectation = {
  credentialMode: ReadCredentialMode;
  state: HistoricalReaderState;
  subject: string | null;
  csrfReady: boolean;
};

export type HistoricalReaderObservation = HistoricalReaderExpectation & {
  sourceId: string;
  generation: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  healthy: boolean;
};

export type HistoricalReadTarget =
  | {
      kind: 'exact-revision';
      postId: string;
      revisionId: string;
      locale: string;
      credentialMode: ReadCredentialMode;
    }
  | {
      kind: 'post-history';
      postId: string;
      cursor: string | null;
      locale: string;
      credentialMode: ReadCredentialMode;
    };

export type HistoricalReadBinding = {
  id: string;
  target: HistoricalReadTarget;
  expected: HistoricalReaderExpectation;
  originObservation: HistoricalReaderObservation;
  ownerGeneration: number;
  connectionGeneration: number;
  readGeneration: number;
};

export type HistoricalActualReader = {
  credentialMode: ReadCredentialMode;
  subject: string | null;
  complete: boolean;
};

export type HistoricalReadProvenance = {
  binding: HistoricalReadBinding;
  actualReader: HistoricalActualReader;
  responseGeneration: number;
};

export type HistoricalReadEnvelope<T> = {
  data: T;
  provenance: HistoricalReadProvenance;
};

export type HistoricalReaderSource = {
  id: string;
  read(): HistoricalReaderObservation;
  revision(): number;
  subscribe(listener: () => void): () => void;
};

type SessionRecord = { state?: unknown; subject?: unknown; csrfToken?: unknown };
type CachedQuery = Query<unknown, Error, unknown, readonly unknown[]>;
type StoredLineage = { id: string; generation: number };
type RawSnapshot = HistoricalReaderExpectation & {
  dataUpdateCount: number;
  dataUpdatedAt: number;
  healthy: boolean;
  token: string | null;
};

const lineageMetaKey = 'historicalReaderLineage';

function storedLineage(query: CachedQuery | undefined): StoredLineage | undefined {
  const meta = query?.options.meta as Record<string, unknown> | undefined;
  const value = meta?.[lineageMetaKey] as Partial<StoredLineage> | undefined;
  return value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    Number.isSafeInteger(value.generation) &&
    (value.generation ?? -1) >= 0
    ? { id: value.id, generation: value.generation! }
    : undefined;
}

function storeLineage(query: CachedQuery, id: string, generation: number) {
  const meta = (query.options.meta ?? {}) as Record<string, unknown>;
  query.setOptions({
    ...query.options,
    meta: { ...meta, [lineageMetaKey]: { id, generation } },
  });
}

function rawSnapshot(client: QueryClient): RawSnapshot {
  const query = client.getQueryCache().find({ queryKey: ['session'], exact: true });
  const record = query?.state.data as SessionRecord | undefined;
  const errored = query?.state.status === 'error';
  const value = typeof record?.state === 'string' ? record.state : 'unknown';
  const state: HistoricalReaderState = errored
    ? 'unavailable'
    : value === 'signed-in' || value === 'signed-out' || value === 'preparing' || value === 'unavailable'
      ? value
      : 'unknown';
  const subject = !errored && typeof record?.subject === 'string' && record.subject ? record.subject : null;
  const token = !errored && typeof record?.csrfToken === 'string' && record.csrfToken ? record.csrfToken : null;
  return {
    credentialMode: state === 'signed-in' && subject ? 'session' : 'anonymous',
    state,
    subject,
    csrfReady: token !== null,
    dataUpdateCount: query?.state.dataUpdateCount ?? 0,
    dataUpdatedAt: query?.state.dataUpdatedAt ?? 0,
    healthy: !errored,
    token,
  };
}

let sourceSequence = 0;
const sources = new WeakMap<QueryClient, HistoricalReaderSource>();

/** Observe only existing session-cache events; this never starts or refreshes a query. */
export function historicalReaderSource(client: QueryClient): HistoricalReaderSource {
  const existing = sources.get(client);
  if (existing) return existing;

  const runtime = typeof window === 'undefined' ? 'server' : 'browser';
  const query = client.getQueryCache().find({ queryKey: ['session'], exact: true });
  const snapshot = rawSnapshot(client);
  const savedLineage = storedLineage(query);
  const id = savedLineage?.id ?? `${runtime}:${++sourceSequence}:${crypto.randomUUID()}`;
  let generation = Math.max(savedLineage?.generation ?? 0, snapshot.dataUpdateCount);
  let previous = rawSnapshot(client);
  if (!previous.healthy) generation++;
  if (query) storeLineage(query, id, generation);
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
    const before = previous;
    const after = rawSnapshot(client);
    const removed = event.type === 'removed';
    const added = event.type === 'added';
    const addedWithData = event.type === 'added' && event.query.state.status === 'success';
    const success = event.type === 'updated' && event.action.type === 'success';
    const error = event.type === 'updated' && event.action.type === 'error';
    if (added && !storedLineage(event.query)) storeLineage(event.query, id, generation);
    const changed =
      before.state !== after.state ||
      before.subject !== after.subject ||
      before.token !== after.token ||
      before.csrfReady !== after.csrfReady;
    if (!removed && !addedWithData && !success && !error && !changed) return;

    // Every successful replacement is a new lifetime, including an equal-value write.
    // Errors and removals are irreversible for existing owners even if the old tuple returns.
    generation++;
    previous = after;
    if (!removed) storeLineage(event.query, id, generation);
    for (const listener of listeners) listener();
  });

  const source: HistoricalReaderSource = {
    id,
    read: () => {
      const current = rawSnapshot(client);
      return {
        credentialMode: current.credentialMode,
        state: current.state,
        subject: current.subject,
        csrfReady: current.csrfReady,
        sourceId: id,
        generation,
        dataUpdateCount: current.dataUpdateCount,
        dataUpdatedAt: current.dataUpdatedAt,
        healthy: current.healthy,
      };
    },
    revision: () => generation,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  sources.set(client, source);
  return source;
}

let bindingSequence = 0;
let responseSequence = 0;

function unknownObservation(): HistoricalReaderObservation {
  return {
    credentialMode: 'anonymous',
    state: 'unknown',
    subject: null,
    csrfReady: false,
    sourceId: 'standalone',
    generation: 0,
    dataUpdateCount: 0,
    dataUpdatedAt: 0,
    healthy: true,
  };
}

export function createHistoricalReadBinding(
  source: HistoricalReaderSource | undefined,
  target: HistoricalReadTarget,
  ownerGeneration: number,
  connectionGeneration: number,
  readGeneration: number,
  expectedSubject?: string,
): HistoricalReadBinding {
  const originObservation = source?.read() ?? unknownObservation();
  const expected =
    !source && target.credentialMode === 'session' && expectedSubject
      ? {
          credentialMode: 'session' as const,
          state: 'signed-in' as const,
          subject: expectedSubject,
          csrfReady: false,
        }
      : {
          credentialMode: target.credentialMode,
          state: originObservation.state,
          subject: originObservation.subject,
          csrfReady: originObservation.csrfReady,
        };
  return {
    id: `${originObservation.sourceId}:${++bindingSequence}`,
    target: { ...target },
    expected,
    originObservation,
    ownerGeneration,
    connectionGeneration,
    readGeneration,
  };
}

/** Build disclosure provenance only from the credential actually passed to the native client. */
export function preparedReaderProvenance(
  authorization: string | null,
  preparedSubject: string | undefined,
): HistoricalActualReader {
  if (!authorization) {
    return {
      credentialMode: 'anonymous',
      subject: null,
      complete: preparedSubject === undefined,
    };
  }
  return {
    credentialMode: 'session',
    subject: preparedSubject ?? null,
    complete: typeof preparedSubject === 'string' && preparedSubject.length > 0,
  };
}

export function historicalReadEnvelope<T>(
  binding: HistoricalReadBinding,
  actualReader: HistoricalActualReader,
  data: T,
): HistoricalReadEnvelope<T> {
  return {
    data,
    provenance: {
      binding,
      actualReader,
      responseGeneration: ++responseSequence,
    },
  };
}

function sameExpectation(a: HistoricalReaderExpectation, b: HistoricalReaderExpectation) {
  return (
    a.credentialMode === b.credentialMode &&
    a.state === b.state &&
    a.subject === b.subject &&
    a.csrfReady === b.csrfReady
  );
}

function sameObservation(a: HistoricalReaderObservation, b: HistoricalReaderObservation) {
  return (
    a.credentialMode === b.credentialMode &&
    a.state === b.state &&
    a.subject === b.subject &&
    a.csrfReady === b.csrfReady &&
    a.generation === b.generation &&
    a.dataUpdateCount === b.dataUpdateCount &&
    a.dataUpdatedAt === b.dataUpdatedAt &&
    a.healthy === b.healthy
  );
}

function targetReaderCompatible(target: HistoricalReadTarget, observation: HistoricalReaderObservation) {
  return target.credentialMode === 'session'
    ? observation.state === 'signed-in' && observation.subject !== null
    : observation.state !== 'signed-in';
}

export function sameHistoricalReadBinding(a: HistoricalReadBinding, b: HistoricalReadBinding) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function historicalBindingCurrent(
  source: HistoricalReaderSource | undefined,
  binding: HistoricalReadBinding,
  actualReader?: HistoricalActualReader,
): boolean {
  const origin = binding.originObservation;
  const sameOriginExpectation = sameExpectation(binding.expected, {
    credentialMode: binding.target.credentialMode,
    state: origin.state,
    subject: origin.subject,
    csrfReady: origin.csrfReady,
  });
  const standaloneExpectedSession =
    origin.sourceId === 'standalone' &&
    origin.generation === 0 &&
    origin.dataUpdateCount === 0 &&
    origin.state === 'unknown' &&
    origin.subject === null &&
    !origin.csrfReady &&
    binding.target.credentialMode === 'session' &&
    binding.expected.credentialMode === 'session' &&
    binding.expected.state === 'signed-in' &&
    typeof binding.expected.subject === 'string' &&
    binding.expected.subject.length > 0 &&
    !binding.expected.csrfReady;
  if (!sameOriginExpectation && !standaloneExpectedSession) return false;
  if (!targetReaderCompatible(binding.target, origin) && !standaloneExpectedSession) return false;

  if (!source) {
    if (origin.sourceId !== 'standalone' || origin.generation !== 0) return false;
    if (binding.target.credentialMode === 'anonymous') return sameOriginExpectation;
    if (!standaloneExpectedSession) return false;
    return !actualReader || historicalActualMatches(binding, actualReader);
  }
  const current = source.read();
  if (!targetReaderCompatible(binding.target, current)) return false;
  if (source.id === origin.sourceId) return current.healthy && sameObservation(origin, current);

  // A separate browser QueryClient can adopt only the same serialized query lineage and generation.
  if (!origin.healthy || !current.healthy) return false;
  const portable =
    origin.sourceId === current.sourceId &&
    origin.generation === current.generation &&
    sameObservation(origin, current);
  if (portable) return true;

  // SSR starts without a session query. One first signed-out browser preparation is the same
  // anonymous authority; a viewer preparation or any later replacement retires that visit.
  const firstAnonymousPreparation =
    (current.state === 'unknown' && current.dataUpdateCount === 0 && current.generation === 0) ||
    (current.state === 'signed-out' && current.dataUpdateCount === 1 && current.generation === 1);
  return (
    !!actualReader &&
    actualReader.complete &&
    actualReader.credentialMode === 'anonymous' &&
    actualReader.subject === null &&
    binding.target.credentialMode === 'anonymous' &&
    origin.state === 'unknown' &&
    origin.subject === null &&
    !origin.csrfReady &&
    origin.generation === 0 &&
    origin.dataUpdateCount === 0 &&
    firstAnonymousPreparation &&
    current.subject === null &&
    !current.csrfReady &&
    current.healthy
  );
}

export function historicalReaderCanRead(observation: HistoricalReaderObservation): boolean {
  return (
    observation.healthy &&
    ((observation.state === 'signed-in' && observation.subject !== null) || observation.state === 'signed-out')
  );
}

export function historicalSessionReaderReady(observation: HistoricalReaderObservation): boolean {
  return observation.healthy && observation.state === 'signed-in' && observation.subject !== null;
}

export function historicalActualMatches(binding: HistoricalReadBinding, actual: HistoricalActualReader): boolean {
  if (!actual.complete) return false;
  if (actual.credentialMode === 'anonymous') return actual.subject === null;
  return (
    binding.expected.credentialMode === 'session' &&
    binding.expected.state === 'signed-in' &&
    binding.expected.subject !== null &&
    actual.subject === binding.expected.subject
  );
}

export function validateHistoricalReadBinding(
  input: unknown,
  target: HistoricalReadTarget,
): HistoricalReadBinding | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Partial<HistoricalReadBinding>;
  const origin = value.originObservation as Partial<HistoricalReaderObservation> | undefined;
  const expected = value.expected as Partial<HistoricalReaderExpectation> | undefined;
  const suppliedTarget = value.target as HistoricalReadTarget | undefined;
  const validNumber = (entry: unknown) => Number.isSafeInteger(entry) && Number(entry) >= 0;
  if (
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 200 ||
    !suppliedTarget ||
    JSON.stringify(suppliedTarget) !== JSON.stringify(target) ||
    typeof value.ownerGeneration !== 'number' ||
    !validNumber(value.ownerGeneration) ||
    typeof value.connectionGeneration !== 'number' ||
    !validNumber(value.connectionGeneration) ||
    typeof value.readGeneration !== 'number' ||
    !validNumber(value.readGeneration) ||
    !origin ||
    typeof origin.sourceId !== 'string' ||
    origin.sourceId.length > 100 ||
    (origin.credentialMode !== 'anonymous' && origin.credentialMode !== 'session') ||
    typeof origin.state !== 'string' ||
    !['unknown', 'signed-in', 'signed-out', 'preparing', 'unavailable'].includes(origin.state) ||
    (origin.subject !== null && typeof origin.subject !== 'string') ||
    typeof origin.csrfReady !== 'boolean' ||
    typeof origin.healthy !== 'boolean' ||
    !validNumber(origin.generation) ||
    !validNumber(origin.dataUpdateCount) ||
    !validNumber(origin.dataUpdatedAt) ||
    !expected ||
    expected.credentialMode !== target.credentialMode ||
    typeof expected.state !== 'string' ||
    !['unknown', 'signed-in', 'signed-out', 'preparing', 'unavailable'].includes(expected.state) ||
    (expected.subject !== null && typeof expected.subject !== 'string') ||
    typeof expected.csrfReady !== 'boolean'
  )
    return undefined;

  const expectedMatchesOrigin =
    expected.state === origin.state && expected.subject === origin.subject && expected.csrfReady === origin.csrfReady;
  const standaloneExpectedSession =
    origin.sourceId === 'standalone' &&
    origin.generation === 0 &&
    origin.dataUpdateCount === 0 &&
    origin.state === 'unknown' &&
    origin.subject === null &&
    !origin.csrfReady &&
    target.credentialMode === 'session' &&
    expected.state === 'signed-in' &&
    typeof expected.subject === 'string' &&
    expected.subject.length > 0 &&
    !expected.csrfReady;
  if (!expectedMatchesOrigin && !standaloneExpectedSession) return undefined;

  return {
    id: value.id,
    target: { ...target },
    expected: {
      credentialMode: target.credentialMode,
      state: expected.state as HistoricalReaderState,
      subject: expected.subject ?? null,
      csrfReady: expected.csrfReady,
    },
    originObservation: {
      credentialMode: origin.credentialMode,
      state: origin.state as HistoricalReaderState,
      subject: origin.subject ?? null,
      csrfReady: origin.csrfReady,
      sourceId: origin.sourceId,
      generation: origin.generation!,
      dataUpdateCount: origin.dataUpdateCount!,
      dataUpdatedAt: origin.dataUpdatedAt!,
      healthy: origin.healthy,
    },
    ownerGeneration: value.ownerGeneration,
    connectionGeneration: value.connectionGeneration,
    readGeneration: value.readGeneration,
  };
}
