import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { subjectListingSource } from '../library/listing-counts.ts';
import { documentActions, type IndexAction, type SubjectDocument } from './document.ts';
import { readCreditIndexSnapshot } from './credit-index.ts';
import { withConnection } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { withSingleCommandAttempt } from '../command/command.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { readAccountDiscoveryWitness, subjectSource } from './native-bindings.ts';
import type {
  DiscoveryKey,
  DiscoveryOwnerRegistry,
  DiscoveryRegistry,
  DiscoveryIndexAction,
  IndexedDiscoveryDocument,
} from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import {
  createDiscoveryProjection,
  withDiscoveryTarget,
  validateAccountPage,
  validateAccountSnapshot,
  DiscoveryPhysicalTargetChangedError,
  type DiscoveryProjection,
  type DiscoveryTarget,
} from './account-discovery.ts';
import {
  discoveryIndexName,
  readDiscoveryPhysicalIdentity,
  discoveryAlias,
  createDiscoveryIndex,
  requireDiscoveryIndexFormat,
} from './indices.ts';
import {
  discoveryDocumentActions,
  parseDiscoveryHitIdentity,
  parseDiscoveryDocumentKey,
  validateDiscoveryDocument,
} from './discovery-documents.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { validateObservation } from './indexer.ts';
import type { Pool, PoolClient } from 'pg';
import type { DiscoveryMetadataKind, DiscoveryMetadataProducer, DiscoveryMetadataProducers } from './discovery-api.ts';
import { DiscoveryPopulationCutChangedError, DiscoveryProducerCoverageError } from './discovery-errors.ts';
import { discoveryCapabilityWitnesses, SECOND_SCOPE_PUBLIC_METADATA_KINDS } from './discovery-readiness.ts';
import type { DiscoveryCapabilityWitnesses } from './discovery-readiness.ts';
import { discardConnection } from '../database/pool.ts';
import { MAX_SUBJECT_GENERATIONS } from './generation-limit.ts';
import {
  createSubjectIndex,
  observedWrite,
  readSubjectCalendarMappingFormat,
  readSubjectCalendarMappingFormatForIndex,
  readSubjectCreditMappingFormat,
  readSubjectCreditMappingFormatForIndex,
  readSubjectIndexUuid,
  discoveryPhysicalTargetMatches,
  markSubjectCalendarReady,
  readSubjectSortFormat,
  SUBJECT_SORT_FORMAT,
  subjectAlias,
  subjectGenerations,
  subjectIndexName,
} from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch, type SearchRequestOptions } from './opensearch.ts';
import { assertCompleteSearch } from './complete-search.ts';
import reconcile from './reconcile.sql';
import freshness from './freshness.sql';
import lockRebuild from './rebuild-lock.sql';
import unlockRebuild from './rebuild-unlock.sql';

export { DiscoveryPopulationCutChangedError, DiscoveryProducerCoverageError } from './discovery-errors.ts';
export { discoveryCapabilityWitnesses, SECOND_SCOPE_PUBLIC_METADATA_KINDS } from './discovery-readiness.ts';
export type { DiscoveryCapabilityWitnesses } from './discovery-readiness.ts';

export { observedWrite };
import type { SubjectSource } from './source.ts';
import type { DiscoveryDocumentValue } from './discovery-documents.ts';
import { discoveryConsumer, subjectConsumer } from './consumer-name.ts';
export { discoveryConsumer } from './consumer-name.ts';

export { MAX_SUBJECT_GENERATIONS } from './generation-limit.ts';
export type RebuildReason = 'timeout' | 'mismatch' | 'busy' | 'running' | 'limit';
export type PartitionCount = { partition: number; indexed: number; source: number };

/** Absolute admission deadline, including time spent waiting for the supervisor. */
export type SearchTurnContext = Readonly<{ deadline?: number; signal?: AbortSignal }>;

const SEARCH_TURN_MS = 30_000;
const searchTurns = new AsyncLocalStorage<SearchTurn>();
const pendingSearchCheckouts = new WeakMap<Pool, number>();
export type SearchTurn = ReturnType<typeof admitSearchTurn>;

/** Admission belongs to the caller, before queueing. Closing a turn never renews its deadline. */
export function admitSearchTurn(context: SearchTurnContext = {}) {
  const requestedDeadline = context.deadline ?? deadlineFor(SEARCH_TURN_MS);
  if (!Number.isFinite(requestedDeadline)) throw new RangeError('Search turn deadline must be finite');
  // An explicit maintenance deadline cannot renew an earlier ambient request.
  const deadline = Math.min(requestedDeadline, deadlineFor(Math.max(1, requestedDeadline - Date.now())));
  const outside: <T>(work: () => T) => T = searchTurns.getStore()?.outside ?? AsyncLocalStorage.snapshot();
  const expired = new SearchUnavailableError('Search maintenance deadline expired');
  const controller = new AbortController();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort(context.signal?.reason ?? expired);
  if (context.signal?.aborted) cancel();
  else context.signal?.addEventListener('abort', cancel, { once: true });
  const expire = () => {
    if (Date.now() >= deadline) controller.abort(expired);
    else timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
  };
  expire();
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (closed || Date.now() >= deadline) throw expired;
  };
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    // Await physical settlement. A caller's cancellation is not evidence that native work stopped.
    const value = await work();
    check();
    return value;
  };
  const requestOptions = (options?: SearchRequestOptions): SearchRequestOptions => {
    check();
    return {
      ...options,
      timeoutMs: Math.min(options?.timeoutMs ?? Infinity, Math.max(1, Math.floor(deadline - Date.now()))),
      signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    };
  };
  return {
    deadline,
    signal: controller.signal,
    outside,
    check,
    call,
    search(search: OpenSearch): OpenSearch {
      return {
        request<T>(
          method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
          path: string,
          body?: unknown,
          options?: SearchRequestOptions,
        ) {
          return call(() => search.request<T>(method, path, body, requestOptions(options)));
        },
        bulk<T>(lines: readonly unknown[], options?: SearchRequestOptions) {
          return call(() => search.bulk<T>(lines, requestOptions(options)));
        },
        ...(search.bulkRaw
          ? {
              bulkRaw<T>(body: string, options?: SearchRequestOptions) {
                return call(() => search.bulkRaw!<T>(body, requestOptions(options)));
              },
            }
          : {}),
      };
    },
    close() {
      closed = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', cancel);
    },
  };
}

export function runSearchTurn<T>(turn: SearchTurn, work: () => Promise<T>): Promise<T> {
  return searchTurns.run(turn, () =>
    withRequestDeadline(turn.deadline, () => withSingleCommandAttempt(() => turn.call(work))),
  );
}

/** Relays own their lifetime; do not capture a maintenance deadline in their asynchronous scans. */
export function outsideSearchTurn<T>(work: () => T): T {
  const run = () => searchTurns.exit(() => withRequestDeadline(Date.now() + SEARCH_TURN_MS, work));
  // Restore all caller contexts, including command retry policy, before starting long-lived work.
  const turn = searchTurns.getStore();
  return turn ? turn.outside(run) : run();
}

async function withSearchTurn<T>(context: SearchTurnContext | undefined, work: (turn: SearchTurn) => Promise<T>) {
  const parent = searchTurns.getStore();
  if (parent && context === undefined) return parent.call(() => work(parent));
  const turn = admitSearchTurn({
    ...context,
    ...(parent
      ? {
          deadline: Math.min(parent.deadline, context?.deadline ?? Infinity),
          signal: context?.signal ? AbortSignal.any([parent.signal, context.signal]) : parent.signal,
        }
      : {}),
  });
  try {
    return await runSearchTurn(turn, () => work(turn));
  } finally {
    turn.close();
  }
}

/** Check native boundaries without changing the Pool identity or pretending to cancel an unsupported owner. */
export async function searchTurnCall<T>(work: () => Promise<T>): Promise<T> {
  const turn = searchTurns.getStore();
  return turn ? turn.call(work) : work();
}

/** Long-lived transports use the current turn only while maintenance is actually calling them. */
export function searchForTurn(search: OpenSearch): OpenSearch {
  return searchTurns.getStore()?.search(search) ?? search;
}

/** A producer may outlive this turn when installed in a relay. Resolve the context at each call. */
export function searchTurnMetadataProducers(
  producers: DiscoveryMetadataProducers,
  purpose?: 'population',
): DiscoveryMetadataProducers {
  return Object.fromEntries(
    Object.entries(producers).flatMap(([kind, producer]) => {
      if (!producer) return [];
      const readEmptyPositions = producer.readEmptyPositions?.bind(producer);
      return [
        [
          kind,
          {
            ...producer,
            readiness: (requested?: 'population') => searchTurnCall(() => producer.readiness(purpose ?? requested)),
            page: (...args: Parameters<DiscoveryMetadataProducer['page']>) =>
              searchTurnCall(() => producer.page(...args)),
            read: (...args: Parameters<DiscoveryMetadataProducer['read']>) =>
              searchTurnCall(() => producer.read(...args)),
            position: (partition: number) => searchTurnCall(() => producer.position(partition)),
            ...(readEmptyPositions && {
              readEmptyPositions: (partitions: readonly number[]) =>
                searchTurnCall(() => readEmptyPositions(partitions)),
            }),
          },
        ] as const,
      ];
    }),
  );
}

/** Only local SQL uses a bounded client. Every native owner still receives the original Pool. */
export async function withSearchConnection<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const turn = searchTurns.getStore();
  if (!turn) return withConnection(pool, work);
  turn.check();
  let acquired = false;
  let checkout: Promise<unknown> | undefined;
  let body: Promise<T> | undefined;
  const failure = (error: unknown) => (error instanceof Error ? error : new Error('Search session became uncertain'));
  try {
    return await withBoundedReadLifetime(
      (read) => {
        turn.check();
        const pending = pendingSearchCheckouts.get(pool) ?? 0;
        if (pending >= (pool.options.max ?? 10))
          throw new SearchUnavailableError('Search maintenance checkouts are still pending');
        pendingSearchCheckouts.set(pool, pending + 1);
        const acquiredOrFailed = () => {
          const left = (pendingSearchCheckouts.get(pool) ?? 1) - 1;
          if (left) pendingSearchCheckouts.set(pool, left);
          else pendingSearchCheckouts.delete(pool);
        };
        const operation = withConnection(pool, async (raw) => {
          acquired = true;
          acquiredOrFailed();
          try {
            turn.check();
            return await read(raw);
          } catch (error) {
            // Also covers a lost BEGIN/COMMIT or advisory-lock response, even between queries.
            discardConnection(raw, failure(error));
            throw error;
          } finally {
            // If engine work holds a session lock, keep it until that work actually settles.
            // A retired query facade prevents the continuation from dispatching another statement.
            await body?.catch(() => undefined);
          }
        }).finally(() => {
          if (!acquired) acquiredOrFailed();
        });
        checkout = operation;
        return operation;
      },
      discardConnection,
      turn.deadline,
      (client) => {
        const guarded = Object.create(client) as PoolClient;
        guarded.query = new Proxy(client.query, {
          apply(query, _receiver, args: unknown[]) {
            turn.check();
            return Reflect.apply(query, client, args);
          },
        });
        body = turn.call(() => work(guarded));
        return body;
      },
      {
        deadlineError: () => new SearchUnavailableError('Search maintenance database deadline expired'),
        isUncertainSettledQueryError: () => true,
        isUncertainWorkError: () => true,
      },
    );
  } finally {
    // Successful local reads close before an owner can check out from the same Pool (including max=1).
    // A late checkout has no dispatched work; its callback checks the retired lifetime and releases it.
    if (acquired) await checkout?.catch(() => undefined);
  }
}

export class RebuildError extends Error {
  readonly reason: RebuildReason;
  readonly generation: number;
  readonly partitions: PartitionCount[];

  constructor(reason: RebuildReason, generation: number, partitions: PartitionCount[] = []) {
    super(`Search generation ${generation} rebuild ${reason}`);
    this.name = 'RebuildError';
    this.reason = reason;
    this.generation = generation;
    this.partitions = partitions;
  }
}

type ReconcileRow = { partition: number; head: string | bigint; checkpoint: string | bigint };
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const numeric = (value: string | bigint): bigint => BigInt(value);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readPartitions(
  client: PoolClient,
  consumer: string,
): Promise<Map<number, { head: bigint; checkpoint: bigint }>> {
  const rows = (await reconcile.run(client, { consumer })) as ReconcileRow[];
  return new Map(rows.map((row) => [row.partition, { head: numeric(row.head), checkpoint: numeric(row.checkpoint) }]));
}

type CountSnapshot = { position: bigint; count: number };

function countSnapshot(value: unknown): CountSnapshot {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'position') ||
    !Object.hasOwn(value, 'count') ||
    typeof value.position !== 'bigint' ||
    value.position < 0n ||
    value.position > 9_223_372_036_854_775_807n ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    throw new SearchUnavailableError('Source reconciliation count snapshot is missing or malformed');
  return { position: value.position, count: value.count };
}

async function sourceCounts(
  source: SubjectSource,
  partitions: number[],
  deadline: number,
  check: () => void,
): Promise<Map<number, CountSnapshot>> {
  check();
  const counts = new Map<number, CountSnapshot>();
  for (let offset = 0; offset < partitions.length; offset += 8) {
    const batch = partitions.slice(offset, offset + 8);
    // Drain every dispatched observation even when one receipt is invalid.
    const values = await Promise.allSettled(
      batch.map(async (partition) => {
        check();
        const value = await withRequestDeadline(deadline, () => source.count(partition));
        return [partition, countSnapshot(value)] as const;
      }),
    );
    check();
    for (const value of values) {
      if (value.status === 'rejected') throw value.reason;
      const [partition, snapshot] = value.value;
      counts.set(partition, snapshot);
    }
  }
  return counts;
}

async function indexCounts(search: OpenSearch, index: string): Promise<Map<number, number>> {
  const response = await search.request<unknown>(
    'POST',
    `/${index}/_search`,
    {
      size: 0,
      aggs: { partitions: { terms: { field: 'partition', size: 4096 } } },
    },
    { query: { allow_partial_search_results: false } },
  );
  if (!record(response) || response.status !== 200)
    throw new SearchUnavailableError('OpenSearch reconciliation response is malformed');
  assertCompleteSearch(response.body);

  if (!record(response.body) || !record(response.body.aggregations)) {
    throw new SearchUnavailableError('OpenSearch reconciliation aggregation is missing or malformed');
  }
  const partitions = response.body.aggregations.partitions;
  if (
    !record(partitions) ||
    partitions.doc_count_error_upper_bound !== 0 ||
    partitions.sum_other_doc_count !== 0 ||
    !Array.isArray(partitions.buckets) ||
    partitions.buckets.length > 4096
  ) {
    throw new SearchUnavailableError('OpenSearch reconciliation partitions are missing or malformed');
  }

  const counts = new Map<number, number>();
  for (const bucket of partitions.buckets) {
    if (!record(bucket)) {
      throw new SearchUnavailableError('OpenSearch reconciliation bucket is malformed');
    }
    if (Object.hasOwn(bucket, 'doc_count_error_upper_bound') && bucket.doc_count_error_upper_bound !== 0)
      throw new SearchUnavailableError('OpenSearch reconciliation bucket has incomplete counts');
    const { key, doc_count: count } = bucket;
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > 4095 || counts.has(key)) {
      throw new SearchUnavailableError('OpenSearch reconciliation partition is invalid');
    }
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new SearchUnavailableError('OpenSearch reconciliation count is invalid');
    }
    counts.set(key, count);
  }
  return counts;
}

export async function rebuildSubjects(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  prefix: string;
  runner: { refresh(context?: SearchTurnContext): Promise<void> };
  /** The real default worker owns identified reconciliation and alias activation. */
  publication?: 'native';
  pollMs?: number;
  rounds?: number;
  timeoutMs?: number;
}): Promise<{ generation: number; previous: number | null }> {
  const pollMs = options.pollMs ?? 500;
  const rounds = options.rounds ?? 5;
  const timeoutMs = options.timeoutMs ?? 3_600_000;
  if (!Number.isInteger(pollMs) || pollMs < 0) throw new RangeError('pollMs must be a non-negative integer');
  if (!Number.isInteger(rounds) || rounds < 1) throw new RangeError('rounds must be a positive integer');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError('timeoutMs must be a non-negative finite number');

  const deadline = Date.now() + timeoutMs;
  const lock = subjectAlias(options.prefix);
  const lifetime = new AbortController();
  let generation = 1;
  const timeoutError = () => new RebuildError('timeout', generation);
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (lifetime.signal.aborted || milliseconds <= 0) throw timeoutError();
    return Math.max(1, Math.min(2_147_483_647, Math.floor(milliseconds)));
  };
  const check = () => {
    remaining();
  };
  const poll = async () => {
    await sleep(Math.min(pollMs, remaining()));
    check();
  };
  // Helpers retain their native observation/recovery behavior, with every physical request bounded.
  const search: OpenSearch = {
    ...options.search,
    async request<T>(
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      path: string,
      body?: unknown,
      requestOptions?: SearchRequestOptions,
    ) {
      const response = await options.search.request<T>(method, path, body, {
        ...requestOptions,
        timeoutMs: Math.min(requestOptions?.timeoutMs ?? Infinity, remaining()),
        signal: requestOptions?.signal ? AbortSignal.any([lifetime.signal, requestOptions.signal]) : lifetime.signal,
      });
      check();
      return response;
    },
  };

  let connection: PoolClient | undefined;
  let released = false;
  let lockMayBeHeld = false;
  let discard: Error | undefined;
  const release = () => {
    if (!connection || released) return;
    released = true;
    if (lockMayBeHeld) discard ??= new Error('Search rebuild advisory lock custody is uncertain');
    if (discard) discardConnection(connection, discard);
    connection.release(discard);
  };
  const rebuild = async (client: PoolClient): Promise<{ generation: number; previous: number | null }> => {
    // A lost lock response is custody, too: never return that session to the pool.
    lockMayBeHeld = true;
    const row = (await lockRebuild.run(client, { alias: lock })) as { locked: boolean | null };
    if (row.locked !== true && row.locked !== false)
      throw new Error('Search rebuild advisory lock custody could not be established');
    lockMayBeHeld = row.locked;
    if (!lockMayBeHeld) {
      const state = await subjectGenerations(search, options.prefix);
      throw new RebuildError('running', state.generations.at(-1) ?? 1);
    }
    try {
      const state = await subjectGenerations(search, options.prefix);
      const previous = state.active;
      const highest = state.generations.at(-1) ?? 0;
      generation = highest > (previous ?? 0) ? highest : highest + 1;
      // Advanced checkpoints cannot replay documents through a different physical writer codec.
      const resumable =
        highest > (previous ?? 0) &&
        (await readSubjectSortFormat(search, options.prefix, highest)) === SUBJECT_SORT_FORMAT &&
        (await readSubjectCalendarMappingFormat(search, options.prefix, highest)) === 1 &&
        (await readSubjectCreditMappingFormat(search, options.prefix, highest)) === 1;
      generation = resumable ? highest : highest + 1;
      if (generation > highest && state.generations.length >= MAX_SUBJECT_GENERATIONS)
        throw new RebuildError('limit', generation);
      await createSubjectIndex(search, options.prefix, generation);
      const format = await readSubjectSortFormat(search, options.prefix, generation);
      if (format !== SUBJECT_SORT_FORMAT)
        throw new SearchUnavailableError('Search rebuild requires a new bounded-format generation');
      if ((await readSubjectCalendarMappingFormat(search, options.prefix, generation)) !== 1)
        throw new SearchUnavailableError('Search rebuild requires the requested calendar projection');
      if ((await readSubjectCreditMappingFormat(search, options.prefix, generation)) !== 1)
        throw new SearchUnavailableError('Search rebuild requires the credited-name projection');
      check();
      await options.runner.refresh({ deadline, signal: lifetime.signal });
      check();

      if (options.publication === 'native') {
        for (;;) {
          const published = await subjectGenerations(search, options.prefix);
          check();
          if (published.active === generation) return { generation, previous };
          if (published.active !== previous) throw new RebuildError('running', generation);
          await poll();
        }
      }

      const consumer = subjectConsumer(options.prefix, generation);
      // Only checkpoint lag is needed here; read it on the bounded lock session in autocommit.
      while ([...(await readPartitions(client, consumer)).values()].some(({ head, checkpoint }) => head > checkpoint))
        await poll();

      const index = subjectIndexName(options.prefix, generation);
      let pending = new Map<number, { head: bigint; checkpoint: bigint }>();
      let lastCounts = new Map<number, PartitionCount>();
      const mismatches = new Map<number, PartitionCount>();
      for (let round = 0; round < rounds; round += 1) {
        check();
        const before = await readPartitions(client, consumer);
        const source = await sourceCounts(options.source, [...before.keys()], deadline, check);
        const indexed = await indexCounts(search, index);
        const after = await readPartitions(client, consumer);
        pending = new Map();
        for (const [partition, start] of before) {
          const finish = after.get(partition);
          const snapshot = source.get(partition)!;
          const sourceCount = snapshot.count;
          const indexedCount = indexed.get(partition) ?? 0;
          const counts = { partition, indexed: indexedCount, source: sourceCount };
          lastCounts.set(partition, counts);
          const quiet =
            finish !== undefined &&
            start.head === start.checkpoint &&
            finish.head === finish.checkpoint &&
            start.head === finish.head &&
            snapshot.position === start.head;
          if (quiet) {
            if (indexedCount !== sourceCount) mismatches.set(partition, counts);
            else mismatches.delete(partition);
          } else {
            pending.set(partition, finish ?? start);
          }
        }
        const added = await sourceCounts(
          options.source,
          [...after.keys()].filter((partition) => !before.has(partition)),
          deadline,
          check,
        );
        for (const [partition, finish] of after) {
          if (!before.has(partition)) {
            pending.set(partition, finish);
            const counts = {
              partition,
              indexed: indexed.get(partition) ?? 0,
              source: added.get(partition)!.count,
            };
            lastCounts.set(partition, counts);
          }
        }
        for (const [partition, indexedCount] of indexed) {
          if (!before.has(partition) && !after.has(partition)) {
            mismatches.set(partition, { partition, indexed: indexedCount, source: 0 });
          }
        }
        check();
        if (mismatches.size > 0) {
          throw new RebuildError(
            'mismatch',
            generation,
            [...mismatches.values()].sort((a, b) => a.partition - b.partition),
          );
        }
        if (pending.size === 0) break;
        if (round + 1 < rounds) await poll();
      }
      if (pending.size > 0) {
        throw new RebuildError(
          'busy',
          generation,
          [...pending.keys()]
            .map((partition) => lastCounts.get(partition) ?? { partition, indexed: 0, source: 0 })
            .sort((a, b) => a.partition - b.partition),
        );
      }

      check();
      const activatedAt = new Date().toISOString();
      const calendarIncarnation = await markSubjectCalendarReady(search, options.prefix, generation);
      await observedWrite(
        () =>
          search.request('PUT', `/${index}/_mapping`, {
            _meta: {
              name_sort_format: format,
              activated_at: activatedAt,
              calendar_range_format: 1,
              calendar_range_ready: 1,
              calendar_range_incarnation: calendarIncarnation,
            },
          }),
        async () => {
          const response = await search.request<unknown>('GET', `/${index}/_mapping`);
          if (!record(response) || response.status !== 200 || !record(response.body)) return false;
          const names = Object.keys(response.body);
          if (names.length !== 1 || names[0] !== index) return false;
          const entry = response.body[index];
          if (!record(entry) || !record(entry.mappings) || !record(entry.mappings.properties)) return false;
          const meta = entry.mappings._meta;
          if (!record(meta) || meta.name_sort_format !== format || meta.activated_at !== activatedAt) return false;
          if (
            meta.calendar_range_format !== 1 ||
            meta.calendar_range_ready !== 1 ||
            meta.calendar_range_incarnation !== calendarIncarnation
          )
            return false;
          return (await readSubjectIndexUuid(search, options.prefix, generation)) === calendarIncarnation;
        },
        'Search generation activation mapping could not be established',
      );
      const actions: unknown[] = [];
      if (previous !== null)
        actions.push({
          remove: { index: subjectIndexName(options.prefix, previous), alias: subjectAlias(options.prefix) },
        });
      actions.push({ add: { index, alias: subjectAlias(options.prefix) } });
      await observedWrite(
        () => search.request('POST', '/_aliases', { actions }),
        async () => {
          const final = await subjectGenerations(search, options.prefix);
          return final.active === generation && final.generations.includes(generation);
        },
        'Search generation alias activation could not be established',
      );
      check();
      return { generation, previous };
    } finally {
      try {
        const row = (await unlockRebuild.run(client, { alias: lock })) as { unlocked: boolean | null };
        if (row.unlocked !== true) throw new Error('Search rebuild advisory lock was not held');
        lockMayBeHeld = false;
      } catch (error) {
        discard ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  try {
    return await withBoundedReadLifetime(
      async (work) => {
        // The rebuild owns a session lock, not a native snapshot. Do not install withConnection's
        // nested-checkout guard: Source and the runner still need short reads on this exact Pool.
        connection = await options.pool.connect();
        try {
          return await work(connection);
        } finally {
          release();
        }
      },
      (client, error) => {
        discard ??= error;
        discardConnection(client, error);
      },
      deadline,
      rebuild,
      {
        deadlineError: timeoutError,
        mapError: (error) => (Date.now() >= deadline ? timeoutError() : error),
        isUncertainSettledQueryError: () => true,
      },
    );
  } finally {
    lifetime.abort();
    // Also retire custody when an outer deadline wins before the callback unwinds. A queued
    // checkout that arrives later is retired by the lifetime and released by its own finally.
    release();
  }
}

export type DiscoveryCapabilityBinding = Readonly<{
  physicalTarget: string;
  uuid: string;
  incarnation: string;
  witnesses: DiscoveryCapabilityWitnesses;
}>;
export type DiscoveryGeneration = DiscoveryTarget & {
  state: string;
  kinds: string[];
  capability: DiscoveryCapabilityBinding | null;
};

export function discoveryCapabilityMatches(
  target: DiscoveryTarget,
  binding: DiscoveryCapabilityBinding | null | undefined,
  witnesses: DiscoveryCapabilityBinding['witnesses'],
): boolean {
  return (
    !!binding &&
    binding.physicalTarget === discoveryIndexName(target.prefix, target.generation) &&
    binding.uuid === target.uuid &&
    binding.incarnation === target.incarnation &&
    isDeepStrictEqual(binding.witnesses, witnesses)
  );
}

/** Used before and after native work, including final disclosure on a retained physical target. */
export async function assertDiscoveryCapabilityBinding(
  pool: Pool,
  target: DiscoveryTarget & Partial<Pick<DiscoveryGeneration, 'capability'>>,
  producers: DiscoveryMetadataProducers,
): Promise<void> {
  const witnesses = await discoveryCapabilityWitnesses(searchTurnMetadataProducers(producers));
  const currentKinds = Object.keys(witnesses);
  const boundKinds = Object.keys(target.capability?.witnesses ?? {});
  if (currentKinds.length === 0 && boundKinds.length === 0 && !producers.space) return;
  const row = await withSearchConnection(
    pool,
    async (client) =>
      (
        await client.query<{ capability: DiscoveryCapabilityBinding | null }>(
          `SELECT capability FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND generation=$2
       AND index_uuid=$3 AND incarnation=$4::uuid AND state NOT IN ('allocated','retired','quarantined')`,
          [target.prefix, target.generation, target.uuid, target.incarnation],
        )
      ).rows[0],
  );
  if (!discoveryCapabilityMatches(target, row?.capability, witnesses))
    throw new DiscoveryProducerCoverageError({
      missingKinds: [],
      unsupportedKinds: [
        ...new Set([...boundKinds, ...currentKinds, ...Object.keys(row?.capability?.witnesses ?? {})]),
      ],
      duplicateKinds: [],
    });
}

export type DiscoveryProducerRegistration = Readonly<{ kind: string; owner: string }>;

function discoveryProducerRegistrations(registry: DiscoveryRegistry): DiscoveryProducerRegistration[] {
  const registrations: DiscoveryProducerRegistration[] = registry.entries.map(({ kind, owner }) => ({ kind, owner }));
  const ownerRegistry = registry as DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>;
  for (const kind of SECOND_SCOPE_PUBLIC_METADATA_KINDS) {
    const slot = ownerRegistry.ownerAdapters?.[kind];
    if (slot?.readiness === 'ready') registrations.push({ kind, owner: slot.adapter.owner });
  }
  return registrations;
}

/** Validate readiness before allocation can create a physical target or population rows. */
export function assertDiscoveryProducerCoverage(
  registrations: readonly DiscoveryProducerRegistration[],
  requiredKinds: readonly string[] = [],
  producerKinds: readonly string[] = ['account', 'subject'],
): void {
  const owners = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const { kind, owner } of registrations) {
    if (!kind || !owner) throw new TypeError('Discovery producer registrations require a kind and owner');
    if (owners.has(kind)) duplicates.add(kind);
    else owners.set(kind, owner);
  }
  const missingKinds = [...new Set(requiredKinds)].filter((kind) => !owners.has(kind)).sort();
  const expectedOwners: Readonly<Record<string, string>> = {
    account: 'accounts',
    subject: 'semantic',
    collection: 'commerce',
    review: 'content',
    space: 'content',
  };
  const available = new Set(producerKinds);
  const unsupportedKinds = [
    ...new Set([
      ...[...owners]
        .filter(([kind, owner]) =>
          expectedOwners[kind] === undefined ? owner !== 'semantic' : expectedOwners[kind] !== owner,
        )
        .map(([kind]) => kind),
      ...[...owners.keys()].filter((kind) => expectedOwners[kind] !== undefined && !available.has(kind)),
      ...requiredKinds.filter((kind) => owners.has(kind) && !available.has(kind)),
      ...producerKinds.filter((kind) => expectedOwners[kind] === undefined),
    ]),
  ].sort();
  const duplicateKinds = [...duplicates].sort();
  if (missingKinds.length || unsupportedKinds.length || duplicateKinds.length)
    throw new DiscoveryProducerCoverageError({ missingKinds, unsupportedKinds, duplicateKinds });
}

// Circular import evaluation can observe this module before indices.ts initializes MAX_SUBJECT_GENERATIONS.
const DISCOVERY_LIVE_LIMIT = 4;
const LIVE_QUOTA_STATES = new Set(['active', 'retiring', 'quarantined']);

/** Descending primary-key seek for the historical high water, independent of retired-row count. */
export const DISCOVERY_GENERATION_HIGH_WATER_SQL = `SELECT generation::text FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 ORDER BY partition_no DESC, prefix DESC, generation DESC LIMIT 1`;

/** Partial live index plus overflow LIMIT; a fourth live row is corrupt evidence. */
export const DISCOVERY_LIVE_GENERATIONS_SQL = `SELECT prefix,generation::float8 AS generation,index_uuid AS uuid,
    incarnation::text,state,kinds,capability FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND state <> 'retired' ORDER BY partition_no, prefix, generation LIMIT ${DISCOVERY_LIVE_LIMIT}`;

function admitLiveDiscovery(rows: DiscoveryGeneration[]): DiscoveryGeneration[] {
  if (DISCOVERY_LIVE_LIMIT !== MAX_SUBJECT_GENERATIONS + 1)
    throw new Error('Discovery live overflow LIMIT must stay MAX_SUBJECT_GENERATIONS + 1');
  if (rows.length > MAX_SUBJECT_GENERATIONS)
    throw new SearchUnavailableError('Discovery live generation inventory is corrupt');
  return rows;
}

export async function discoveryGenerations(
  pool: Pool,
  prefix: string,
  context?: SearchTurnContext,
): Promise<DiscoveryGeneration[]> {
  return withSearchTurn(context, () =>
    withSearchConnection(pool, async (client) =>
      admitLiveDiscovery((await client.query<DiscoveryGeneration>(DISCOVERY_LIVE_GENERATIONS_SQL, [prefix])).rows),
    ),
  );
}

/** Short allocation transaction registers replay before any native population observation. */
export async function allocateDiscovery(
  pool: Pool,
  prefix: string,
  registry: DiscoveryRegistry,
  requiredKinds: readonly string[] = [],
  producerKinds: readonly string[] = ['account', 'subject'],
  context?: SearchTurnContext,
): Promise<void> {
  return withSearchTurn(context, () => allocateDiscoveryTurn(pool, prefix, registry, requiredKinds, producerKinds));
}

async function allocateDiscoveryTurn(
  pool: Pool,
  prefix: string,
  registry: DiscoveryRegistry,
  requiredKinds: readonly string[],
  producerKinds: readonly string[],
): Promise<void> {
  assertDiscoveryProducerCoverage(discoveryProducerRegistrations(registry), requiredKinds, producerKinds);
  discoveryAlias(prefix);
  await withSearchConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [discoveryAlias(prefix)]);
      const live = admitLiveDiscovery(
        (await client.query<DiscoveryGeneration>(DISCOVERY_LIVE_GENERATIONS_SQL, [prefix])).rows,
      );
      if (live.some((row) => !LIVE_QUOTA_STATES.has(row.state))) {
        await client.query('COMMIT');
        return;
      }
      if (live.length >= MAX_SUBJECT_GENERATIONS) throw new Error('Discovery live generation limit reached');
      const highest = (await client.query<{ generation: string }>(DISCOVERY_GENERATION_HIGH_WATER_SQL, [prefix]))
        .rows[0]?.generation;
      const next = BigInt(highest ?? '0') + 1n;
      if (next > BigInt(Number.MAX_SAFE_INTEGER))
        throw new SearchUnavailableError('Discovery generation numbers are exhausted');
      const generation = Number(next);
      discoveryIndexName(prefix, generation);
      const consumer = discoveryConsumer(prefix, generation);
      await client.query(
        `INSERT INTO search.discovery_generation(prefix,generation,incarnation,kinds,state) VALUES ($1,$2,$3,$4,'allocated')`,
        [prefix, generation, Bun.randomUUIDv7(), registry.entries.map(({ kind }) => kind).sort()],
      );
      await client.query(
        `INSERT INTO search.discovery_population(partition_no,prefix,generation,owner)
        SELECT p,$1,$2,owner FROM generate_series(0,4095) p CROSS JOIN unnest($3::text[]) owner`,
        [
          prefix,
          generation,
          [
            'accounts',
            'semantic',
            ...SECOND_SCOPE_PUBLIC_METADATA_KINDS.filter((kind) => requiredKinds.includes(kind)),
          ],
        ],
      );
      await client.query(
        `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
        SELECT partition_no,$1,CASE WHEN position=0 THEN NULL ELSE epoch END,position
        FROM core.partition ON CONFLICT DO NOTHING`,
        [consumer],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

type Population = {
  partition: number;
  owner: 'accounts' | 'semantic' | DiscoveryMetadataKind;
  after_route: number | null;
  after_id: string | null;
  continuation: string | null;
  position: string;
  revision: string;
  claim_revision: string;
  indexed: string;
  census: string;
  reconcile_position: string | null;
  native_complete: boolean;
  native_epoch: number | null;
};

const DISCOVERY_POPULATIONS_PER_ADVANCE = 128;
const DISCOVERY_POPULATION_CONCURRENCY = 8;
const DISCOVERY_CERTIFICATION_CONCURRENCY = 16;

async function mapBounded<T, Result>(
  items: readonly T[],
  concurrency: number,
  workForBatch: (batch: readonly T[]) => (item: T) => Promise<Result>,
  stopAfterBatch?: (result: Result) => boolean,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const itemsInBatch = items.slice(offset, offset + concurrency);
    const work = workForBatch(itemsInBatch);
    const settled = await Promise.allSettled(itemsInBatch.map(work));
    searchTurns.getStore()?.check();
    const batch: Result[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw outcome.reason;
      batch.push(outcome.value);
    }
    results.push(...batch);
    if (stopAfterBatch && batch.some(stopAfterBatch)) break;
  }
  return results;
}

function discoveryPageCapabilityCheck(pool: Pool, { target, metadataProducers }: DiscoveryProjection) {
  let scheduled: Promise<void> | undefined;
  return () => {
    // Share only checks queued before the native observation starts. A page that reaches
    // its next check during that observation must still obtain a fresh one.
    return (scheduled ??= Promise.resolve().then(() => {
      scheduled = undefined;
      return assertDiscoveryCapabilityBinding(pool, target, metadataProducers);
    }));
  };
}

function discoveryPageReadBatch<Result>(rows: readonly Population[], checkEmpty: () => Promise<Result>) {
  const pending = new Set(rows);
  const settled = Promise.withResolvers<void>();
  let emptyPageCheck: Promise<Result> | undefined;
  return {
    observed(row: Population) {
      pending.delete(row);
      if (pending.size === 0) settled.resolve();
    },
    checkEmptyPage() {
      // Start the shared check after all participating native observations have settled.
      return (emptyPageCheck ??= settled.promise.then(checkEmpty));
    },
  };
}

function reviewCertificationBatch(
  rows: readonly { partition: number }[],
  read: NonNullable<DiscoveryMetadataProducer['readEmptyPositions']>,
) {
  const pending = new Set(rows);
  const requested = new Set<number>();
  const settled = Promise.withResolvers<void>();
  let positions: Promise<ReadonlyMap<number, bigint>> | undefined;
  const observed = (row: { partition: number }) => {
    pending.delete(row);
    if (pending.size === 0) settled.resolve();
  };
  return {
    observed,
    async position(row: { partition: number }) {
      requested.add(row.partition);
      observed(row);
      // Collection can short-circuit a row. Wait until the wave has identified every Review request.
      positions ??= settled.promise.then(async () => {
        const partitions = rows.filter(({ partition }) => requested.has(partition)).map(({ partition }) => partition);
        const result = await read(partitions);
        if (
          result.size !== partitions.length ||
          partitions.some((partition) => typeof result.get(partition) !== 'bigint')
        )
          throw new SearchUnavailableError('Discovery Review positions are incomplete');
        return result;
      });
      return (await positions).get(row.partition)!;
    },
  };
}

type PopulationAdvance = {
  partition_no: number;
  owner: Population['owner'];
  prior_id: string | null;
  prior_continuation: string | null;
  after_route: number | null;
  after_id: string | null;
  continuation: string | null;
  native_epoch: number | null;
  position: string;
};

function populationCheckpointBatch(pool: Pool, target: DiscoveryTarget, rows: readonly Population[]) {
  const plans: PopulationAdvance[] = [];
  const batch = discoveryPageReadBatch(rows, async () => {
    await withSearchConnection(pool, async (client) => {
      await client.query(
        `WITH input AS MATERIALIZED (
           SELECT * FROM jsonb_to_recordset($3::jsonb) AS i(
             partition_no integer, owner text, prior_id uuid, prior_continuation jsonb,
             after_route integer, after_id uuid, continuation jsonb, native_epoch integer, position bigint)
         ), locked AS MATERIALIZED (
           SELECT p.partition_no,p.owner
           FROM search.discovery_population p JOIN input i
             ON (p.partition_no,p.owner)=(i.partition_no,i.owner)
           WHERE p.prefix=$1 AND p.generation=$2 AND NOT p.complete
             AND p.after_id IS NOT DISTINCT FROM i.prior_id
             AND (p.owner IN ('accounts','semantic') OR p.continuation IS NOT DISTINCT FROM i.prior_continuation)
           ORDER BY p.partition_no,p.owner FOR UPDATE OF p
         )
         UPDATE search.discovery_population p
         SET after_route=i.after_route,after_id=i.after_id,complete=i.after_id IS NULL,
             position=GREATEST(p.position,i.position),
             continuation=CASE WHEN p.owner IN ('accounts','semantic') THEN p.continuation ELSE i.continuation END,
             native_epoch=CASE WHEN p.owner IN ('accounts','semantic') THEN p.native_epoch ELSE i.native_epoch END
         FROM input i JOIN locked l ON (l.partition_no,l.owner)=(i.partition_no,i.owner)
         WHERE p.prefix=$1 AND p.generation=$2 AND (p.partition_no,p.owner)=(l.partition_no,l.owner)`,
        [target.prefix, target.generation, JSON.stringify(plans)],
      );
    });
  });
  return {
    observed: batch.observed,
    async save(
      row: Population,
      next: { route: number; id: string } | null,
      position: bigint,
      continuation: string | null = null,
      nativeEpoch: number | null = null,
    ) {
      plans.push({
        partition_no: row.partition,
        owner: row.owner,
        prior_id: row.after_id,
        prior_continuation: row.continuation,
        after_route: next?.route ?? null,
        after_id: next?.id ?? null,
        continuation,
        native_epoch: nativeEpoch,
        position: position.toString(),
      });
      batch.observed(row);
      await batch.checkEmptyPage();
    },
  };
}

async function populationPage(
  pool: Pool,
  projection: DiscoveryProjection,
  row: Population,
  checkCapability: () => Promise<void>,
  reads: ReturnType<typeof discoveryPageReadBatch>,
  checkpoints: ReturnType<typeof populationCheckpointBatch>,
): Promise<boolean> {
  const { registry, target } = projection,
    partition = row.partition;
  const account = registry.get('account');
  if (account.owner !== 'accounts') throw new Error('Native Accounts producer is required');
  let next: { route: number; id: string } | null, keys: DiscoveryKey[], position: bigint;
  if (row.owner === 'accounts') {
    const after = row.after_id === null ? null : { route: row.after_route!, id: row.after_id };
    const page = validateAccountPage(
      await searchTurnCall(() => account.source.page(partition, after, 100)),
      partition,
      after,
      100,
    );
    keys = page.accounts.map(({ id }) => ({ owner: 'accounts', kind: 'account', id, route: routeOf(id)! }));
    next = page.next;
    position = page.position;
  } else if (row.owner === 'semantic') {
    const rows = await withSearchConnection(
      pool,
      async (client) =>
        (
          await client.query<{ route: number; id: string; kind: string }>(
            `SELECT route,subject_id::text AS id,type AS kind FROM semantic.subject WHERE route >= $1 AND route < $2
       AND ($3::integer IS NULL OR (route,subject_id)>($3,$4::uuid)) ORDER BY route,subject_id LIMIT 257`,
            [partition * 16, (partition + 1) * 16, row.after_route, row.after_id],
          )
        ).rows,
    );
    keys = rows.slice(0, 256).map((row) => ({ owner: 'semantic', ...row }));
    const last = keys.at(-1);
    next = rows.length === 257 && last ? { route: last.route, id: last.id } : null;
    position = 0n;
  } else {
    const producer = await retainedMetadataProducer(pool, projection, row.owner);
    if (!producer) return true;
    await checkCapability();
    const after = row.after_id === null ? null : { route: row.after_route!, id: row.after_id };
    const page = await nativePopulationPage(pool, target, producer, partition, after, row.continuation);
    reads.observed(row);
    if (!page) return true;
    if (row.native_epoch !== null && page.epoch !== row.native_epoch) {
      await retireDiscoveryCapability(pool, target);
      return true;
    }
    if (page.position < 0n || page.position > 9_223_372_036_854_775_807n)
      throw new TypeError('Metadata discovery page has an invalid native position');
    const actions = projection.prepareOwnerPageActions(row.owner, partition, page);
    next = page.next;
    position = page.position;
    // Empty native pages advance owner coverage without reserving an engine write.
    if (actions.length === 0) {
      await reads.checkEmptyPage();
      await checkpoints.save(row, next, position, page.continuation, page.epoch ?? null);
      return false;
    }
    checkpoints.observed(row);
    await searchTurnCall(() => projection.applyNativeActions(actions));
    await checkCapability();
    await withSearchConnection(pool, async (client) => {
      await client.query(
        `UPDATE search.discovery_population SET after_route=$5,after_id=$6,continuation=$7::jsonb,
        complete=$8,position=GREATEST(position,$9),native_epoch=$12
        WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4
        AND after_id IS NOT DISTINCT FROM $10::uuid AND continuation IS NOT DISTINCT FROM $11::jsonb AND NOT complete`,
        [
          partition,
          target.prefix,
          target.generation,
          row.owner,
          next?.route ?? null,
          next?.id ?? null,
          page.continuation === null ? null : JSON.stringify(page.continuation),
          next === null,
          position.toString(),
          row.after_id,
          row.continuation === null ? null : JSON.stringify(row.continuation),
          page.epoch ?? null,
        ],
      );
    });
    return false;
  }
  reads.observed(row);
  if (keys.length > 0) checkpoints.observed(row);
  await searchTurnCall(() => projection.project(partition, keys, 0n, true));
  if (keys.length === 0) {
    await checkpoints.save(row, next, position);
    return false;
  }
  await withSearchConnection(pool, async (client) => {
    await client.query(
      `UPDATE search.discovery_population SET after_route=$5,after_id=$6,complete=$7,position=GREATEST(position,$8)
      WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4 AND after_id IS NOT DISTINCT FROM $9::uuid AND NOT complete`,
      [
        partition,
        target.prefix,
        target.generation,
        row.owner,
        next?.route ?? null,
        next?.id ?? null,
        next === null,
        position.toString(),
        row.after_id,
      ],
    );
  });
  return false;
}

/** Validate every indexed identity against current owner truth, not just equal generation counts. */
async function reconcileDiscoveryPage(
  pool: Pool,
  search: OpenSearch,
  projection: DiscoveryProjection,
  row: Population,
  checkCapability: () => Promise<void>,
  indexedReads: ReturnType<typeof discoveryPageReadBatch> | undefined,
  emptyIndexProbe: ReturnType<typeof metadataEmptyIndexProbe>,
  coreReads: ReturnType<typeof coreReconciliationBatch>,
): Promise<boolean> {
  const { registry, target } = projection,
    partition = row.partition;
  if (row.owner === 'collection' || row.owner === 'review' || row.owner === 'space') {
    return reconcileMetadataDiscoveryPage(
      pool,
      search,
      projection,
      row,
      checkCapability,
      indexedReads,
      emptyIndexProbe,
    );
  }
  const entry =
    row.owner === 'accounts' ? registry.get('account') : registry.entries.find((entry) => entry.owner === 'semantic');
  if (!entry || entry.owner !== row.owner) throw new Error('Both native discovery producers are required');
  const census = await searchTurnCall(() => entry.source.count(partition));
  const witness = coreReads
    ? await coreReads.before.read(row)
    : (await searchTurnCall(() => readAccountDiscoveryWitness(pool, [partition]))).get(partition);
  if (!witness) throw new Error('Native Account/claim witness is absent');
  const indexed = BigInt(row.indexed);
  const reset =
    row.reconcile_position === null ||
    BigInt(row.reconcile_position) !== census.position ||
    BigInt(row.revision) !== witness.revision ||
    BigInt(row.claim_revision) !== witness.claimRevision;
  const after = reset ? null : row.after_id;
  const index = discoveryIndexName(target.prefix, target.generation);
  const empty = await coreReads?.indexIsEmpty(row, census.count === 0 && after === null && (reset || indexed === 0n));
  const hits = empty
    ? []
    : await readDiscoveryIndexHits(search, target, {
        size: 100,
        version: true,
        query: { bool: { filter: discoveryIndexTerms(partition, row.owner) } },
        sort: [{ route: 'asc' }, { id: 'asc' }],
        ...(after === null ? {} : { search_after: [row.after_route, after] }),
      });
  const keys: DiscoveryKey[] = hits.map((hit) => {
    const key = parseDiscoveryHitIdentity(registry, hit);
    if ((key.owner !== 'accounts' && key.owner !== 'semantic') || key.owner !== row.owner)
      throw new Error('Discovery reconciliation owner is inconsistent');
    return key;
  });
  let expected: DiscoveryIndexAction[];
  if (!empty) await requireDiscoveryIndexFormat(search, index);
  if (entry.owner === 'accounts') {
    const snapshot = validateAccountSnapshot(
      await searchTurnCall(() =>
        entry.source.read(
          partition,
          keys.map(({ id }) => id),
        ),
      ),
      partition,
      keys.map(({ id }) => id),
      census.position,
    );
    expected = discoveryDocumentActions(registry, { owner: 'accounts', snapshot }, keys, undefined);
  } else {
    const snapshot = await searchTurnCall(() =>
      readCreditIndexSnapshot(
        entry.source,
        partition,
        keys.map(({ id }) => id),
      ),
    );
    validateObservation(
      snapshot,
      partition,
      keys.map(({ id }) => id),
      census.position,
      true,
    );
    const counts = await searchTurnCall(() =>
      projection.listing.read(
        partition,
        snapshot.subjects.map(({ id }) => id),
      ),
    );
    expected = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, keys, counts);
  }
  expected = await prepareBoundedSortKeys(search, index, expected);
  let mismatch = false;
  for (let offset = 0; offset < hits.length; offset++) {
    const hit = hits[offset],
      action = expected[offset];
    if (!record(hit) || !action) throw new Error('Discovery reconciliation identity is missing');
    const current = validateDiscoveryDocument(registry, hit._source);
    if (
      BigInt(current.source_position) > census.position ||
      (current.owner === 'accounts' &&
        action.op === 'index' &&
        action.document.owner === 'accounts' &&
        BigInt(current.revision) > BigInt(action.document.revision))
    )
      throw new Error('Discovery native high water rewound; quarantine this incarnation');
    const withoutPosition = ({ source_position, ...body }: IndexedDiscoveryDocument) => body;
    if (action.op !== 'index' || !isDeepStrictEqual(withoutPosition(current), withoutPosition(action.document)))
      mismatch = true;
  }
  if (mismatch) {
    await searchTurnCall(() => projection.project(partition, keys, 0n, true));
    return false;
  }
  const finish = await searchTurnCall(() => entry.source.count(partition));
  const end = coreReads
    ? await coreReads.after.read(row)
    : (await searchTurnCall(() => readAccountDiscoveryWitness(pool, [partition]))).get(partition);
  const stable =
    finish.position === census.position &&
    finish.count === census.count &&
    end?.epoch === witness.epoch &&
    end.revision === witness.revision &&
    end.claimRevision === witness.claimRevision;
  const total = (reset ? 0n : indexed) + BigInt(hits.length),
    exhausted = hits.length < 100;
  if (!stable) return false;
  if (exhausted && total !== BigInt(census.count)) {
    // A missing identity has no engine key to repair. Rewalk only this native owner/partition.
    await withSearchConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE search.discovery_population SET complete=false,certified=false,after_route=NULL,
        after_id=NULL,reconcile_position=NULL,indexed=0 WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4`,
          [partition, target.prefix, target.generation, row.owner],
        );
        await client.query(
          "UPDATE search.discovery_generation SET state='populating' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='reconciling'",
          [target.prefix, target.generation],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    return false;
  }
  const last = keys.at(-1);
  await withSearchConnection(pool, async (client) => {
    await client.query(
      `UPDATE search.discovery_population SET after_route=$5,after_id=$6,indexed=$7,census=$8,reconcile_position=$9,
      revision=$10,claim_revision=$11,certified=$12 WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4
      AND after_id IS NOT DISTINCT FROM $13::uuid`,
      [
        partition,
        target.prefix,
        target.generation,
        row.owner,
        exhausted ? null : (last?.route ?? null),
        exhausted ? null : (last?.id ?? null),
        total.toString(),
        census.count,
        census.position.toString(),
        witness.revision.toString(),
        witness.claimRevision.toString(),
        exhausted,
        row.after_id,
      ],
    );
  });
  return false;
}

/** Reconcile a metadata producer by current keyed reads; no unavailable census is synthesized. */
async function reconcileMetadataDiscoveryPage(
  pool: Pool,
  search: OpenSearch,
  projection: DiscoveryProjection,
  row: Population,
  checkCapability: () => Promise<void>,
  indexedReads: ReturnType<typeof discoveryPageReadBatch> | undefined,
  emptyIndexProbe: ReturnType<typeof metadataEmptyIndexProbe>,
): Promise<boolean> {
  const { target, registry } = projection;
  const kind = row.owner as DiscoveryMetadataKind;
  const owner = kind === 'collection' ? 'commerce' : 'content';
  const producer = await retainedMetadataProducer(pool, projection, kind);
  if (!producer) return true;
  await checkCapability();
  // Replay the native raw population first: target hits cannot discover a newly eligible identity.
  if (!row.native_complete) {
    const after = row.after_id === null ? null : { route: row.after_route!, id: row.after_id };
    const page = await nativePopulationPage(pool, target, producer, row.partition, after, row.continuation);
    if (!page) return true;
    if (row.native_epoch !== null && page.epoch !== row.native_epoch) {
      await retireDiscoveryCapability(pool, target);
      return true;
    }
    if (row.reconcile_position !== null && BigInt(row.reconcile_position) !== page.position) {
      await restartMetadataReconciliation(pool, target, row.partition, kind);
      return false;
    }
    const actions = projection.prepareOwnerPageActions(kind, row.partition, page);
    if (actions.length > 0) await searchTurnCall(() => projection.applyNativeActions(actions));
    await checkCapability();
    if (page.next === null && (await producer.position(row.partition)) !== page.position) {
      await restartMetadataReconciliation(pool, target, row.partition, kind);
      return false;
    }
    await withSearchConnection(pool, (client) =>
      client.query(
        `UPDATE search.discovery_population SET after_route=$5,after_id=$6,continuation=$7::jsonb,
       native_complete=$8,reconcile_position=$9,native_epoch=$12
       WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4
       AND after_id IS NOT DISTINCT FROM $10::uuid AND continuation IS NOT DISTINCT FROM $11::jsonb`,
        [
          row.partition,
          target.prefix,
          target.generation,
          kind,
          page.next?.route ?? null,
          page.next?.id ?? null,
          page.continuation === null ? null : JSON.stringify(page.continuation),
          page.next === null,
          page.position.toString(),
          row.after_id,
          row.continuation === null ? null : JSON.stringify(row.continuation),
          page.epoch ?? null,
        ],
      ),
    );
    return false;
  }
  const current = await producer.read(row.partition, []);
  if (row.native_epoch !== null && current.epoch !== row.native_epoch) {
    await retireDiscoveryCapability(pool, target);
    return true;
  }
  const after = row.reconcile_position === null ? null : row.after_id;
  const hits = (await emptyIndexProbe?.isEmpty(row))
    ? []
    : await readDiscoveryIndexHits(search, target, {
        size: 100,
        version: true,
        query: { bool: { filter: discoveryIndexTerms(row.partition, owner, kind) } },
        sort: [{ route: 'asc' }, { id: 'asc' }],
        ...(after === null ? {} : { search_after: [row.after_route, after] }),
      });
  // Release populated pages from the empty-page barrier before preparing their writes.
  if (hits.length > 0) indexedReads?.observed(row);
  const keys = hits.map((hit): { route: number; id: string } => {
    if (!record(hit) || typeof hit._id !== 'string' || !record(hit._source))
      throw new GenerationReconciliationMismatch();
    const key = parseDiscoveryDocumentKey(registry, hit._id);
    if (
      key.kind !== kind ||
      key.owner !== owner ||
      partitionOf(key.route) !== row.partition ||
      hit._source.identity !== hit._id ||
      hit._source.kind !== kind ||
      hit._source.owner !== owner ||
      hit._source.id !== key.id ||
      hit._source.route !== key.route ||
      hit._source.partition !== row.partition
    )
      throw new GenerationReconciliationMismatch();
    return { route: key.route, id: key.id };
  });
  const snapshot = await searchTurnCall(() =>
    projection.prepareOwnerActions(
      kind,
      row.partition,
      keys.map(({ id }) => id),
    ),
  );
  if (row.reconcile_position !== null && BigInt(row.reconcile_position) !== snapshot.position) {
    await restartMetadataReconciliation(pool, target, row.partition, kind);
    return false;
  }
  // Empty cleanup still checks the physical target under the same generation lock.
  if (snapshot.actions.length === 0) {
    if (indexedReads && emptyIndexedMetadataCandidate(row)) {
      indexedReads.observed(row);
      await indexedReads.checkEmptyPage();
    } else await withDiscoveryTarget(pool, search, target, async () => {});
  } else await searchTurnCall(() => projection.applyNativeActions(snapshot.actions));
  await checkCapability();
  const exhausted = hits.length < 100;
  const finalPosition = exhausted
    ? await searchTurnCall(() => projection.ownerPosition(kind, row.partition))
    : snapshot.position;
  if (finalPosition !== snapshot.position) {
    await restartMetadataReconciliation(pool, target, row.partition, kind);
    return false;
  }
  const last = keys.at(-1);
  await withSearchConnection(pool, (client) =>
    client.query(
      `UPDATE search.discovery_population SET after_route=$5,after_id=$6,indexed=$7,census=$7,
      reconcile_position=$8,certified=$9 WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner=$4
      AND after_id IS NOT DISTINCT FROM $10::uuid AND reconcile_position IS NOT DISTINCT FROM $11::bigint`,
      [
        row.partition,
        target.prefix,
        target.generation,
        kind,
        exhausted ? null : (last?.route ?? null),
        exhausted ? null : (last?.id ?? null),
        (BigInt(row.indexed) + BigInt(hits.length)).toString(),
        snapshot.position.toString(),
        exhausted,
        row.after_id,
        row.reconcile_position,
      ],
    ),
  );
  return false;
}

function emptyIndexedMetadataCandidate(row: Population) {
  return (
    (row.owner === 'collection' || row.owner === 'review' || row.owner === 'space') &&
    row.native_complete &&
    row.after_id === null &&
    row.reconcile_position !== null
  );
}

function discoveryIndexTerms(partition: number, owner: string, kind?: DiscoveryMetadataKind) {
  return [{ term: { partition } }, { term: { owner } }, ...(kind ? [{ term: { kind } }] : [])];
}

async function readDiscoveryIndexHits(
  search: OpenSearch,
  target: DiscoveryTarget,
  body: Readonly<Record<string, unknown> & { size: number }>,
) {
  const result = await search.request<unknown>(
    'POST',
    `/${discoveryIndexName(target.prefix, target.generation)}/_search`,
    body,
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(result.body);
  if (!record(result.body) || !record(result.body.hits) || !Array.isArray(result.body.hits.hits))
    throw new TypeError('Invalid Discovery reconciliation page');
  const hits: unknown[] = result.body.hits.hits;
  if (hits.length > body.size) throw new RangeError('Discovery reconciliation exceeded its page bound');
  return hits;
}

async function discoveryScopesEmpty(
  search: OpenSearch,
  target: DiscoveryTarget,
  scopes: readonly ReturnType<typeof discoveryIndexTerms>[],
) {
  // A complete empty union proves absence in every exact scope. Any hit keeps the keyed path.
  const hits = await readDiscoveryIndexHits(search, target, {
    size: 1,
    _source: false,
    query: { bool: { should: scopes.map((filter) => ({ bool: { filter } })), minimum_should_match: 1 } },
  });
  return hits.length === 0;
}

function coreReconciliationBatch(
  pool: Pool,
  search: OpenSearch,
  target: DiscoveryTarget,
  batch: readonly Population[],
) {
  const rows = batch.filter((row) => row.owner === 'accounts' || row.owner === 'semantic');
  if (rows.length < 2) return undefined;
  function witnessBatch() {
    const partitions = new Set<number>();
    const reads = discoveryPageReadBatch(rows, () =>
      searchTurnCall(() => readAccountDiscoveryWitness(pool, [...partitions])),
    );
    return {
      observed: reads.observed,
      async read(row: Population) {
        partitions.add(row.partition);
        reads.observed(row);
        return (await reads.checkEmptyPage()).get(row.partition);
      },
    };
  }
  const before = witnessBatch();
  const after = witnessBatch();
  const scopes: ReturnType<typeof discoveryIndexTerms>[] = [];
  const probe = discoveryPageReadBatch(rows, async () => {
    if (scopes.length < 2) return false;
    return withDiscoveryTarget(pool, search, target, async (_client, index) => {
      const empty = await discoveryScopesEmpty(search, target, scopes);
      if (empty) await requireDiscoveryIndexFormat(search, index);
      return empty;
    });
  });
  return {
    before,
    after,
    observed(row: Population) {
      before.observed(row);
      probe.observed(row);
      after.observed(row);
    },
    async indexIsEmpty(row: Population, candidate: boolean) {
      if (candidate) scopes.push(discoveryIndexTerms(row.partition, row.owner));
      probe.observed(row);
      return candidate && (await probe.checkEmptyPage());
    },
  };
}

function metadataEmptyIndexProbe(search: OpenSearch, target: DiscoveryTarget, batch: readonly Population[]) {
  const candidates = new Set(
    batch.filter((row) => emptyIndexedMetadataCandidate(row) && row.reconcile_position === '0' && row.indexed === '0'),
  );
  if (candidates.size < 2) return undefined;
  const scopes = [...candidates].map((row) =>
    discoveryIndexTerms(
      row.partition,
      row.owner === 'collection' ? 'commerce' : 'content',
      row.owner as DiscoveryMetadataKind,
    ),
  );
  const reads = discoveryPageReadBatch([...candidates], () => discoveryScopesEmpty(search, target, scopes));
  return {
    observed: reads.observed,
    async isEmpty(row: Population) {
      if (!candidates.has(row)) return false;
      reads.observed(row);
      return reads.checkEmptyPage();
    },
  };
}

async function retireDiscoveryCapability(pool: Pool, target: DiscoveryTarget) {
  const index = discoveryIndexName(target.prefix, target.generation);
  await withSearchConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [index]);
      await client.query(
        `UPDATE search.discovery_generation SET state='retiring' WHERE partition_no=0 AND prefix=$1 AND generation=$2
       AND index_uuid=$3 AND incarnation=$4::uuid AND state NOT IN ('active','retired','quarantined')`,
        [target.prefix, target.generation, target.uuid, target.incarnation],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** An allocated owner later omitted as preparing/unavailable retires this generation; it must not loop as unsupported. */
async function retainedMetadataProducer(
  pool: Pool,
  projection: DiscoveryProjection,
  kind: DiscoveryMetadataKind,
): Promise<DiscoveryMetadataProducer | null> {
  const producer = projection.metadataProducers[kind];
  if (producer) return producer;
  await retireDiscoveryCapability(pool, projection.target);
  return null;
}

async function nativePopulationPage(
  pool: Pool,
  target: DiscoveryTarget,
  producer: DiscoveryMetadataProducer,
  partition: number,
  after: Readonly<{ route: number; id: string }> | null,
  continuation: string | null,
) {
  try {
    return await producer.page(partition, after, continuation, 100);
  } catch (error) {
    if (!(error instanceof DiscoveryPopulationCutChangedError)) throw error;
    await retireDiscoveryCapability(pool, target);
    return null;
  }
}

async function restartMetadataReconciliation(pool: Pool, target: DiscoveryTarget, partition: number, kind: string) {
  await withSearchConnection(pool, (client) =>
    client.query(
      `UPDATE search.discovery_population SET certified=false,native_complete=false,after_route=NULL,after_id=NULL,
     continuation=NULL,reconcile_position=NULL,indexed=0 WHERE prefix=$1 AND generation=$2 AND partition_no=$3 AND owner=$4`,
      [target.prefix, target.generation, partition, kind],
    ),
  );
}

async function discoveryAliasMatches(search: OpenSearch, target: DiscoveryTarget): Promise<boolean> {
  let response: { status: number; body: unknown };
  try {
    response = await search.request('GET', `/_alias/${discoveryAlias(target.prefix)}`);
  } catch (error) {
    if (error instanceof OpenSearchError && error.status === 404) return false;
    throw error;
  }
  if (response.status === 404) return false;
  if (response.status !== 200 || !record(response.body))
    throw new SearchUnavailableError('Discovery activation alias is unavailable');
  return (
    Object.keys(response.body).length === 1 &&
    Object.hasOwn(response.body, discoveryIndexName(target.prefix, target.generation)) &&
    (await discoveryPhysicalTargetMatches(search, target))
  );
}

/** Finish only an observed activation of this durable ready target; a lost COMMIT is reread next turn. */
async function completeDiscoveryActivation(
  pool: Pool,
  target: DiscoveryGeneration,
  previous: DiscoveryGeneration | undefined,
) {
  if (!target.capability || !discoveryCapabilityMatches(target, target.capability, target.capability.witnesses))
    throw new SearchUnavailableError('Discovery activation capability is unavailable');
  await withSearchConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      if (previous)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          discoveryIndexName(target.prefix, previous.generation),
        ]);
      const ready = await client.query<{ state: string }>(
        `SELECT state FROM search.discovery_generation
         WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND index_uuid=$3 AND incarnation=$4::uuid
           AND state IN ('ready','active') AND capability=$5::jsonb FOR UPDATE`,
        [target.prefix, target.generation, target.uuid, target.incarnation, JSON.stringify(target.capability)],
      );
      if (ready.rows[0]?.state === 'active') {
        await client.query('COMMIT');
        return;
      }
      if (ready.rows[0]?.state !== 'ready') throw new SearchUnavailableError('Discovery activation target changed');
      await client.query(
        "UPDATE search.discovery_generation SET state='retiring' WHERE partition_no=0 AND prefix=$1 AND state='active' AND generation<>$2",
        [target.prefix, target.generation],
      );
      await client.query(
        `UPDATE search.discovery_generation SET state='active',activated_at=clock_timestamp()
         WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='ready'
           AND index_uuid=$3 AND incarnation=$4::uuid`,
        [target.prefix, target.generation, target.uuid, target.incarnation],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

type AdvanceDiscoveryOptions = SearchTurnContext & {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  registry: DiscoveryRegistry;
  listing: SubjectListingSource;
  requiredKinds?: readonly string[];
  metadataProducers?: DiscoveryMetadataProducers;
  capabilityWitnesses?: DiscoveryCapabilityWitnesses;
};

/** One bounded maintenance step; failed external work leaves its actual frontier replayable. */
export async function advanceDiscovery(options: AdvanceDiscoveryOptions): Promise<void> {
  const context = options.deadline === undefined && options.signal === undefined ? undefined : options;
  return withSearchTurn(context, (turn) => advanceDiscoveryTurn({ ...options, search: turn.search(options.search) }));
}

async function advanceDiscoveryTurn(options: AdvanceDiscoveryOptions): Promise<void> {
  const { pool, search, prefix, registry } = options;
  const metadataProducers = searchTurnMetadataProducers(options.metadataProducers ?? {}, 'population');
  const requiredKinds = options.requiredKinds ?? Object.keys(metadataProducers);
  const witnesses = options.capabilityWitnesses ?? (await discoveryCapabilityWitnesses(metadataProducers));
  const producerKinds = ['account', 'subject'];
  for (const kind of SECOND_SCOPE_PUBLIC_METADATA_KINDS) {
    const producer = metadataProducers[kind];
    if (producer) producerKinds.push(kind);
  }
  assertDiscoveryProducerCoverage(discoveryProducerRegistrations(registry), requiredKinds, producerKinds);
  let generations = await discoveryGenerations(pool, prefix);
  const kinds = registry.entries.map(({ kind }) => kind).sort();
  const active = generations.find((row) => row.state === 'active');
  for (const ready of generations) {
    if (ready.state === 'ready' && (await discoveryAliasMatches(search, ready))) {
      // The alias may have committed after the previous turn lost its response. Preserve the
      // already published copy before evaluating whether today's registry needs a successor.
      await completeDiscoveryActivation(pool, ready, active);
      return;
    }
  }
  const activePhysicalTargetMatches = active ? await discoveryPhysicalTargetMatches(search, active) : true;
  let activeCoverageComplete =
    !active || (activePhysicalTargetMatches && discoveryCapabilityMatches(active, active.capability, witnesses));
  if (active && requiredKinds.length > 0) {
    const coverage = await withSearchConnection(
      pool,
      async (client) =>
        (
          await client.query<{ owner: string; complete: boolean; partitions: string }>(
            `SELECT owner,bool_and(complete AND certified) AS complete,count(*)::text AS partitions
          FROM search.discovery_population WHERE prefix=$1 AND generation=$2 AND owner=ANY($3::text[]) GROUP BY owner`,
            [prefix, active.generation, requiredKinds],
          )
        ).rows,
    );
    const byOwner = new Map(coverage.map((row) => [row.owner, row]));
    activeCoverageComplete &&= requiredKinds.every((kind) => {
      const owner = byOwner.get(kind);
      return owner?.complete === true && Number(owner.partitions) === PARTITIONS;
    });
  }
  let retiredCapturedTarget = false;
  for (const candidate of generations) {
    if (!candidate.uuid || ['active', 'allocated', 'retiring', 'retired', 'quarantined'].includes(candidate.state))
      continue;
    if (!(await discoveryPhysicalTargetMatches(search, candidate))) {
      await retireDiscoveryCapability(pool, candidate);
      retiredCapturedTarget = true;
    }
  }
  if (retiredCapturedTarget) return;
  if (
    generations.length === 0 ||
    generations.every((row) => ['retiring', 'quarantined'].includes(row.state)) ||
    (generations.every((row) => ['active', 'retiring', 'quarantined'].includes(row.state)) &&
      generations.some(
        (row) => row.state === 'active' && (!isDeepStrictEqual(row.kinds, kinds) || !activeCoverageComplete),
      ))
  ) {
    // Let the runner drain abandoned physical targets before consuming another live slot.
    if (generations.length >= MAX_SUBJECT_GENERATIONS) return;
    await allocateDiscovery(pool, prefix, registry, requiredKinds, producerKinds);
    generations = await discoveryGenerations(pool, prefix);
  }
  const target = generations.find((row) => !['active', 'retiring', 'quarantined'].includes(row.state));
  if (!target) return;
  if (!isDeepStrictEqual(target.kinds, registry.entries.map(({ kind }) => kind).sort()))
    throw new Error('Discovery registry changed during population');
  const index = discoveryIndexName(prefix, target.generation);
  if (target.state === 'allocated') {
    let allocationFailure: unknown;
    try {
      await createDiscoveryIndex(search, prefix, target.generation, target.incarnation);
    } catch (error) {
      allocationFailure = error;
    }
    // A lost allocation response is recovered from one exact physical observation. Expiry leaves
    // the durable allocated row for a later turn; it cannot bind an unobserved UUID or incarnation.
    const physical = await readDiscoveryPhysicalIdentity(search, index);
    if (!physical || physical.incarnation !== target.incarnation)
      throw allocationFailure ?? new SearchUnavailableError('Discovery allocation identity is unavailable');
    const uuid = physical.uuid;
    await withSearchConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET index_uuid=$3,capability=$4::jsonb,state='populating' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='allocated' AND incarnation=$5::uuid",
        [
          prefix,
          target.generation,
          uuid,
          JSON.stringify({ physicalTarget: index, uuid, incarnation: target.incarnation, witnesses }),
          target.incarnation,
        ],
      ),
    );
    return;
  }
  if (!discoveryCapabilityMatches(target, target.capability, witnesses)) {
    await retireDiscoveryCapability(pool, target);
    return;
  }
  const projection = createDiscoveryProjection({ ...options, target, metadataProducers });
  if (target.state === 'populating' || target.state === 'reconciling') {
    const populations = await withSearchConnection(
      pool,
      async (client) =>
        (
          await client.query<Population>(
            `SELECT partition_no AS partition,owner,after_route,after_id::text,continuation #>> '{}' AS continuation,position::text,
      revision::text,claim_revision::text,indexed::text,census::text,reconcile_position::text,native_complete,native_epoch FROM search.discovery_population
      WHERE prefix=$1 AND generation=$2 AND ${target.state === 'populating' ? 'NOT complete' : 'NOT certified'} ORDER BY partition_no,owner LIMIT $3`,
            [prefix, target.generation, DISCOVERY_POPULATIONS_PER_ADVANCE],
          )
        ).rows,
    );
    if (populations.length > 0) {
      let retiring: Promise<void> | undefined;
      const checkCapability = discoveryPageCapabilityCheck(pool, projection);
      await mapBounded(
        populations,
        Math.min(DISCOVERY_POPULATION_CONCURRENCY, Math.max(1, (pool.options.max ?? 10) - 1)),
        (batch) => {
          const reads = target.state === 'populating' ? discoveryPageReadBatch(batch, checkCapability) : undefined;
          const checkpoints = reads ? populationCheckpointBatch(pool, target, batch) : undefined;
          const indexedReads =
            target.state === 'reconciling'
              ? discoveryPageReadBatch(batch.filter(emptyIndexedMetadataCandidate), () =>
                  withDiscoveryTarget(pool, search, target, async () => {}),
                )
              : undefined;
          const emptyIndexProbe =
            target.state === 'reconciling' ? metadataEmptyIndexProbe(search, target, batch) : undefined;
          const coreReads =
            target.state === 'reconciling' ? coreReconciliationBatch(pool, search, target, batch) : undefined;
          return async (population) => {
            try {
              return await searchTurnCall(() =>
                reads && checkpoints
                  ? populationPage(pool, projection, population, checkCapability, reads, checkpoints)
                  : reconcileDiscoveryPage(
                      pool,
                      search,
                      projection,
                      population,
                      checkCapability,
                      indexedReads,
                      emptyIndexProbe,
                      coreReads,
                    ),
              );
            } catch (error) {
              if (!(error instanceof DiscoveryPhysicalTargetChangedError)) throw error;
              retiring ??= retireDiscoveryCapability(pool, target);
              await retiring;
              return true;
            } finally {
              reads?.observed(population);
              checkpoints?.observed(population);
              indexedReads?.observed(population);
              emptyIndexProbe?.observed(population);
              coreReads?.observed(population);
            }
          };
        },
        (retired) => retired,
      );
      return;
    }
  }
  if (target.state === 'populating') {
    await withSearchConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET state='replaying' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='populating'",
        [prefix, target.generation],
      ),
    );
    return;
  }
  const replay = await withSearchConnection(pool, (client) =>
    freshness.run(client, { consumer: discoveryConsumer(prefix, target.generation) }),
  );
  if (!replay || (replay.behind > 0 && replay.oldest === null))
    throw new SearchUnavailableError('Discovery replay freshness is unavailable');
  if (replay.behind > 0) return;
  if (target.state === 'replaying') {
    await withSearchConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET state='reconciling' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='replaying'",
        [prefix, target.generation],
      ),
    );
    return;
  }
  // A native write after a partition was certified invalidates that partition, including empty populations.
  const observations = await withSearchConnection(
    pool,
    async (client) =>
      (
        await client.query<{
          partition: number;
          position: string;
          revision: string;
          claim_revision: string;
          head: string;
          semantic_position: string;
          collection_position: string | null;
          collection_epoch: number | null;
          review_position: string | null;
          space_position: string | null;
        }>(
          `SELECT p.partition_no AS partition,p.reconcile_position::text AS position,p.revision::text,p.claim_revision::text,
          c.position::text AS head,s.reconcile_position::text AS semantic_position,
          collection.reconcile_position::text AS collection_position,collection.native_epoch AS collection_epoch,review.reconcile_position::text AS review_position,
          space.reconcile_position::text AS space_position
     FROM search.discovery_population p JOIN core.partition c ON c.partition_no=p.partition_no
     JOIN search.discovery_population s ON s.partition_no=p.partition_no AND s.prefix=p.prefix AND s.generation=p.generation AND s.owner='semantic' 
     LEFT JOIN search.discovery_population collection ON collection.partition_no=p.partition_no AND collection.prefix=p.prefix AND collection.generation=p.generation AND collection.owner='collection'
     LEFT JOIN search.discovery_population review ON review.partition_no=p.partition_no AND review.prefix=p.prefix AND review.generation=p.generation AND review.owner='review'
     LEFT JOIN search.discovery_population space ON space.partition_no=p.partition_no AND space.prefix=p.prefix AND space.generation=p.generation AND space.owner='space'
     WHERE p.prefix=$1 AND p.generation=$2 AND p.owner='accounts' ORDER BY p.partition_no`,
          [prefix, target.generation],
        )
      ).rows,
  );
  if (observations.length !== 4096) throw new Error('Discovery population partitions are incomplete');
  const readReviewPositions = requiredKinds.includes('review')
    ? metadataProducers.review?.readEmptyPositions
    : undefined;
  for (let offset = 0; offset < observations.length; offset += 100) {
    const chunk = observations.slice(offset, offset + 100);
    const witnesses = await searchTurnCall(() =>
      readAccountDiscoveryWitness(
        pool,
        chunk.map(({ partition }) => partition),
      ),
    );
    const checks = await mapBounded(
      chunk,
      Math.min(DISCOVERY_CERTIFICATION_CONCURRENCY, Math.max(1, (pool.options.max ?? 10) - 1)),
      (batch) => {
        const review = readReviewPositions && reviewCertificationBatch(batch, readReviewPositions);
        return (row) =>
          searchTurnCall(async () => {
            const witness = witnesses.get(row.partition);
            const metadataPositions = {
              collection: row.collection_position,
              review: row.review_position,
              space: row.space_position,
            };
            for (const kind of SECOND_SCOPE_PUBLIC_METADATA_KINDS) {
              if (!requiredKinds.includes(kind)) continue;
              const observation: { position: bigint; epoch?: number } =
                kind === 'review' && review
                  ? { position: await review.position(row) }
                  : await metadataProducers[kind]!.read(row.partition, []);
              if (kind === 'collection' && row.collection_epoch !== null && observation.epoch !== row.collection_epoch)
                return { state: 'retire' as const };
              if (metadataPositions[kind] !== observation.position.toString())
                return { state: 'metadata' as const, partition: row.partition, kind };
            }
            return row.position === row.head &&
              row.semantic_position === row.head &&
              witness?.revision === BigInt(row.revision) &&
              witness.claimRevision === BigInt(row.claim_revision)
              ? { state: 'current' as const }
              : { state: 'native' as const, partition: row.partition };
          }).finally(() => review?.observed(row));
      },
    );
    for (const check of checks) {
      if (check.state === 'retire') {
        await retireDiscoveryCapability(pool, target);
        return;
      }
      if (check.state === 'metadata') {
        await restartMetadataReconciliation(pool, target, check.partition, check.kind);
        await withSearchConnection(pool, (client) =>
          client.query(
            "UPDATE search.discovery_generation SET state='reconciling' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='ready'",
            [prefix, target.generation],
          ),
        );
        return;
      }
      if (check.state === 'current') continue;
      await withSearchConnection(pool, (client) =>
        client.query(
          `UPDATE search.discovery_population SET certified=false,after_route=NULL,after_id=NULL,reconcile_position=NULL,indexed=0
        WHERE prefix=$1 AND generation=$2 AND partition_no=$3 AND owner IN ('accounts','semantic')`,
          [prefix, target.generation, check.partition],
        ),
      );
      await withSearchConnection(pool, (client) =>
        client.query(
          "UPDATE search.discovery_generation SET state='reconciling' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='ready'",
          [prefix, target.generation],
        ),
      );
      return;
    }
  }
  if (!(await discoveryPhysicalTargetMatches(search, target))) {
    await retireDiscoveryCapability(pool, target);
    return;
  }
  await assertDiscoveryCapabilityBinding(pool, target, metadataProducers);
  const previous = generations.find((row) => row.state === 'active');
  await withSearchConnection(pool, async (client) => {
    const ready = await client.query(
      `UPDATE search.discovery_generation SET state='ready'
       WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state IN ('reconciling','ready')
         AND index_uuid=$3 AND incarnation=$4::uuid RETURNING generation`,
      [prefix, target.generation, target.uuid, target.incarnation],
    );
    if (ready.rowCount !== 1) throw new SearchUnavailableError('Discovery activation target changed');
  });
  if (!(await discoveryAliasMatches(search, target))) {
    await observedWrite(
      () =>
        search.request('POST', '/_aliases', {
          actions: [
            ...(previous
              ? [{ remove: { index: discoveryIndexName(prefix, previous.generation), alias: discoveryAlias(prefix) } }]
              : []),
            { add: { index, alias: discoveryAlias(prefix) } },
          ],
        }),
      () => discoveryAliasMatches(search, target),
      'Discovery activation could not be established',
    );
  }
  await completeDiscoveryActivation(pool, target, previous);
}

/** Shared native keyed observations for publication; no census or prepared output is completeness evidence. */
export async function nativeGenerationActions(options: {
  pool: Pool;
  search: OpenSearch;
  index: string;
  partition: number;
  ids: readonly string[];
  obligation: bigint;
  registry?: DiscoveryRegistry;
  keys?: readonly DiscoveryKey[];
}): Promise<readonly (DiscoveryIndexAction | IndexAction<SubjectDocument>)[]> {
  const { pool, search, index, partition, ids, obligation, registry } = options;
  if (ids.length > 100) throw new RangeError('Generation reconciliation accepts at most 100 native keys');
  const listing = subjectListingSource(pool);
  if (!registry) {
    const source = subjectSource(pool);
    await readSubjectCalendarMappingFormatForIndex(search, index);
    await readSubjectCreditMappingFormatForIndex(search, index);
    const snapshot = await readCreditIndexSnapshot(source, partition, ids);
    validateObservation(snapshot, partition, ids, obligation, true);
    // The supplied native writer owns factual projection, foreign fences and rating decoration.
    // This raw native observation supplies eligibility, key identity and external versions only.
    return documentActions(snapshot, ids);
  }
  const keys = options.keys;
  if (!keys || keys.length !== ids.length) throw new TypeError('Native discovery keys are required');
  await requireDiscoveryIndexFormat(search, index);
  const account = keys[0]?.owner === 'accounts';
  if (keys.some((key) => (key.owner === 'accounts') !== account)) throw new TypeError('Mixed owner key batch');
  let actions: DiscoveryIndexAction[];
  if (account) {
    const entry = registry.get('account');
    if (entry.owner !== 'accounts') throw new TypeError('Native Account producer is required');
    const snapshot = validateAccountSnapshot(await entry.source.read(partition, ids), partition, ids, obligation);
    actions = discoveryDocumentActions(registry, { owner: 'accounts', snapshot }, keys, undefined);
  } else {
    const entry = registry.entries.find((entry) => entry.owner === 'semantic');
    if (!entry || entry.owner !== 'semantic') throw new TypeError('Native Subject producer is required');
    const observed = await readCreditIndexSnapshot(entry.source, partition, ids);
    validateObservation(observed, partition, ids, obligation, true);
    // A type change removes the old kind-key; native key enumeration separately supplies the new kind-key.
    const kind = new Map(keys.map((key) => [key.id, key.kind]));
    const snapshot = { ...observed, subjects: observed.subjects.filter((row) => kind.get(row.id) === row.type) };
    const counts = await listing.read(
      partition,
      snapshot.subjects.map(({ id }) => id),
    );
    actions = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, keys, counts);
    const semantic = actions.filter(
      (
        action,
      ): action is Extract<DiscoveryIndexAction, { op: 'index' }> & {
        document: SubjectDocument & IndexedDiscoveryDocument;
      } => action.op === 'index' && action.document.owner === 'semantic',
    );
    const prepared = await prepareBoundedSortKeys(search, index, semantic);
    const byId = new Map(prepared.map((action) => [action.id, action]));
    actions = actions.map((action) => byId.get(action.id) ?? action);
  }
  return actions;
}

export class GenerationReconciliationMismatch extends Error {
  constructor() {
    super('Native generation keys or external versions do not match');
  }
}

/** Search-visible keyed evidence shared by ordinary and mixed physical generations.
 * Ordinary bodies belong to the supplied native writer (including foreign fences and rating decoration);
 * native mixed producers additionally provide their exact full projection for comparison here.
 */
export async function assertNativeGenerationActionsVisible(
  search: OpenSearch,
  index: string,
  actions: readonly (DiscoveryIndexAction | IndexAction<SubjectDocument>)[],
): Promise<number> {
  if (actions.length > 100) throw new RangeError('Native reconciliation accepts at most 100 keyed actions');
  if (!actions.length) return 0;
  const response = await search.request<unknown>(
    'POST',
    `/${index}/_search`,
    {
      size: actions.length,
      version: true,
      track_total_hits: false,
      query: { ids: { values: actions.map(({ id }) => id) } },
    },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(response.body);
  if (
    response.status !== 200 ||
    !record(response.body) ||
    !record(response.body.hits) ||
    !Array.isArray(response.body.hits.hits) ||
    response.body.hits.hits.length > actions.length
  )
    throw new GenerationReconciliationMismatch();
  const hits = new Map<string, Record<string, unknown>>();
  for (const hit of response.body.hits.hits) {
    if (!record(hit) || hit._index !== index || typeof hit._id !== 'string' || hits.has(hit._id))
      throw new GenerationReconciliationMismatch();
    hits.set(hit._id, hit);
  }
  for (const action of actions) {
    const hit = hits.get(action.id);
    if (action.op === 'delete') {
      if (hit) throw new GenerationReconciliationMismatch();
    } else if (
      !hit ||
      String(hit._version) !== action.version.toString() ||
      !nativeGenerationDocumentMatches(hit._source, action.document)
    ) {
      const actual = record(hit?._source) ? hit._source : {};
      const expected = action.document as Record<string, unknown>;
      const fields = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
      console.warn('Search publication projection trace', {
        hit: Boolean(hit),
        actualVersion: hit?._version,
        expectedVersion: action.version.toString(),
        fields: fields.filter((field) => !isDeepStrictEqual(actual[field], expected[field])),
      });
      throw new GenerationReconciliationMismatch();
    }
    hits.delete(action.id);
  }
  if (hits.size) throw new GenerationReconciliationMismatch();
  return response.body.hits.hits.length;
}

function nativeGenerationDocumentMatches(
  actual: unknown,
  expected: SubjectDocument | IndexedDiscoveryDocument | DiscoveryDocumentValue,
): boolean {
  return isDeepStrictEqual(actual, expected);
}
