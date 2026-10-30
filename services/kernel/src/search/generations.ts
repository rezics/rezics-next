import type { Pool } from 'pg';
import { discardConnection } from '../database/pool.ts';
import {
  createSubjectIndex,
  MAX_SUBJECT_GENERATIONS,
  readSubjectSortFormat,
  SUBJECT_SORT_FORMAT,
  subjectAlias,
  subjectGenerations,
  subjectIndexName,
} from './indices.ts';
import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { readFreshness } from './freshness.ts';
import reconcile from './reconcile.sql';
import lockRebuild from './rebuild-lock.sql';
import unlockRebuild from './rebuild-unlock.sql';
import type { SubjectSource } from './source.ts';
import { subjectConsumer } from './runner.ts';

export { MAX_SUBJECT_GENERATIONS } from './indices.ts';
export type RebuildReason = 'timeout' | 'mismatch' | 'busy' | 'running' | 'limit';
export type PartitionCount = { partition: number; indexed: number; source: number };

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
  pool: Pool,
  consumer: string,
): Promise<Map<number, { head: bigint; checkpoint: bigint }>> {
  const rows = (await reconcile.run(pool, { consumer })) as ReconcileRow[];
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

async function sourceCounts(source: SubjectSource, partitions: number[]): Promise<Map<number, CountSnapshot>> {
  const counts = new Map<number, CountSnapshot>();
  for (let offset = 0; offset < partitions.length; offset += 8) {
    const batch = partitions.slice(offset, offset + 8);
    // Drain every dispatched observation even when one receipt is invalid.
    const values = await Promise.allSettled(
      batch.map(async (partition) => [partition, countSnapshot(await source.count(partition))] as const),
    );
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

/** A write is never retried: only a fresh bounded native observation can resolve its effect. */
async function observedWrite(
  write: () => Promise<unknown>,
  observe: () => Promise<boolean>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    const response = await write();
    if (
      !record(response) ||
      response.status !== 200 ||
      !record(response.body) ||
      response.body.acknowledged !== true ||
      Object.hasOwn(response.body, 'error')
    )
      failure = new SearchUnavailableError(message);
  } catch (error) {
    failure = error;
  }
  try {
    if (await observe()) return;
  } catch (error) {
    failure = error;
  }
  throw new SearchUnavailableError(message, { cause: failure });
}

export async function rebuildSubjects(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  prefix: string;
  runner: { refresh(): Promise<void> };
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

  const lock = subjectAlias(options.prefix);
  const client = await options.pool.connect();
  let locked = false;
  let discard: Error | undefined;
  try {
    const row = (await lockRebuild.run(client, { alias: lock })) as { locked: boolean | null };
    locked = row.locked === true;
  } catch (error) {
    discard = error instanceof Error ? error : new Error(String(error));
    discardConnection(client, discard);
    client.release(discard);
    throw error;
  }
  if (!locked) {
    client.release();
    const state = await subjectGenerations(options.search, options.prefix);
    throw new RebuildError('running', state.generations.at(-1) ?? 1);
  }
  try {
    const state = await subjectGenerations(options.search, options.prefix);
    const previous = state.active;
    const highest = state.generations.at(-1) ?? 0;
    // Advanced checkpoints on an old-format index cannot replay already consumed names.
    // Only a generation created with the bounded writer format is safe to resume.
    const resumable =
      highest > (previous ?? 0) &&
      (await readSubjectSortFormat(options.search, options.prefix, highest)) === SUBJECT_SORT_FORMAT;
    const generation = resumable ? highest : highest + 1;
    if (generation > highest && state.generations.length >= MAX_SUBJECT_GENERATIONS)
      throw new RebuildError('limit', generation);
    await createSubjectIndex(options.search, options.prefix, generation);
    const format = await readSubjectSortFormat(options.search, options.prefix, generation);
    if (format !== SUBJECT_SORT_FORMAT)
      throw new SearchUnavailableError('Search rebuild requires a new bounded-format generation');
    await options.runner.refresh();

    const consumer = subjectConsumer(options.prefix, generation);
    const deadline = Date.now() + timeoutMs;
    while ((await readFreshness(options.pool, consumer)).behind > 0) {
      if (Date.now() >= deadline) throw new RebuildError('timeout', generation);
      await sleep(pollMs);
    }

    const index = subjectIndexName(options.prefix, generation);
    let pending = new Map<number, { head: bigint; checkpoint: bigint }>();
    let lastCounts = new Map<number, PartitionCount>();
    const mismatches = new Map<number, PartitionCount>();
    for (let round = 0; round < rounds; round += 1) {
      const before = await readPartitions(options.pool, consumer);
      const source = await sourceCounts(options.source, [...before.keys()]);
      const indexed = await indexCounts(options.search, index);
      const after = await readPartitions(options.pool, consumer);
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
      if (mismatches.size > 0) {
        throw new RebuildError(
          'mismatch',
          generation,
          [...mismatches.values()].sort((a, b) => a.partition - b.partition),
        );
      }
      if (pending.size === 0) break;
      if (round + 1 < rounds) await sleep(pollMs);
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

    const activatedAt = new Date().toISOString();
    await observedWrite(
      () =>
        options.search.request('PUT', `/${index}/_mapping`, {
          _meta: { name_sort_format: format, activated_at: activatedAt },
        }),
      async () => {
        const response = await options.search.request<unknown>('GET', `/${index}/_mapping`);
        if (!record(response) || response.status !== 200 || !record(response.body)) return false;
        const names = Object.keys(response.body);
        if (names.length !== 1 || names[0] !== index) return false;
        const entry = response.body[index];
        if (!record(entry) || !record(entry.mappings) || !record(entry.mappings.properties)) return false;
        const meta = entry.mappings._meta;
        return record(meta) && meta.name_sort_format === format && meta.activated_at === activatedAt;
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
      () => options.search.request('POST', '/_aliases', { actions }),
      async () => {
        const final = await subjectGenerations(options.search, options.prefix);
        return final.active === generation && final.generations.includes(generation);
      },
      'Search generation alias activation could not be established',
    );
    return { generation, previous };
  } finally {
    try {
      const row = (await unlockRebuild.run(client, { alias: lock })) as { unlocked: boolean | null };
      if (row.unlocked !== true) throw new Error('Search rebuild advisory lock was not held');
    } catch (error) {
      discard = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (discard) discardConnection(client, discard);
      client.release(discard);
    }
  }
}
