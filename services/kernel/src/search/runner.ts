import { createReviewDiscoveryReceiving } from './review-discovery-receiving.ts';
import type { ReviewDiscoverySource } from '../content/index.ts';
import { withConnection } from '../database/pool.ts';
import { readErasureStatus, resolveLateErasureItem } from './native-bindings.ts';
import {
  nativeDiscoveryRegistry,
  createDiscoveryProjection,
  registerRetiredErasure,
  copyLocator,
} from './account-discovery.ts';
import {
  advanceDiscovery,
  discoveryGenerations,
  discoveryConsumer,
  DiscoveryProducerCoverageError,
  type DiscoveryGeneration,
} from './generations.ts';
import { createDiscoveryIndexer } from './indexer.ts';
import { CollectionDiscoveryReadinessError } from './collection-discovery.ts';
import { resolveDiscoveryOwnerAdapters } from './discovery-owner-registry.ts';
import { discoveryIndexName, discoveryPhysicalTargetMatches, readDiscoveryPhysicalIdentity } from './indices.ts';
import type { PublicPreparation } from './public-preparation.ts';
import type { Pool } from 'pg';
import { relayConcurrencyForPool, startRelays } from '../events/relays.ts';
import {
  OpenSearchError,
  SearchUnavailableError,
  type OpenSearch,
  type SearchQuery,
  type SearchRequestOptions,
} from './opensearch.ts';
import retire from './retire.sql';
import {
  createSubjectIndex,
  ensureSubjectActivationMetadata,
  ensureSubjectRatingMapping,
  observedWrite,
  readSubjectCalendarMappingFormat,
  readSubjectCreditMappingFormat,
  readSubjectActivationTime,
  subjectGenerations,
  subjectIndexName,
  subjectAlias,
} from './indices.ts';
import { createSubjectIndexer } from './indexer.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';
import type { DiscoveryProducerEntry } from './index.ts';

import { subjectConsumer } from './consumer-name.ts';
export { subjectConsumer } from './consumer-name.ts';

/** Bind native requests to the lifetime that owns the runner and its relays. */
function runnerSearch(search: OpenSearch, signal: AbortSignal): OpenSearch {
  return {
    request<T>(
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      path: string,
      body?: unknown,
      options?: SearchRequestOptions,
    ) {
      return search.request<T>(method, path, body, { ...options, signal });
    },
    bulk<T>(lines: readonly unknown[], options?: { query?: SearchQuery; timeoutMs?: number; signal?: AbortSignal }) {
      return search.bulk<T>(lines, { ...options, signal });
    },
    ...(search.bulkRaw
      ? {
          bulkRaw<T>(body: string, options?: { query?: SearchQuery; timeoutMs?: number; signal?: AbortSignal }) {
            return search.bulkRaw!<T>(body, { ...options, signal });
          },
        }
      : {}),
  };
}

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
  discovery?: {
    routeKey: Uint8Array;
    requiredKinds?: readonly string[];
    producers: DiscoveryProducerEntry;
  };
  publicPreparation?: PublicPreparation;
}): Promise<{ pause(): Promise<void>; resume(): void; stop(): Promise<void>; refresh(): Promise<void> }> {
  const discoverMs = options.discoverMs ?? 5000;
  if (!Number.isInteger(discoverMs) || discoverMs < 1) throw new RangeError('discoverMs must be a positive integer');
  const retireAfterMs = options.retireAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(retireAfterMs) || retireAfterMs < 0)
    throw new RangeError('retireAfterMs must be a non-negative finite number');
  const lifetime = new AbortController();
  const search = runnerSearch(options.search, lifetime.signal);
  const mixed = options.discovery
    ? startDiscoveryIndexing({
        ...options,
        search,
        routeKey: options.discovery.routeKey,
        source: options.discovery.producers.subjects,
        producers: options.discovery.producers,
        ...(options.discovery.requiredKinds ? { requiredKinds: options.discovery.requiredKinds } : {}),
      })
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
      let state = await subjectGenerations(search, options.prefix);
      if (stopped) return;
      if (state.generations.length === 0) {
        await createSubjectIndex(search, options.prefix, 1);
        if (stopped) return;
        state = await subjectGenerations(search, options.prefix);
        if (!state.generations.includes(1))
          throw new SearchUnavailableError('Subject generation allocation could not be observed');
      }

      const confirmedRatingMappings = new Set<number>();
      if (!options.publicPreparation && state.active === null) {
        if (state.generations.length !== 1 || state.generations[0] !== 1)
          throw new SearchUnavailableError('Subject bootstrap activation is unavailable');
        await ensureSubjectRatingMapping(search, options.prefix, 1);
        confirmedRatingMappings.add(1);
        if (stopped) return;
        await ensureSubjectActivationMetadata(search, options.prefix, 1);
        if (stopped) return;
        await observedWrite(
          () =>
            search.request('POST', '/_aliases', {
              actions: [{ add: { index: subjectIndexName(options.prefix, 1), alias: subjectAlias(options.prefix) } }],
            }),
          async () => {
            const observed = await subjectGenerations(search, options.prefix);
            return observed.generations.includes(1) && observed.active === 1;
          },
          'Subject bootstrap activation could not be established',
        );
        if (stopped) return;
        state = await subjectGenerations(search, options.prefix);
        if (state.active !== 1 || !state.generations.includes(1))
          throw new SearchUnavailableError('Subject bootstrap activation is unavailable');
      }

      if (options.publicPreparation) {
        for (const generation of state.generations)
          if (state.active === null || generation > state.active)
            await options.publicPreparation.initialize(generation, lifetime.signal);
        if (stopped) return;
        await options.publicPreparation.discover();
      }
      let activatedAt: number | undefined;
      if (state.active !== null) {
        if (options.publicPreparation) {
          const index = subjectIndexName(options.prefix, state.active);
          const { body } = await search.request<Record<string, { mappings?: { _meta?: { activated_at?: unknown } } }>>(
            'GET',
            `/${index}/_mapping`,
          );
          if (stopped) return;
          const value = body[index]?.mappings?._meta?.activated_at;
          if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) activatedAt = parsed;
          }
        } else {
          const observed = await readSubjectActivationTime(search, options.prefix, state.active);
          if (observed === null) throw new SearchUnavailableError('Active Subject generation metadata is unavailable');
          activatedAt = observed;
        }
      }

      if (!options.publicPreparation && state.active === null)
        throw new SearchUnavailableError('Subject bootstrap activation is unavailable');

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
          if (!confirmedRatingMappings.has(generation))
            await ensureSubjectRatingMapping(search, options.prefix, generation);
        }
        if (stopped) return;
        const previous = current;
        current = undefined;
        currentGenerations = undefined;
        if (previous) await previous.stop();
        if (stopped) return;
        const relays = await Promise.all(
          liveGenerations.map(async (generation) => {
            const calendarFormat = await readSubjectCalendarMappingFormat(search, options.prefix, generation);
            const creditFormat = await readSubjectCreditMappingFormat(search, options.prefix, generation);
            return createSubjectIndexer({
              pool: options.pool,
              search,
              source: options.source,
              listing: options.listing,
              index: subjectIndexName(options.prefix, generation),
              consumer: subjectConsumer(options.prefix, generation),
              ...(calendarFormat === null ? {} : { calendarFormat }),
              ...(creditFormat === null ? {} : { creditFormat }),
              writer: createSearchWriterGuard({
                consumer: subjectConsumer(options.prefix, generation),
                pool: options.pool,
                search,
                source: options.source,
                listing: options.listing,
                index: subjectIndexName(options.prefix, generation),
                ...(calendarFormat === null ? {} : { calendarFormat }),
                ...(creditFormat === null ? {} : { creditFormat }),
              }),
              ...(options.publicPreparation ? { aroundApply: options.publicPreparation.writer(generation) } : {}),
            });
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
            await search.request('DELETE', `/${subjectIndexName(options.prefix, generation)}`);
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
      if (!stopped) console.error(`Search index discovery failed for ${options.prefix}`, error);
    }
  };

  const refresh = () => {
    if (stopped) return Promise.resolve();
    const next = discovery.then(discover, discover);
    discovery = next;
    return next;
  };
  const schedule = () => {
    if (stopped || paused || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || paused) return;
      void refresh().then(schedule, schedule);
    }, discoverMs);
  };
  // Keep the initial inventory refresh owned without making worker registration wait for it.
  void refresh().then(schedule, schedule);

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
      lifetime.abort(new Error('Search runner stopped'));
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
  requiredKinds?: readonly string[];
  producers?: DiscoveryProducerEntry;
  reviewSource?: ReviewDiscoverySource;
}) {
  const configuredConcurrency = options.concurrency ?? 2;
  if (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1)
    throw new RangeError('concurrency must be a positive integer below the pool size');
  const relayConcurrency = Math.min(configuredConcurrency, relayConcurrencyForPool(options.pool));
  type Installation = {
    bindings: Map<number, string>;
    receivers: Map<number, ReturnType<typeof createReviewDiscoveryReceiving>>;
    relay: ReturnType<typeof startRelays>;
  };
  let installation: Installation | undefined;
  let stopped = false,
    paused = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    running = Promise.resolve(),
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
    const producers = options.producers;
    const ownerAdapters = producers ? await resolveDiscoveryOwnerAdapters(producers) : undefined;
    if (stopped || paused) return;
    const registry = await nativeDiscoveryRegistry(
      options.pool,
      options.routeKey,
      options.source,
      ownerAdapters && producers
        ? {
            ownerAdapters: ownerAdapters.ownerAdapters,
            accounts: producers.accounts,
            omittedKinds: ownerAdapters.omittedKinds,
          }
        : undefined,
    );
    if (stopped || paused) return;
    const metadataProducers = ownerAdapters?.metadataProducers;
    const reviewSource = producers?.reviewSource ?? options.reviewSource;
    let readiness: Error | undefined;
    try {
      await advanceDiscovery({
        ...options,
        registry,
        requiredKinds: options.requiredKinds ?? Object.keys(metadataProducers ?? {}),
        ...(metadataProducers ? { metadataProducers } : {}),
        ...(ownerAdapters ? { capabilityWitnesses: ownerAdapters.capabilityWitnesses } : {}),
      });
    } catch (error) {
      if (!(error instanceof DiscoveryProducerCoverageError) && !(error instanceof CollectionDiscoveryReadinessError))
        throw error;
      readiness = error;
    }
    if (stopped || paused) return;
    const generations = await discoveryGenerations(options.pool, options.prefix);
    if (stopped || paused) return;
    delay =
      !readiness && generations.some((row) => !['active', 'retiring', 'quarantined'].includes(row.state))
        ? 0
        : (options.intervalMs ?? 100);

    const relayTargets: (DiscoveryGeneration & { uuid: string })[] = [];
    for (const target of generations) {
      if (!target.uuid || ['allocated', 'retired', 'quarantined', 'retiring'].includes(target.state)) continue;
      if (await discoveryPhysicalTargetMatches(options.search, target)) relayTargets.push(target);
    }
    const bindings = new Map<number, string>(
      relayTargets.map((target) => [target.generation, target.uuid + ':' + target.incarnation]),
    );
    const sameBindings =
      installation !== undefined &&
      bindings.size === installation.bindings.size &&
      [...bindings].every(([generation, binding]) => installation!.bindings.get(generation) === binding);

    if (relayTargets.length > 0 && !sameBindings) {
      // Prepare the complete replacement before stopping the current relay set. A
      // failed projection leaves the installed generations owned and running.
      const prepared: {
        target: (typeof relayTargets)[number];
        projection: ReturnType<typeof createDiscoveryProjection>;
        relay: ReturnType<typeof createDiscoveryIndexer>;
      }[] = [];
      for (const target of relayTargets) {
        if (stopped || paused) return;
        const projection = createDiscoveryProjection({
          ...options,
          target,
          registry,
          ...(metadataProducers ? { metadataProducers } : {}),
        });
        prepared.push({
          target,
          projection,
          relay: createDiscoveryIndexer(options.pool, projection, discoveryConsumer(options.prefix, target.generation)),
        });
      }

      const nextReceivers = new Map<number, ReturnType<typeof createReviewDiscoveryReceiving>>();
      for (const { target, projection } of prepared) {
        if (stopped || paused) return;
        if (
          reviewSource &&
          registry.ownerAdapters?.review?.readiness === 'ready' &&
          (await projection.hasMetadataPopulation?.('review'))
        ) {
          if (stopped || paused) return;
          nextReceivers.set(
            target.generation,
            createReviewDiscoveryReceiving({
              ...options,
              projection,
              source: reviewSource,
            }),
          );
        }
      }
      if (stopped || paused) return;

      // All generations sharing this Pool share one relay budget. Per-generation
      // supervisors could each pass the local pool guard while exhausting the
      // connection reserved for source reads, receiving and lifecycle commands.
      const previous = installation;
      if (previous) await previous.relay.stop();
      if (installation === previous) installation = undefined;
      if (stopped) return;
      const relay = startRelays(
        options.pool,
        prepared.map(({ relay }) => relay),
        { paused, intervalMs: options.intervalMs ?? 100, concurrency: relayConcurrency },
      );
      installation = { bindings, receivers: nextReceivers, relay };
    } else if (relayTargets.length === 0 && installation) {
      const previous = installation;
      await previous.relay.stop();
      if (installation === previous) installation = undefined;
    }

    // One finite current-review page per live target, sharing this supervisor's lifecycle and transport.
    for (const target of generations) {
      if (stopped || paused) return;
      if (target.uuid && !['allocated', 'retiring', 'retired', 'quarantined'].includes(target.state))
        await installation?.receivers.get(target.generation)?.next();
    }
    if (stopped || paused) return;
    for (const target of generations.filter((row) => row.state === 'retiring')) {
      if (stopped || paused) return;
      await retireDiscovery(
        options.pool,
        options.search,
        target,
        generations.find((row) => row.state === 'active'),
      );
    }
    if (readiness) throw readiness;
  };
  const refresh = () => {
    const next = running.then(step);
    running = next.catch((error) => {
      if (!stopped) console.error('Discovery maintenance failed', error);
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
      const projection = installation?.relay.pause() ?? Promise.resolve();
      // Finish in-flight maintenance and relay drains, then apply the current
      // pause intent to every retained or newly created relay.
      pauseDrain = Promise.all([running, projection]).then(async () => {
        if (stopped) return;
        await installation?.relay.pause();
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
          installation?.relay.resume();
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
        await installation?.relay.stop();
        installation = undefined;
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
  const due = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ due: boolean }>(
          `SELECT (activated_at IS NULL OR EXISTS (
             SELECT 1 FROM search.discovery_generation a WHERE a.partition_no=0 AND a.prefix=$1
               AND a.generation=$3 AND a.state='active' AND a.activated_at < clock_timestamp()-interval '15 minutes'
           )) AS due FROM search.discovery_generation
           WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND state='retiring'`,
          [target.prefix, target.generation, active?.generation ?? null],
        )
      ).rows[0]?.due,
  );
  if (!due) return;
  const index = discoveryIndexName(target.prefix, target.generation);
  await withConnection(pool, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [index]);
    try {
      const physical = await readDiscoveryPhysicalIdentity(search, index);
      // The name may now refer to a replacement owned by another incarnation. Drain this
      // persisted generation without deleting or writing that physical index.
      if (physical?.uuid === target.uuid) {
        try {
          await search.request('DELETE', `/${index}`);
        } catch (error) {
          if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
        }
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
