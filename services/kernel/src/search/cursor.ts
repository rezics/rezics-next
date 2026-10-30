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
  const consumer = {
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
