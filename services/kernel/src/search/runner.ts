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
      const projection = current?.pause();
      // Discovery owns any relay set being replaced. Its successor is born paused;
      // drain both that admitted chain and the current projection before resuming.
      pauseDrain = Promise.all([discovery, projection]).then(async () => {
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
          current?.resume();
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
      const projection = previous?.stop();
      closing = Promise.all([discovery, projection]).then(async () => {
        if (current && current !== previous) await current.stop();
        current = undefined;
        currentGenerations = undefined;
      });
      return closing;
    },
    refresh,
  };
}
