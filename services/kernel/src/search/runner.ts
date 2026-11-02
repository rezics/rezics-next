import { withConnection } from '../database/pool.ts';
import { readErasureStatus, resolveLateErasureItem } from '../access/erasure.ts';
import {
  nativeDiscoveryRegistry,
  createDiscoveryProjection,
  registerRetiredErasure,
  copyLocator,
} from './account-discovery.ts';
import { advanceDiscovery, discoveryGenerations, discoveryConsumer, type DiscoveryGeneration } from './generations.ts';
import { createDiscoveryIndexer } from './indexer.ts';
import { discoveryIndexName, discoveryIndexUuid } from './indices.ts';
import type { PublicPreparation } from './public-preparation.ts';
import type { Pool } from 'pg';
import { startRelays } from '../events/relays.ts';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';
import retire from './retire.sql';
import {
  createSubjectIndex,
  ensureSubjectRatingMapping,
  subjectGenerations,
  subjectIndexName,
  subjectAlias,
  readSubjectSortFormat,
} from './indices.ts';
import { createSubjectIndexer } from './indexer.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';

export { subjectConsumer } from './consumer-name.ts';

export async function startSearchIndexing(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  prefix: string;
  intervalMs?: number;
  discoverMs?: number;
  concurrency?: number;
  retireAfterMs?: number;
  discovery?: { routeKey: Uint8Array };
  publicPreparation?: PublicPreparation;
}): Promise<{ pause(): Promise<void>; resume(): void; stop(): Promise<void>; refresh(): Promise<void> }> {
  const discoverMs = options.discoverMs ?? 5000;
  if (!Number.isInteger(discoverMs) || discoverMs < 1) throw new RangeError('discoverMs must be a positive integer');
  const retireAfterMs = options.retireAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(retireAfterMs) || retireAfterMs < 0)
    throw new RangeError('retireAfterMs must be a non-negative finite number');
  const mixed = options.discovery
    ? startDiscoveryIndexing({ ...options, routeKey: options.discovery.routeKey })
    : undefined;
  let current: ReturnType<typeof startRelays> | undefined;
  let currentGenerations: number[] | undefined;
  const pendingRetirements = new Set<number>();
  let paused = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let discovery = Promise.resolve();
  let pauseDrain = Promise.resolve();
  let resumeAfter: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const clearSchedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const discover = async () => {
    if (stopped) return;
    try {
      let state = await subjectGenerations(options.search, options.prefix);
      if (stopped) return;
      if (state.generations.length === 0) {
        await createSubjectIndex(options.search, options.prefix, 1);
        if (stopped) return;
        if (!options.publicPreparation) {
          const format = await readSubjectSortFormat(options.search, options.prefix, 1);
          if (stopped) return;
          await options.search.request('PUT', `/${subjectIndexName(options.prefix, 1)}/_mapping`, {
            _meta: { ...(format === null ? {} : { name_sort_format: format }), activated_at: new Date().toISOString() },
          });
          if (stopped) return;
          await options.search.request('POST', '/_aliases', {
            actions: [{ add: { index: subjectIndexName(options.prefix, 1), alias: subjectAlias(options.prefix) } }],
          });
          if (stopped) return;
          state = { generations: [1], active: 1 };
        } else {
          state = { generations: [1], active: null };
        }
      }

      if (options.publicPreparation) {
        for (const generation of state.generations)
          if (state.active === null || generation > state.active)
            await options.publicPreparation.initialize(generation);
        await options.publicPreparation.discover();
      }
      let activatedAt: number | undefined;
      if (state.active !== null) {
        const index = subjectIndexName(options.prefix, state.active);
        const { body } = await options.search.request<
          Record<string, { mappings?: { _meta?: { activated_at?: unknown } } }>
        >('GET', `/${index}/_mapping`);
        if (stopped) return;
        const value = body[index]?.mappings?._meta?.activated_at;
        if (typeof value === 'string') {
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed)) activatedAt = parsed;
        }
      }

      const liveGenerations = state.generations.filter((generation) => {
        if (state.active === null) return true;
        if (generation >= state.active) return true;
        if (activatedAt === undefined) return true;
        return Date.now() < activatedAt + retireAfterMs;
      });
      for (const generation of liveGenerations) pendingRetirements.delete(generation);
      for (const generation of state.generations) {
        if (!liveGenerations.includes(generation)) pendingRetirements.add(generation);
      }

      if (!currentGenerations || liveGenerations.join(',') !== currentGenerations.join(',')) {
        // Strict mappings on generations created before public rating fields need the two
        // compatible additions before any relay can bulk a rating-bearing document.
        for (const generation of liveGenerations) {
          if (stopped) return;
          await ensureSubjectRatingMapping(options.search, options.prefix, generation);
        }
        if (stopped) return;
        const previous = current;
        current = undefined;
        currentGenerations = undefined;
        if (previous) await previous.stop();
        if (stopped) return;
        const relays = liveGenerations.map((generation) =>
          createSubjectIndexer({
            pool: options.pool,
            search: options.search,
            source: options.source,
            listing: options.listing,
            index: subjectIndexName(options.prefix, generation),
            consumer: subjectConsumer(options.prefix, generation),
            writer: createSearchWriterGuard({
              consumer: subjectConsumer(options.prefix, generation),
              pool: options.pool,
              search: options.search,
              source: options.source,
              listing: options.listing,
              index: subjectIndexName(options.prefix, generation),
            }),
            ...(options.publicPreparation ? { aroundApply: options.publicPreparation.writer(generation) } : {}),
          }),
        );
        const next = startRelays(options.pool, relays, {
          // A replacement must inherit intent before its first partition scan can run.
          paused,
          ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        });
        current = next;
        currentGenerations = liveGenerations;
      }

      // Native retained-copy custody must drain before default retirement can delete an exact target.
      if (options.publicPreparation) return;
      for (const generation of pendingRetirements) {
        if (stopped) return;
        try {
          try {
            await options.search.request('DELETE', `/${subjectIndexName(options.prefix, generation)}`);
          } catch (error) {
            if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
          }
          await retire.run(options.pool, { consumer: subjectConsumer(options.prefix, generation) });
          pendingRetirements.delete(generation);
        } catch (error) {
          console.error(`Search generation retirement failed for ${options.prefix} generation ${generation}`, error);
        }
      }
    } catch (error) {
      console.error(`Search index discovery failed for ${options.prefix}`, error);
    }
  };

  const refresh = () => {
    if (stopped) return Promise.resolve();
    const next = discovery.then(discover, discover);
    discovery = next;
    return next;
  };
  await refresh();
  const schedule = () => {
    if (stopped || paused || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || paused) return;
      void refresh().then(schedule, schedule);
    }, discoverMs);
  };
  schedule();

  return {
    pause() {
      paused = true;
      resumeAfter = undefined;
      clearSchedule();
      const projection = Promise.all([current?.pause(), mixed?.pause()]);
      const preparing = options.publicPreparation?.pause();
      // Discovery owns any relay set being replaced. Its successor is born paused;
      // drain both that admitted chain and the current projection before resuming.
      pauseDrain = Promise.all([discovery, projection, preparing]).then(async () => {
        await current?.pause();
      });
      return pauseDrain;
    },
    resume() {
      if (!paused || stopped || resumeAfter) return;
      const after = pauseDrain;
      resumeAfter = after;
      void after.then(
        () => {
          if (stopped || resumeAfter !== after) return;
          resumeAfter = undefined;
          paused = false;
          options.publicPreparation?.resume();
          current?.resume();
          mixed?.resume();
          schedule();
        },
        (error) => {
          if (resumeAfter === after) resumeAfter = undefined;
          console.error(`Search runner resume failed for ${options.prefix}`, error);
        },
      );
    },
    stop() {
      if (closing) return closing;
      stopped = true;
      paused = true;
      resumeAfter = undefined;
      clearSchedule();
      const previous = current;
      const projection = Promise.all([previous?.stop(), mixed?.stop()]);
      const preparing = options.publicPreparation?.stop();
      closing = Promise.all([discovery, projection, preparing]).then(async () => {
        if (current && current !== previous) await current.stop();
        current = undefined;
        currentGenerations = undefined;
      });
      return closing;
    },
    async refresh() {
      await Promise.all([refresh(), mixed?.refresh()]);
    },
  };
}

/** Default mixed-family lifecycle. Population and relays share the exact native projection/writer. */
export function startDiscoveryIndexing(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  prefix: string;
  routeKey: Uint8Array;
  intervalMs?: number;
  concurrency?: number;
}) {
  const relays = new Map<number, ReturnType<typeof startRelays>>();
  let stopped = false,
    paused = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve(),
    pauseDrain = Promise.resolve(),
    resumeAfter: Promise<void> | undefined,
    closing: Promise<void> | undefined,
    delay = options.intervalMs ?? 100;
  const clearSchedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const step = async () => {
    if (stopped || paused) return;
    const registry = await nativeDiscoveryRegistry(options.pool, options.routeKey, options.source);
    await advanceDiscovery({ ...options, registry });
    const generations = await discoveryGenerations(options.pool, options.prefix);
    delay = generations.some((row) => !['active', 'retiring', 'quarantined'].includes(row.state))
      ? 0
      : (options.intervalMs ?? 100);
    for (const target of generations) {
      if (!target.uuid || ['allocated', 'retired', 'quarantined', 'retiring'].includes(target.state)) continue;
      if (!relays.has(target.generation)) {
        const projection = createDiscoveryProjection({ ...options, target, registry });
        relays.set(
          target.generation,
          startRelays(
            options.pool,
            [createDiscoveryIndexer(options.pool, projection, discoveryConsumer(options.prefix, target.generation))],
            {
              paused,
              intervalMs: options.intervalMs ?? 100,
              concurrency: options.concurrency ?? 2,
            },
          ),
        );
      }
    }
    for (const target of generations.filter((row) => row.state === 'retiring')) {
      await relays.get(target.generation)?.stop();
      relays.delete(target.generation);
      await retireDiscovery(
        options.pool,
        options.search,
        target,
        generations.find((row) => row.state === 'active'),
      );
    }
    for (const [generation, relay] of relays)
      if (!generations.some((row) => row.generation === generation && row.state !== 'quarantined')) {
        await relay.stop();
        relays.delete(generation);
      }
  };
  const refresh = () => {
    const next = running.then(step);
    running = next.catch((error) => {
      console.error('Discovery maintenance failed', error);
    });
    return next;
  };
  const schedule = (waitMs: number) => {
    if (stopped || paused || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().then(
        () => schedule(delay),
        () => schedule(options.intervalMs ?? 100),
      );
    }, waitMs);
  };
  schedule(0);
  return {
    refresh,
    pause() {
      paused = true;
      resumeAfter = undefined;
      clearSchedule();
      const projection = Promise.all([...relays.values()].map((relay) => relay.pause()));
      // Finish in-flight maintenance and relay drains, then apply the current
      // pause intent to every retained or newly created relay.
      pauseDrain = Promise.all([running, projection]).then(async () => {
        if (stopped) return;
        await Promise.all([...relays.values()].map((relay) => relay.pause()));
      });
      return pauseDrain;
    },
    resume() {
      if (!paused || stopped || resumeAfter) return;
      const after = pauseDrain;
      resumeAfter = after;
      void after.then(
        () => {
          if (stopped || resumeAfter !== after) return;
          resumeAfter = undefined;
          paused = false;
          for (const relay of relays.values()) relay.resume();
          schedule(0);
        },
        (error) => {
          if (resumeAfter === after) resumeAfter = undefined;
          console.error('Discovery runner resume failed', error);
        },
      );
    },
    stop() {
      if (closing) return closing;
      stopped = true;
      paused = true;
      resumeAfter = undefined;
      clearSchedule();
      return (closing = running.then(async () => {
        await Promise.all([...relays.values()].map((relay) => relay.stop()));
        relays.clear();
      }));
    },
  };
}

async function retireDiscovery(
  pool: Pool,
  search: OpenSearch,
  target: DiscoveryGeneration,
  active: DiscoveryGeneration | undefined,
) {
  if (!active) return;
  const due = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ due: boolean }>(
          `SELECT activated_at < clock_timestamp()-interval '15 minutes' AS due FROM search.discovery_generation
     WHERE partition_no=0 AND prefix=$1 AND generation=$2`,
          [active.prefix, active.generation],
        )
      ).rows[0]?.due,
  );
  if (!due) return;
  const index = discoveryIndexName(target.prefix, target.generation);
  await withConnection(pool, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [index]);
    try {
      try {
        if ((await discoveryIndexUuid(search, index)) !== target.uuid)
          throw new Error('Discovery retirement incarnation mismatch');
        await search.request('DELETE', `/${index}`);
      } catch (error) {
        if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [index]);
    }
  });
  // Reclaim a bounded locator page only after physical deletion. Late erasure items still resolve through Access.
  const copies = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ route: number; id: string; kind: string }>(
          `SELECT route,source_id::text AS id,kind FROM search.discovery_copy WHERE prefix=$1 AND generation=$2 ORDER BY route,source_id,kind LIMIT 100`,
          [target.prefix, target.generation],
        )
      ).rows,
  );
  for (const copy of copies) {
    if (copy.kind === 'account') {
      const status = await withConnection(pool, (client) => readErasureStatus(client, copy.id));
      if (status) {
        await registerRetiredErasure(pool, target, copy.id);
        await resolveLateErasureItem(
          { pool },
          { accountId: copy.id, participant: 'search', locator: copyLocator(target) },
        );
      }
    }
    await withConnection(pool, (client) =>
      client.query(
        'DELETE FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind=$5',
        [copy.route, copy.id, target.prefix, target.generation, copy.kind],
      ),
    );
  }
  if (copies.length) return;
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM search.discovery_population WHERE prefix=$1 AND generation=$2', [
        target.prefix,
        target.generation,
      ]);
      await client.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [
        discoveryConsumer(target.prefix, target.generation),
      ]);
      await client.query(
        "UPDATE search.discovery_generation SET state='retired' WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='retiring'",
        [target.prefix, target.generation],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
