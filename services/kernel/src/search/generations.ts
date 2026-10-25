import type { Pool } from 'pg';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from './indices.ts';
import type { OpenSearch } from './opensearch.ts';
import { readFreshness } from './freshness.ts';
import reconcile from './reconcile.sql';
import type { SubjectSource } from './source.ts';
import { subjectConsumer } from './runner.ts';

export type RebuildReason = 'timeout' | 'mismatch' | 'busy';
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
type AggregationResponse = {
  aggregations?: { partitions?: { buckets?: { key: number; doc_count: number }[] } };
};

const activeRebuilds = new Set<string>();
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const numeric = (value: string | bigint): bigint => BigInt(value);

async function readPartitions(
  pool: Pool,
  consumer: string,
): Promise<Map<number, { head: bigint; checkpoint: bigint }>> {
  const rows = (await reconcile.run(pool, { consumer })) as ReconcileRow[];
  return new Map(rows.map((row) => [row.partition, { head: numeric(row.head), checkpoint: numeric(row.checkpoint) }]));
}

async function sourceCounts(source: SubjectSource, partitions: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (let offset = 0; offset < partitions.length; offset += 8) {
    const batch = partitions.slice(offset, offset + 8);
    const values = await Promise.all(
      batch.map(async (partition) => [partition, (await source.count(partition)).count] as const),
    );
    for (const [partition, count] of values) counts.set(partition, count);
  }
  return counts;
}

async function indexCounts(search: OpenSearch, index: string): Promise<Map<number, number>> {
  const response = await search.request<AggregationResponse>('POST', `/${index}/_search`, {
    size: 0,
    aggs: { partitions: { terms: { field: 'partition', size: 4096 } } },
  });
  return new Map(
    (response.body.aggregations?.partitions?.buckets ?? []).map((bucket) => [bucket.key, bucket.doc_count]),
  );
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
  if (activeRebuilds.has(lock)) {
    const state = await subjectGenerations(options.search, options.prefix);
    throw new RebuildError('busy', state.generations.at(-1) ?? 1);
  }
  activeRebuilds.add(lock);
  try {
    const state = await subjectGenerations(options.search, options.prefix);
    const previous = state.active;
    const highest = state.generations.at(-1) ?? 0;
    const generation = highest > (previous ?? 0) ? highest : highest + 1;
    await createSubjectIndex(options.search, options.prefix, generation);
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
        const sourceCount = source.get(partition) ?? 0;
        const indexedCount = indexed.get(partition) ?? 0;
        const counts = { partition, indexed: indexedCount, source: sourceCount };
        lastCounts.set(partition, counts);
        const quiet =
          finish !== undefined &&
          start.head === start.checkpoint &&
          finish.head === finish.checkpoint &&
          start.head === finish.head;
        if (quiet) {
          if (indexedCount !== sourceCount) mismatches.set(partition, counts);
          else mismatches.delete(partition);
        } else {
          pending.set(partition, finish ?? start);
        }
      }
      for (const [partition, finish] of after) {
        if (!before.has(partition)) {
          pending.set(partition, finish);
          const counts = {
            partition,
            indexed: indexed.get(partition) ?? 0,
            source: (await options.source.count(partition)).count,
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

    await options.search.request('PUT', `/${index}/_mapping`, {
      _meta: { activated_at: new Date().toISOString() },
    });
    const actions: unknown[] = [];
    if (previous !== null)
      actions.push({
        remove: { index: subjectIndexName(options.prefix, previous), alias: subjectAlias(options.prefix) },
      });
    actions.push({ add: { index, alias: subjectAlias(options.prefix) } });
    await options.search.request('POST', '/_aliases', { actions });
    return { generation, previous };
  } finally {
    activeRebuilds.delete(lock);
  }
}
