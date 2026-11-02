import { isDeepStrictEqual } from 'node:util';
import { subjectSource } from '../semantic/search-source.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { documentActions, type IndexAction, type SubjectDocument } from './document.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { readAccountDiscoveryWitness } from '../access/account-discovery-source.ts';
import type { DiscoveryKey, DiscoveryRegistry, DiscoveryIndexAction, IndexedDiscoveryDocument } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import {
  nativeDiscoveryRegistry,
  createDiscoveryProjection,
  validateAccountPage,
  validateAccountSnapshot,
  type DiscoveryProjection,
  type DiscoveryTarget,
} from './account-discovery.ts';
import { discoveryIndexName, discoveryIndexUuid, discoveryAlias, createDiscoveryIndex } from './indices.ts';
import {
  discoveryDocumentActions,
  parseDiscoveryHitIdentity,
  validateDiscoveryDocument,
} from './discovery-documents.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { validateObservation } from './indexer.ts';
import type { Pool } from 'pg';
import { discardConnection } from '../database/pool.ts';
import {
  createSubjectIndex,
  MAX_SUBJECT_GENERATIONS,
  observedWrite,
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

export { observedWrite };
import type { SubjectSource } from './source.ts';
import { subjectConsumer, startDiscoveryIndexing } from './runner.ts';

import { discoveryConsumer } from './consumer-name.ts';
export { discoveryConsumer };

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

export async function rebuildSubjects(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  prefix: string;
  runner: { refresh(): Promise<void> };
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

    if (options.publication === 'native') {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const published = await subjectGenerations(options.search, options.prefix);
        if (published.active === generation) return { generation, previous };
        if (published.active !== previous) throw new RebuildError('running', generation);
        if (Date.now() >= deadline) throw new RebuildError('timeout', generation);
        await sleep(pollMs);
      }
    }

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

export type DiscoveryGeneration = DiscoveryTarget & { state: string; kinds: string[] };

const DISCOVERY_LIVE_LIMIT = MAX_SUBJECT_GENERATIONS + 1;
const LIVE_QUOTA_STATES = new Set(['active', 'retiring', 'quarantined']);

/** Descending primary-key seek for the historical high water, independent of retired-row count. */
export const DISCOVERY_GENERATION_HIGH_WATER_SQL = `SELECT generation::text FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 ORDER BY partition_no DESC, prefix DESC, generation DESC LIMIT 1`;

/** Partial live index plus overflow LIMIT; a fourth live row is corrupt evidence. */
export const DISCOVERY_LIVE_GENERATIONS_SQL = `SELECT prefix,generation::float8 AS generation,index_uuid AS uuid,
    incarnation::text,state,kinds FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND state <> 'retired' ORDER BY partition_no, prefix, generation LIMIT ${DISCOVERY_LIVE_LIMIT}`;

function admitLiveDiscovery(rows: DiscoveryGeneration[]): DiscoveryGeneration[] {
  if (rows.length > MAX_SUBJECT_GENERATIONS)
    throw new SearchUnavailableError('Discovery live generation inventory is corrupt');
  return rows;
}

export async function discoveryGenerations(pool: Pool, prefix: string): Promise<DiscoveryGeneration[]> {
  return withConnection(pool, async (client) =>
    admitLiveDiscovery((await client.query<DiscoveryGeneration>(DISCOVERY_LIVE_GENERATIONS_SQL, [prefix])).rows),
  );
}

/** Short allocation transaction registers replay before any native population observation. */
export async function allocateDiscovery(pool: Pool, prefix: string, registry: DiscoveryRegistry): Promise<void> {
  discoveryAlias(prefix);
  await withConnection(pool, async (client) => {
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
        SELECT p,$1,$2,owner FROM generate_series(0,4095) p CROSS JOIN unnest(ARRAY['accounts','semantic']) owner`,
        [prefix, generation],
      );
      await client.query(
        `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
        SELECT partition_no,$1,epoch,position FROM core.partition ON CONFLICT DO NOTHING`,
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
  owner: 'accounts' | 'semantic';
  after_route: number | null;
  after_id: string | null;
  position: string;
  revision: string;
  claim_revision: string;
  indexed: string;
  census: string;
  reconcile_position: string | null;
};

async function populationPage(pool: Pool, projection: DiscoveryProjection, row: Population) {
  const { registry, target } = projection,
    partition = row.partition;
  const account = registry.get('account');
  if (account.owner !== 'accounts') throw new Error('Native Accounts producer is required');
  let next: { route: number; id: string } | null, keys: DiscoveryKey[], position: bigint;
  if (row.owner === 'accounts') {
    const after = row.after_id === null ? null : { route: row.after_route!, id: row.after_id };
    const page = validateAccountPage(await account.source.page(partition, after, 100), partition, after, 100);
    keys = page.accounts.map(({ id }) => ({ owner: 'accounts', kind: 'account', id, route: routeOf(id)! }));
    next = page.next;
    position = page.position;
  } else {
    const rows = await withConnection(
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
  }
  await projection.project(partition, keys, 0n, true);
  await withConnection(pool, async (client) => {
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
}

/** Validate every indexed identity against current owner truth, not just equal generation counts. */
async function reconcileDiscoveryPage(
  pool: Pool,
  search: OpenSearch,
  projection: DiscoveryProjection,
  row: Population,
): Promise<void> {
  const { registry, target } = projection,
    partition = row.partition;
  const entry =
    row.owner === 'accounts' ? registry.get('account') : registry.entries.find((entry) => entry.owner === 'semantic');
  if (!entry || entry.owner !== row.owner) throw new Error('Both native discovery producers are required');
  const census = await entry.source.count(partition);
  const witness = (await readAccountDiscoveryWitness(pool, [partition])).get(partition);
  if (!witness) throw new Error('Native Account/claim witness is absent');
  const indexed = BigInt(row.indexed);
  const reset =
    row.reconcile_position === null ||
    BigInt(row.reconcile_position) !== census.position ||
    BigInt(row.revision) !== witness.revision ||
    BigInt(row.claim_revision) !== witness.claimRevision;
  const after = reset ? null : row.after_id;
  const page = await search.request<unknown>(
    'POST',
    `/${discoveryIndexName(target.prefix, target.generation)}/_search`,
    {
      size: 100,
      version: true,
      query: { bool: { filter: [{ term: { partition } }, { term: { owner: row.owner } }] } },
      sort: [{ route: 'asc' }, { id: 'asc' }],
      ...(after === null ? {} : { search_after: [row.after_route, after] }),
    },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(page.body);
  if (
    !record(page.body) ||
    !record(page.body.hits) ||
    !Array.isArray(page.body.hits.hits) ||
    page.body.hits.hits.length > 100
  )
    throw new Error('Discovery reconciliation page is malformed');
  const hits = page.body.hits.hits;
  const keys = hits.map((hit) => parseDiscoveryHitIdentity(registry, hit));
  let expected: DiscoveryIndexAction[];
  if (entry.owner === 'accounts') {
    const snapshot = validateAccountSnapshot(
      await entry.source.read(
        partition,
        keys.map(({ id }) => id),
      ),
      partition,
      keys.map(({ id }) => id),
      census.position,
    );
    expected = discoveryDocumentActions(registry, { owner: 'accounts', snapshot }, keys, undefined, 'mixed-public-v1');
  } else {
    const snapshot = await entry.source.read(
      partition,
      keys.map(({ id }) => id),
    );
    validateObservation(
      snapshot,
      partition,
      keys.map(({ id }) => id),
      census.position,
      true,
    );
    const counts = await projection.listing.read(
      partition,
      snapshot.subjects.map(({ id }) => id),
    );
    expected = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, keys, counts, 'mixed-public-v1');
  }
  expected = await prepareBoundedSortKeys(search, discoveryIndexName(target.prefix, target.generation), expected);
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
    await projection.project(partition, keys, 0n, true);
    return;
  }
  const finish = await entry.source.count(partition),
    end = (await readAccountDiscoveryWitness(pool, [partition])).get(partition);
  const stable =
    finish.position === census.position &&
    finish.count === census.count &&
    end?.revision === witness.revision &&
    end.claimRevision === witness.claimRevision;
  const total = (reset ? 0n : indexed) + BigInt(hits.length),
    exhausted = hits.length < 100;
  if (!stable) return;
  if (exhausted && total !== BigInt(census.count)) {
    // A missing identity has no engine key to repair. Rewalk only this native owner/partition.
    await withConnection(pool, async (client) => {
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
    return;
  }
  const last = keys.at(-1);
  await withConnection(pool, async (client) => {
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
}

/** One bounded maintenance step; failed external work leaves its actual frontier replayable. */
export async function advanceDiscovery(options: {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  registry: DiscoveryRegistry;
  listing: SubjectListingSource;
}): Promise<void> {
  const { pool, search, prefix, registry } = options;
  let generations = await discoveryGenerations(pool, prefix);
  const kinds = registry.entries.map(({ kind }) => kind).sort();
  if (
    generations.length === 0 ||
    (generations.every((row) => ['active', 'retiring', 'quarantined'].includes(row.state)) &&
      generations.some((row) => row.state === 'active' && !isDeepStrictEqual(row.kinds, kinds)))
  ) {
    await allocateDiscovery(pool, prefix, registry);
    generations = await discoveryGenerations(pool, prefix);
  }
  const target = generations.find((row) => !['active', 'retiring', 'quarantined'].includes(row.state));
  if (!target) return;
  if (!isDeepStrictEqual(target.kinds, registry.entries.map(({ kind }) => kind).sort()))
    throw new Error('Discovery registry changed during population');
  const index = discoveryIndexName(prefix, target.generation);
  if (target.state === 'allocated') {
    try {
      await createDiscoveryIndex(search, prefix, target.generation, target.incarnation);
    } catch (error) {
      const { body } = await search.request<Record<string, { mappings?: { _meta?: { incarnation?: string } } }>>(
        'GET',
        `/${index}/_mapping`,
      );
      if (body[index]?.mappings?._meta?.incarnation !== target.incarnation) throw error;
    }
    const uuid = await discoveryIndexUuid(search, index);
    await withConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET index_uuid=$3,state='populating' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='allocated'",
        [prefix, target.generation, uuid],
      ),
    );
    return;
  }
  const projection = createDiscoveryProjection({ ...options, target });
  if (target.state === 'populating' || target.state === 'reconciling') {
    const population = await withConnection(
      pool,
      async (client) =>
        (
          await client.query<Population>(
            `SELECT partition_no AS partition,owner,after_route,after_id::text,position::text,
      revision::text,claim_revision::text,indexed::text,census::text,reconcile_position::text FROM search.discovery_population
      WHERE prefix=$1 AND generation=$2 AND ${target.state === 'populating' ? 'NOT complete' : 'NOT certified'} ORDER BY partition_no,owner LIMIT 1`,
            [prefix, target.generation],
          )
        ).rows[0],
    );
    if (population) {
      if (target.state === 'populating') await populationPage(pool, projection, population);
      else await reconcileDiscoveryPage(pool, search, projection, population);
      return;
    }
  }
  if (target.state === 'populating') {
    await withConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET state='replaying' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='populating'",
        [prefix, target.generation],
      ),
    );
    return;
  }
  if ((await readFreshness(pool, discoveryConsumer(prefix, target.generation))).behind > 0) return;
  if (target.state === 'replaying') {
    await withConnection(pool, (client) =>
      client.query(
        "UPDATE search.discovery_generation SET state='reconciling' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='replaying'",
        [prefix, target.generation],
      ),
    );
    return;
  }
  // A native write after a partition was certified invalidates that partition, including empty populations.
  const observations = await withConnection(
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
        }>(
          `SELECT p.partition_no AS partition,p.reconcile_position::text AS position,p.revision::text,p.claim_revision::text,c.position::text AS head,s.reconcile_position::text AS semantic_position
     FROM search.discovery_population p JOIN core.partition c ON c.partition_no=p.partition_no
     JOIN search.discovery_population s ON s.partition_no=p.partition_no AND s.prefix=p.prefix AND s.generation=p.generation AND s.owner='semantic' 
     WHERE p.prefix=$1 AND p.generation=$2 AND p.owner='accounts' ORDER BY p.partition_no`,
          [prefix, target.generation],
        )
      ).rows,
  );
  if (observations.length !== 4096) throw new Error('Discovery population partitions are incomplete');
  for (let offset = 0; offset < observations.length; offset += 100) {
    const chunk = observations.slice(offset, offset + 100),
      witnesses = await readAccountDiscoveryWitness(
        pool,
        chunk.map(({ partition }) => partition),
      );
    for (const row of chunk) {
      const witness = witnesses.get(row.partition);
      if (
        row.position === row.head &&
        row.semantic_position === row.head &&
        witness?.revision === BigInt(row.revision) &&
        witness.claimRevision === BigInt(row.claim_revision)
      )
        continue;
      await withConnection(pool, (client) =>
        client.query(
          `UPDATE search.discovery_population SET certified=false,after_route=NULL,after_id=NULL,reconcile_position=NULL,indexed=0
        WHERE prefix=$1 AND generation=$2 AND partition_no=$3`,
          [prefix, target.generation, row.partition],
        ),
      );
      await withConnection(pool, (client) =>
        client.query(
          "UPDATE search.discovery_generation SET state='reconciling' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='ready'",
          [prefix, target.generation],
        ),
      );
      return;
    }
  }
  if ((await discoveryIndexUuid(search, index)) !== target.uuid)
    throw new Error('Discovery incarnation changed before activation');
  const previous = generations.find((row) => row.state === 'active');
  await withConnection(pool, (client) =>
    client.query(
      "UPDATE search.discovery_generation SET state='ready' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='reconciling'",
      [prefix, target.generation],
    ),
  );
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
    async () => {
      const { body } = await search.request<Record<string, unknown>>('GET', `/_alias/${discoveryAlias(prefix)}`);
      return Object.keys(body).length === 1 && Object.hasOwn(body, index);
    },
    'Discovery activation could not be established',
  );
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        "UPDATE search.discovery_generation SET state='retiring' WHERE partition_no=0 AND prefix=$1 AND state='active' AND generation<>$2",
        [prefix, target.generation],
      );
      await client.query(
        "UPDATE search.discovery_generation SET state='active',activated_at=clock_timestamp() WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='ready'",
        [prefix, target.generation],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** CLI uses the same native factories and lifecycle as the default worker. */
export async function rebuildDiscovery(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  prefix: string;
  routeKey: Uint8Array;
}) {
  const registry = await nativeDiscoveryRegistry(options.pool, options.routeKey, options.source);
  const previous =
    (await discoveryGenerations(options.pool, options.prefix)).find((row) => row.state === 'active')?.generation ??
    null;
  await allocateDiscovery(options.pool, options.prefix, registry);
  const generation = (await discoveryGenerations(options.pool, options.prefix)).at(-1)?.generation;
  if (generation === undefined) throw new Error('Discovery allocation is absent');
  const runner = startDiscoveryIndexing(options),
    deadline = Date.now() + 3_600_000;
  try {
    for (;;) {
      await runner.refresh();
      if (
        (await discoveryGenerations(options.pool, options.prefix)).some(
          (row) => row.generation === generation && row.state === 'active',
        )
      )
        return { generation, previous };
      if (Date.now() >= deadline) throw new RebuildError('timeout', generation);
    }
  } finally {
    await runner.stop();
  }
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
    const snapshot = await subjectSource(pool).read(partition, ids);
    validateObservation(snapshot, partition, ids, obligation, true);
    // The supplied native writer owns factual projection, foreign fences and rating decoration.
    // This raw native observation supplies eligibility, key identity and external versions only.
    return documentActions(snapshot, ids);
  }
  const keys = options.keys;
  if (!keys || keys.length !== ids.length) throw new TypeError('Native discovery keys are required');
  const account = keys[0]?.owner === 'accounts';
  if (keys.some((key) => (key.owner === 'accounts') !== account)) throw new TypeError('Mixed owner key batch');
  let actions: DiscoveryIndexAction[];
  if (account) {
    const entry = registry.get('account');
    if (entry.owner !== 'accounts') throw new TypeError('Native Account producer is required');
    const snapshot = validateAccountSnapshot(await entry.source.read(partition, ids), partition, ids, obligation);
    actions = discoveryDocumentActions(registry, { owner: 'accounts', snapshot }, keys);
  } else {
    const entry = registry.entries.find((entry) => entry.owner === 'semantic');
    if (!entry || entry.owner !== 'semantic') throw new TypeError('Native Subject producer is required');
    const observed = await entry.source.read(partition, ids);
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
    )
      throw new GenerationReconciliationMismatch();
    hits.delete(action.id);
  }
  if (hits.size) throw new GenerationReconciliationMismatch();
  return response.body.hits.hits.length;
}

function nativeGenerationDocumentMatches(
  actual: unknown,
  expected: SubjectDocument | IndexedDiscoveryDocument,
): boolean {
  return isDeepStrictEqual(actual, expected);
}
