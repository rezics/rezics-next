import type { SearchSortValue } from './cursor.ts';
import type { HitResult, SearchHit } from './query.ts';
import type { RatingPhase } from './rating-cursor.ts';
import type { PublicFilterConsumerRefill, PublicFilterConsumerWindow } from './public-filter-consumer-contract.ts';

export type SearchFrontier = Readonly<{
  after?: readonly SearchSortValue[];
  ratingPhase?: RatingPhase;
}>;

export type UsefulPage<T> = Readonly<{
  status: 'filled' | 'exhausted' | 'preparing';
  values: readonly T[];
  frontier: SearchFrontier;
  candidates: number;
  rounds: number;
}>;

/** Native iteration only: read must reject incomplete shards, timeouts and lost observations.
 * In particular it must return raw hits, before disclosure/canonical filtering or slicing.
 * The caller owns the immutable observation and all native operation/point/byte accounting.
 */
export async function collectUsefulPage<T>(options: {
  limit: number;
  frontier?: SearchFrontier;
  prepared?: boolean;
  read: (request: SearchFrontier & { size: number }) => Promise<HitResult>;
  check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
  canonicalId: (value: T) => string;
}): Promise<UsefulPage<T>> {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid Search page size');
  const candidateLimit = options.prepared ? 2 * limit + 2 : Math.min(600, 6 * limit + 3);
  const roundLimit = options.prepared ? 2 : 3;
  const values: T[] = [];
  const emitted = new Set<string>();
  let frontier: SearchFrontier = {
    ...(options.frontier?.after === undefined ? {} : { after: [...options.frontier.after] }),
    ...(options.frontier?.ratingPhase === undefined ? {} : { ratingPhase: options.frontier.ratingPhase }),
  };
  let candidates = 0;
  let rounds = 0;
  const finish = (status: UsefulPage<T>['status']): UsefulPage<T> => ({
    status,
    values,
    frontier,
    candidates,
    rounds,
  });

  while (rounds < roundLimit && candidates < candidateLimit) {
    const size = Math.min(200, 2 * (limit - values.length) + 1, candidateLimit - candidates);
    rounds++;
    const page = await options.read({ ...frontier, size });
    if (page.hits.length > size) throw new Error('Native Search exceeded its candidate allowance');
    // A complete native empty seek proves no remaining indexed candidates. A short
    // nonempty response, a filtered result length and a total never establish EOF.
    if (page.hits.length === 0) return finish('exhausted');
    candidates += page.hits.length;
    // Charge and check the entire read, including unused lookahead and duplicates.
    const accepted = await options.check(page.hits);
    for (const hit of page.hits) {
      const value = accepted.get(hit);
      const id = value === undefined ? undefined : options.canonicalId(value);
      const useful = id !== undefined && !emitted.has(id);
      // Preserve the last CONSUMED tuple, rather than advancing past unused lookahead.
      if (values.length === limit && useful) break;
      frontier = {
        after: [...hit.sort],
        ...(hit.ratingPhase === undefined ? {} : { ratingPhase: hit.ratingPhase }),
      };
      if (useful && value !== undefined) {
        emitted.add(id);
        values.push(value);
      }
    }
    if (values.length === limit) return finish('filled');
  }
  // Partial work is internal. It must never become an advancing public success.
  // The native preparation owner retains finite input/frontiers; this collector
  // neither creates a job nor transfers a caller result vector to that owner.
  return finish('preparing');
}

export type SearchConsumedWindow = Readonly<{ execution: string; consumed: number }>;
export type SearchWindowWork = Readonly<{ candidates: number; rounds: number }>;
export type RetainedUsefulPage<T> = Omit<UsefulPage<T>, 'frontier'> &
  Readonly<{
    frontier: SearchFrontier;
    continuation: SearchConsumedWindow;
  }>;

/** The producer owns the retained raw keys, canonical population and all native budgets.
 * A filtered hit vector, including an empty vector, says nothing about exhaustion.
 * Each refill spends the same root allowance; no raw engine key is sent back to query.
 */
export async function collectRetainedUsefulPage<T>(options: {
  limit: number;
  prepared?: boolean;
  continuation?: SearchConsumedWindow;
  spent?: SearchWindowWork;
  frontier?: SearchFrontier;
  read: (
    size: number,
    refill?: PublicFilterConsumerRefill,
  ) => Promise<
    Readonly<{
      execution: string;
      hits: readonly SearchHit[];
      window: PublicFilterConsumerWindow;
    }>
  >;
  check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
  canonicalId: (value: T) => string;
  /** Persist the actual prefix, including rejects and duplicates, before any refill. */
  consume?: (continuation: SearchConsumedWindow) => Promise<void>;
}): Promise<RetainedUsefulPage<T>> {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid Search page size');
  const candidateLimit = options.prepared ? 2 * limit + 2 : Math.min(600, 6 * limit + 3);
  const roundLimit = options.prepared ? 2 : 3;
  const values: T[] = [];
  const emitted = new Set<string>();
  let candidates = options.spent?.candidates ?? 0;
  let rounds = options.spent?.rounds ?? 0;
  if (
    !Number.isInteger(candidates) ||
    candidates < 0 ||
    candidates > candidateLimit ||
    !Number.isInteger(rounds) ||
    rounds < 0 ||
    rounds > roundLimit ||
    (options.spent !== undefined && options.continuation === undefined)
  )
    throw new RangeError('Invalid retained Search allowance');
  let continuation = options.continuation;
  let frontier = options.frontier ?? {};
  const finish = (status: UsefulPage<T>['status']): RetainedUsefulPage<T> => {
    if (!continuation) throw new Error('Missing retained Search execution');
    return { status, values, frontier, continuation, candidates, rounds };
  };
  while (rounds < roundLimit && candidates < candidateLimit) {
    const size = Math.min(200, 2 * (limit - values.length) + 1, candidateLimit - candidates);
    const page = await options.read(size, continuation && { ...continuation, size });
    rounds++;
    const { window } = page;
    if (
      !page.execution ||
      !window ||
      !Number.isInteger(window.examined) ||
      window.examined < 0 ||
      window.examined > size ||
      typeof window.exhausted !== 'boolean' ||
      window.positions.length !== page.hits.length ||
      window.positions.some(
        (position, index) =>
          !Number.isInteger(position) ||
          position < 0 ||
          position >= window.examined ||
          (index > 0 && position <= window.positions[index - 1]!),
      )
    )
      throw new Error('Invalid retained Search window');
    candidates += window.examined;
    // Revalidation and accounting include every returned candidate, including unused suffix.
    const accepted = await options.check(page.hits);
    let consumed = window.examined;
    for (let index = 0; index < page.hits.length; index++) {
      const hit = page.hits[index]!;
      const value = accepted.get(hit);
      if (value === undefined) continue;
      const id = options.canonicalId(value);
      if (emitted.has(id)) continue;
      emitted.add(id);
      values.push(value);
      frontier = {
        after: [...hit.sort],
        ...(hit.ratingPhase === undefined ? {} : { ratingPhase: hit.ratingPhase }),
      };
      if (values.length === limit) {
        consumed = window.positions[index]! + 1;
        break;
      }
    }
    continuation = { execution: page.execution, consumed };
    await options.consume?.(continuation);
    if (consumed === window.examined && window.exhausted) return finish('exhausted');
    if (values.length === limit) return finish('filled');
    // Zero work without end evidence must prepare, rather than spin or claim EOF.
    if (window.examined === 0) break;
  }
  return finish('preparing');
}
