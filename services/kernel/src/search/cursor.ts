import { publicFilterCatalogue } from './discovery-catalogue.ts';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { PublicFilterConsumerJob, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type { SearchConsumedWindow, SearchFrontier, SearchWindowWork } from './useful-page.ts';
import type { RatingCursorContext } from './rating-cursor.ts';

export type SearchCursorBinding = { operation: string; request: unknown; principal: string };
export type SearchSortValue = string | number | null;
export type SearchCursorResult =
  | { ok: true; generation: number; after: SearchSortValue[] }
  | { ok: false; reason: 'expired' | 'invalid' };

function cursorBinding(binding: SearchCursorBinding) {
  if (
    binding === null ||
    typeof binding !== 'object' ||
    typeof binding.operation !== 'string' ||
    !binding.operation ||
    typeof binding.principal !== 'string' ||
    (binding.principal !== 'anonymous' && !/^account:.+$/.test(binding.principal))
  )
    throw new TypeError('Invalid search cursor binding');
  const canonical = canonicalize(binding.request);
  if (canonical === undefined) throw new TypeError('Search request must be canonical JSON');
  const requestHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    route: binding.operation,
    viewer: binding.principal === 'anonymous' ? null : binding.principal.slice('account:'.length),
    query: { request: requestHash },
  };
}

function encodeAfter(after: readonly SearchSortValue[]): string[] {
  if (!Array.isArray(after) || after.length > 8)
    throw new TypeError('Search cursor sort values must contain at most 8 values');
  return after.map((value) => {
    if (typeof value === 'string') return `s${value}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `n${Object.is(value, -0) ? '-0' : String(value)}`;
    if (value === null) return 'z';
    throw new TypeError('Invalid search cursor sort value');
  });
}

function decodeAfter(values: readonly string[]): SearchSortValue[] | null {
  const after: SearchSortValue[] = [];
  for (const value of values) {
    if (value === 'z') after.push(null);
    else if (value.startsWith('s')) after.push(value.slice(1));
    else if (value.startsWith('n')) {
      if (value === 'n-0') {
        after.push(-0);
        continue;
      }
      const number = Number(value.slice(1));
      if (!value.slice(1) || !Number.isFinite(number) || String(number) !== value.slice(1)) return null;
      after.push(number);
    } else return null;
  }
  return after;
}

export async function encodeSearchCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  cursor: { generation: number; after: readonly SearchSortValue[] },
  now = Date.now(),
): Promise<string> {
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid search cursor time');
  return encodeListCursor(
    ring,
    cursorBinding(binding),
    { epoch: cursor.generation, after: encodeAfter(cursor.after) },
    new Date(now),
    { profile: 'search' },
  );
}

export async function decodeSearchCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  token: string,
  now = Date.now(),
): Promise<SearchCursorResult> {
  let scope;
  try {
    scope = cursorBinding(binding);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const decoded = await decodeListCursor(ring, scope, token, new Date(Number.isSafeInteger(now) ? now : NaN), {
    profile: 'search',
  });
  if (!decoded.ok) return decoded;
  if (!decoded.after.every((value): value is string => typeof value === 'string'))
    return { ok: false, reason: 'invalid' };
  const after = decodeAfter(decoded.after);
  return after === null ? { ok: false, reason: 'invalid' } : { ok: true, generation: decoded.epoch, after };
}

/** Confidential locator only. The producer revalidates it against its native retained state. */
export type RetainedSearchContinuation = Readonly<{
  queried: PublicFilterQueriedObservation;
  repair: PublicFilterConsumerJob;
  window: SearchConsumedWindow;
  work: SearchWindowWork;
  frontier: SearchFrontier;
  rating?: RatingCursorContext;
}>;
const WINDOW_PREFIX = 'search-window-v1';

export function encodeRetainedSearchCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  generation: number,
  continuation: RetainedSearchContinuation,
  now = Date.now(),
): Promise<string> {
  const { queried, repair, window, frontier, work } = continuation;
  return encodeSearchCursor(
    ring,
    binding,
    {
      generation,
      after: [
        WINDOW_PREFIX,
        JSON.stringify({
          consumer: queried.consumer,
          snapshot:
            queried.snapshot.kind === 'prepared'
              ? { ...queried.snapshot, generation: String(queried.snapshot.generation) }
              : queried.snapshot,
          job: repair.job,
          ...window,
          ...frontier,
          work,
          ...(continuation.rating ? { rating: continuation.rating } : {}),
        }),
      ],
    },
    now,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function retainedSearchContinuation(after: readonly SearchSortValue[]): RetainedSearchContinuation | null {
  if (after.length !== 2 || after[0] !== WINDOW_PREFIX || typeof after[1] !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(after[1]);
  } catch {
    return null;
  }
  if (!record(value) || !record(value.consumer) || !record(value.snapshot) || !record(value.work)) return null;
  const c = value.consumer;
  const s = value.snapshot;
  if (
    !nonempty(c.physicalTarget) ||
    !nonempty(c.incarnation) ||
    !nonempty(c.consumerGeneration) ||
    !nonempty(c.projectionGeneration) ||
    !(c.meaningDigest === null || nonempty(c.meaningDigest)) ||
    !(c.readDefinition === null || nonempty(c.readDefinition)) ||
    !nonempty(s.observation) ||
    typeof value.work.candidates !== 'number' ||
    !Number.isInteger(value.work.candidates) ||
    value.work.candidates < 0 ||
    value.work.candidates > 600 ||
    typeof value.work.rounds !== 'number' ||
    !Number.isInteger(value.work.rounds) ||
    value.work.rounds < 1 ||
    value.work.rounds > 3 ||
    !nonempty(value.execution) ||
    !nonempty(value.job) ||
    typeof value.consumed !== 'number' ||
    !Number.isInteger(value.consumed) ||
    value.consumed < 0 ||
    value.consumed > value.work.candidates ||
    (value.ratingPhase !== undefined && value.ratingPhase !== 'scored' && value.ratingPhase !== 'unscored')
  )
    return null;
  let catalogue: ReturnType<typeof publicFilterCatalogue>;
  try {
    catalogue = publicFilterCatalogue(c);
  } catch {
    return null;
  }
  const consumer = {
    ...(c.catalogue === undefined ? {} : { catalogue }),
    physicalTarget: c.physicalTarget,
    incarnation: c.incarnation,
    consumerGeneration: c.consumerGeneration,
    projectionGeneration: c.projectionGeneration,
    meaningDigest: c.meaningDigest,
    readDefinition: c.readDefinition,
  };
  let snapshot: PublicFilterQueriedObservation['snapshot'];
  if (s.kind === 'pit' && nonempty(s.pit)) {
    snapshot = { kind: 'pit', observation: s.observation, pit: s.pit };
  } else if (
    s.kind === 'prepared' &&
    nonempty(s.build) &&
    typeof s.generation === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(s.generation)
  ) {
    snapshot = { kind: 'prepared', observation: s.observation, build: s.build, generation: BigInt(s.generation) };
  } else return null;
  const tuple = value.after;
  if (
    tuple !== undefined &&
    (!Array.isArray(tuple) ||
      tuple.length > 8 ||
      !tuple.every(
        (v): v is SearchSortValue =>
          v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
      ))
  )
    return null;
  let rating: RatingCursorContext | undefined;
  if (value.rating !== undefined) {
    const r = value.rating;
    if (
      !record(r) ||
      !nonempty(r.questionId) ||
      !nonempty(r.populationId) ||
      !(
        r.priorEpoch === null ||
        (typeof r.priorEpoch === 'number' && Number.isSafeInteger(r.priorEpoch) && r.priorEpoch > 0)
      )
    )
      return null;
    rating = { questionId: r.questionId, populationId: r.populationId, priorEpoch: r.priorEpoch };
  }
  return {
    queried: { consumer, snapshot },
    repair: { consumer, job: value.job },
    window: { execution: value.execution, consumed: value.consumed },
    work: { candidates: value.work.candidates, rounds: value.work.rounds },
    frontier: {
      ...(tuple === undefined ? {} : { after: tuple }),
      ...(value.ratingPhase === undefined ? {} : { ratingPhase: value.ratingPhase }),
    },
    ...(rating ? { rating } : {}),
  };
}

/** A real retained observation locator, not a digest over mutable index state or an authority token. */
export type DiscoveryCursorState = {
  release: string;
  registry: string;
  queried: PublicFilterQueriedObservation;
  after: SearchSortValue[];
  retained?: { execution: string; consumed: number };
  repair?: PublicFilterConsumerJob;
};
const discoveryBinding = (binding: SearchCursorBinding) => ({ ...binding, operation: 'subjects.search.discovery-v1' });
const objectValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function encodeDiscoveryCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  state: DiscoveryCursorState,
  now = Date.now(),
): Promise<string> {
  if (
    state.retained &&
    (state.after.length !== 0 ||
      !state.retained.execution ||
      !Number.isSafeInteger(state.retained.consumed) ||
      state.retained.consumed < 0)
  )
    throw new TypeError('Invalid retained discovery prefix');
  if (
    state.repair &&
    (!state.retained ||
      !state.repair.job ||
      canonicalize(state.repair.consumer) !== canonicalize(state.queried.consumer))
  )
    throw new TypeError('Invalid discovery repair locator');
  const queried = JSON.stringify(
    state.retained
      ? {
          queried: state.queried,
          retained: state.retained,
          ...(state.repair ? { repair: { job: state.repair.job } } : {}),
        }
      : state.queried,
    (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  // Four context keys and at most four comparator keys: retain the literal eight-key Search ceiling.
  return encodeSearchCursor(
    ring,
    discoveryBinding(binding),
    {
      generation: 1,
      after: [state.release, state.registry, 'mixed-public-v1', queried, ...state.after],
    },
    now,
  );
}

export async function decodeDiscoveryCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  token: string,
  now = Date.now(),
): Promise<{ ok: true; state: DiscoveryCursorState } | { ok: false; reason: 'expired' | 'invalid' }> {
  const decoded = await decodeSearchCursor(ring, discoveryBinding(binding), token, now);
  if (!decoded.ok) return decoded;
  const [release, registry, comparator, raw, ...after] = decoded.after;
  const invalid = () => ({ ok: false as const, reason: 'invalid' as const });
  if (
    decoded.generation !== 1 ||
    typeof release !== 'string' ||
    typeof registry !== 'string' ||
    comparator !== 'mixed-public-v1' ||
    typeof raw !== 'string' ||
    after.length > 4
  )
    return invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  let retained: DiscoveryCursorState['retained'];
  let repairJob: string | undefined;
  if (objectValue(value) && 'retained' in value) {
    const locator = value.retained;
    if (
      Object.keys(value).some((key) => !['queried', 'retained', 'repair'].includes(key)) ||
      !objectValue(locator) ||
      typeof locator.execution !== 'string' ||
      !locator.execution ||
      typeof locator.consumed !== 'number' ||
      !Number.isSafeInteger(locator.consumed) ||
      locator.consumed < 0 ||
      Object.keys(locator).some((key) => key !== 'execution' && key !== 'consumed') ||
      after.length !== 0
    )
      return invalid();
    retained = { execution: locator.execution, consumed: locator.consumed };
    if (value.repair !== undefined) {
      if (
        !objectValue(value.repair) ||
        Object.keys(value.repair).some((key) => key !== 'job') ||
        typeof value.repair.job !== 'string' ||
        !value.repair.job
      )
        return invalid();
      repairJob = value.repair.job;
    }
    value = value.queried;
  } else if (after.length < 3) return invalid();
  if (
    !objectValue(value) ||
    !objectValue(value.consumer) ||
    !objectValue(value.snapshot) ||
    Object.keys(value).some((key) => key !== 'consumer' && key !== 'snapshot')
  )
    return invalid();
  const consumer = value.consumer;
  const required = ['physicalTarget', 'incarnation', 'consumerGeneration', 'projectionGeneration'];
  if (
    required.some((key) => typeof consumer[key] !== 'string' || !consumer[key]) ||
    (consumer.meaningDigest !== null && typeof consumer.meaningDigest !== 'string') ||
    (consumer.readDefinition !== null && typeof consumer.readDefinition !== 'string') ||
    Object.keys(consumer).some((key) => ![...required, 'meaningDigest', 'readDefinition', 'catalogue'].includes(key))
  )
    return invalid();
  // Construct the closed native type only after validating every field; never cast decrypted JSON to authority.
  if (
    typeof consumer.physicalTarget !== 'string' ||
    typeof consumer.incarnation !== 'string' ||
    typeof consumer.consumerGeneration !== 'string' ||
    typeof consumer.projectionGeneration !== 'string' ||
    (consumer.meaningDigest !== null && typeof consumer.meaningDigest !== 'string') ||
    (consumer.readDefinition !== null && typeof consumer.readDefinition !== 'string')
  )
    return invalid();
  let catalogue: ReturnType<typeof publicFilterCatalogue>;
  try {
    catalogue = publicFilterCatalogue(consumer);
  } catch {
    return invalid();
  }
  const nativeConsumer = {
    catalogue,
    physicalTarget: consumer.physicalTarget,
    incarnation: consumer.incarnation,
    consumerGeneration: consumer.consumerGeneration,
    projectionGeneration: consumer.projectionGeneration,
    meaningDigest: consumer.meaningDigest,
    readDefinition: consumer.readDefinition,
  };
  const snapshot = value.snapshot;
  if (typeof snapshot.observation !== 'string' || !snapshot.observation) return invalid();
  let queried: PublicFilterQueriedObservation;
  if (
    snapshot.kind === 'pit' &&
    typeof snapshot.pit === 'string' &&
    snapshot.pit &&
    Object.keys(snapshot).every((key) => ['kind', 'observation', 'pit'].includes(key))
  )
    queried = {
      consumer: nativeConsumer,
      snapshot: { kind: 'pit', observation: snapshot.observation, pit: snapshot.pit },
    };
  else if (
    snapshot.kind === 'prepared' &&
    typeof snapshot.build === 'string' &&
    snapshot.build &&
    typeof snapshot.generation === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(snapshot.generation) &&
    Object.keys(snapshot).every((key) => ['kind', 'observation', 'build', 'generation'].includes(key))
  )
    queried = {
      consumer: nativeConsumer,
      snapshot: {
        kind: 'prepared',
        observation: snapshot.observation,
        build: snapshot.build,
        generation: BigInt(snapshot.generation),
      },
    };
  else return invalid();
  // A valid older locator has no independent catalogue identity to resume. Rebuild it through
  // the existing restart response instead of treating a signed former protocol as malformed.
  if (consumer.catalogue === undefined) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    state: {
      release,
      registry,
      queried,
      after,
      ...(retained ? { retained } : {}),
      ...(repairJob ? { repair: { consumer: nativeConsumer, job: repairJob } } : {}),
    },
  };
}
