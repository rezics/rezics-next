import type { Pool } from 'pg';
import { startRelays } from '../events/relays.ts';
import { createSubjectIndex, subjectGenerations, subjectIndexName, subjectAlias } from './indices.ts';
import { createSubjectIndexer } from './indexer.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SubjectSource } from './source.ts';

export function subjectConsumer(prefix: string, generation: number): string {
  const consumer = `search_${prefix.replaceAll('-', '_')}subjects_g${generation}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(consumer)) throw new RangeError('consumer name is invalid');
  return consumer;
}

export async function startSearchIndexing(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  prefix: string;
  intervalMs?: number;
  discoverMs?: number;
  concurrency?: number;
}): Promise<{ pause(): Promise<void>; resume(): void; stop(): Promise<void>; refresh(): Promise<void> }> {
  const discoverMs = options.discoverMs ?? 5000;
  if (!Number.isInteger(discoverMs) || discoverMs < 1) throw new RangeError('discoverMs must be a positive integer');
  let current: ReturnType<typeof startRelays> | undefined;
  let currentGenerations: number[] | undefined;
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
        await options.search.request('POST', '/_aliases', {
          actions: [{ add: { index: subjectIndexName(options.prefix, 1), alias: subjectAlias(options.prefix) } }],
        });
        state = await subjectGenerations(options.search, options.prefix);
      }
      if (!currentGenerations || state.generations.join(',') !== currentGenerations.join(',')) {
        const previous = current;
        current = undefined;
        if (previous) await previous.stop();
        const relays = state.generations.map((generation) =>
          createSubjectIndexer({
            pool: options.pool,
            search: options.search,
            source: options.source,
            index: subjectIndexName(options.prefix, generation),
            consumer: subjectConsumer(options.prefix, generation),
          }),
        );
        currentGenerations = state.generations;
        current = startRelays(options.pool, relays, {
          ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        });
        if (paused) await current.pause();
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
