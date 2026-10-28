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
} from './indices.ts';
import { createSubjectIndexer } from './indexer.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';

export function subjectConsumer(prefix: string, generation: number): string {
  const consumer = `search_${prefix.replaceAll('-', '_')}subjects_g${generation}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(consumer)) throw new RangeError('consumer name is invalid');
  return consumer;
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
}): Promise<{ pause(): Promise<void>; resume(): void; stop(): Promise<void>; refresh(): Promise<void> }> {
  const discoverMs = options.discoverMs ?? 5000;
  if (!Number.isInteger(discoverMs) || discoverMs < 1) throw new RangeError('discoverMs must be a positive integer');
  const retireAfterMs = options.retireAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(retireAfterMs) || retireAfterMs < 0)
    throw new RangeError('retireAfterMs must be a non-negative finite number');
  let current: ReturnType<typeof startRelays> | undefined;
  let currentGenerations: number[] | undefined;
  const pendingRetirements = new Set<number>();
  let paused = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let discovery = Promise.resolve();

  const discover = async () => {
    if (stopped) return;
    try {
      let state = await subjectGenerations(options.search, options.prefix);
      if (state.generations.length === 0) {
        await createSubjectIndex(options.search, options.prefix, 1);
        await options.search.request('PUT', `/${subjectIndexName(options.prefix, 1)}/_mapping`, {
          _meta: { activated_at: new Date().toISOString() },
        });
        await options.search.request('POST', '/_aliases', {
          actions: [{ add: { index: subjectIndexName(options.prefix, 1), alias: subjectAlias(options.prefix) } }],
        });
        state = { generations: [1], active: 1 };
      }

      let activatedAt: number | undefined;
      if (state.active !== null) {
        const index = subjectIndexName(options.prefix, state.active);
        const { body } = await options.search.request<
          Record<string, { mappings?: { _meta?: { activated_at?: unknown } } }>
        >('GET', `/${index}/_mapping`);
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
        for (const generation of liveGenerations)
          await ensureSubjectRatingMapping(options.search, options.prefix, generation);
        const previous = current;
        current = undefined;
        currentGenerations = undefined;
        if (previous) await previous.stop();
        const relays = liveGenerations.map((generation) =>
          createSubjectIndexer({
            pool: options.pool,
            search: options.search,
            source: options.source,
            listing: options.listing,
            index: subjectIndexName(options.prefix, generation),
            consumer: subjectConsumer(options.prefix, generation),
          }),
        );
        const next = startRelays(options.pool, relays, {
          ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        });
        current = next;
        currentGenerations = liveGenerations;
        if (paused) await next.pause();
      }

      for (const generation of pendingRetirements) {
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

  const refresh = async () => {
    const next = discovery.then(discover, discover);
    discovery = next;
    await next;
  };
  await refresh();
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, discoverMs);
  };
  schedule();

  return {
    async pause() {
      paused = true;
      await current?.pause();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      current?.resume();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await discovery;
      await current?.stop();
      current = undefined;
    },
    refresh,
  };
}
