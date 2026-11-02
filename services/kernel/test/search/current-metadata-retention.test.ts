import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { subjectAlias, subjectIndexName, SUBJECT_SORT_FORMAT } from '../../src/search/indices.ts';
import { compileKinds, CURRENT_METADATA_RETENTION, kindDigest } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import freshness from '../../src/search/freshness.sql';
import { createFakeSource } from './support/fake-source.ts';

function catalogue(n: number) {
  return {
    types: Object.fromEntries<{ bases: string[]; labels: Record<string, string>; icon: string | null }>(
      Array.from({ length: 9 }, (_, i) => [
        `kind:Kind${n}-${i}`,
        { bases: [], labels: { en: `Kind ${n}-${i}` }, icon: i === 0 ? 'book' : null },
      ]),
    ),
    properties: {},
  };
}

test('successive catalogue digests cannot grow the kind snapshot cache without bound', () => {
  const first = catalogue(0);
  const digest = kindDigest(first);
  let enumerations = 0;
  const types = new Proxy(first.types, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const pinned = compileKinds({ ...first, types }, digest);
  expect(enumerations).toBe(1);
  expect(pinned.digest).toBe(digest);
  expect(compileKinds(first, digest)).toBe(pinned);
  first.types['kind:Kind0-0'] = { bases: [], labels: { en: 'Mutated' }, icon: 'book' };
  expect(pinned.label('kind:Kind0-0', ['en'])).toEqual({ value: 'Kind 0-0', language: 'en' });

  const later = Array.from({ length: CURRENT_METADATA_RETENTION }, (_, n) => {
    const release = catalogue(n + 1);
    return compileKinds(release, kindDigest(release));
  });
  const retained = later[later.length - 1]!;
  expect(compileKinds(catalogue(CURRENT_METADATA_RETENTION), retained.digest)).toBe(retained);
  expect(compileKinds(first, digest)).not.toBe(pinned);
  expect(enumerations).toBe(2);
  expect(pinned.page(undefined, ['en']).values).toHaveLength(8);
  expect(pinned.page(undefined, ['en']).values[0]).toMatchObject({
    value: 'kind:Kind0-0',
    label: { value: 'Kind 0-0', language: 'en' },
    icon: 'book',
  });
});

function waitCount(read: () => number, needed: number, watch: (notify: (n: number) => void) => void) {
  if (read() >= needed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    watch((n) => {
      if (n >= needed) resolve();
    });
    if (read() >= needed) resolve();
  });
}

function heldFreshness(prefix: string) {
  const consumerOf = (generation: number) => subjectConsumer(prefix, generation);
  const started = new Map<string, { count: number; waiters: ((count: number) => void)[] }>();
  const held = new Map<string, { open: () => void }[]>();
  const pool = {
    async query(_text: string, values?: unknown[]) {
      const consumer = values?.[freshness.params.indexOf('consumer')];
      if (typeof consumer !== 'string') throw new Error('unexpected query');
      const state = started.get(consumer) ?? { count: 0, waiters: [] };
      state.count++;
      started.set(consumer, state);
      for (const waiter of state.waiters) waiter(state.count);
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      const queue = held.get(consumer) ?? [];
      queue.push({ open });
      held.set(consumer, queue);
      await wait;
      const generation = Number(/g(\d+)$/.exec(consumer)?.[1]);
      return { rows: [{ now: new Date(Date.UTC(2026, 0, 1, 0, 0, generation)), behind: 0, oldest: null }] };
    },
  } as unknown as Pool;
  return {
    pool,
    count(generation: number) {
      return started.get(consumerOf(generation))?.count ?? 0;
    },
    began(generation: number, count = 1) {
      const consumer = consumerOf(generation);
      return waitCount(
        () => started.get(consumer)?.count ?? 0,
        count,
        (notify) => {
          const current = started.get(consumer) ?? { count: 0, waiters: [] };
          current.waiters.push(notify);
          started.set(consumer, current);
        },
      );
    },
    release(generation: number) {
      held.get(consumerOf(generation))?.shift()?.open();
    },
  };
}

function catalogueEngine(prefix: string) {
  let active = 1;
  let searches = 0;
  const searchWaiters: ((count: number) => void)[] = [];
  const scripts = new Map<string, { script: unknown }>();
  const alias = subjectAlias(prefix);
  const client = {
    async request(method: string, path: string, body?: unknown) {
      if (path.startsWith('/_scripts/')) {
        if (method === 'PUT') {
          scripts.set(path, body as { script: unknown });
          return { status: 200, body: { acknowledged: true } };
        }
        const stored = scripts.get(path);
        return {
          status: 200,
          body: { _id: path.slice('/_scripts/'.length), found: true, script: stored?.script },
        };
      }
      if (path.startsWith('/_resolve/index/')) {
        const index = subjectIndexName(prefix, active);
        return {
          status: 200,
          body: {
            indices: [{ name: index, attributes: ['open'], aliases: [alias] }],
            aliases: [{ name: alias, indices: [index] }],
            data_streams: [],
          },
        };
      }
      if (path.endsWith('/_mapping')) {
        const index = path.slice(1, -'/_mapping'.length);
        return {
          status: 200,
          body: {
            [index]: {
              mappings: { properties: { type: { type: 'keyword' } }, _meta: { name_sort_format: SUBJECT_SORT_FORMAT } },
            },
          },
        };
      }
      if (path.endsWith('/_search/template')) {
        searches++;
        for (const waiter of searchWaiters) waiter(searches);
        return {
          status: 200,
          body: {
            timed_out: false,
            _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
            hits: { hits: [] },
          },
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async bulk() {
      throw new Error('unexpected bulk');
    },
  } as unknown as OpenSearch;
  return {
    client,
    setActive(generation: number) {
      active = generation;
    },
    searched(count: number) {
      return waitCount(
        () => searches,
        count,
        (notify) => searchWaiters.push(notify),
      );
    },
  };
}

test('successive physical generations cannot grow retained freshness readers without bound', async () => {
  const prefix = 'retn-';
  const freshnessPool = heldFreshness(prefix);
  const engine = catalogueEngine(prefix);
  const service = createSearchService({
    pool: freshnessPool.pool,
    client: engine.client,
    prefix,
    source: createFakeSource(),
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
  });
  const asOf = (generation: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, generation)).toISOString();
  engine.setActive(1);
  const pinned = service.suggest('a', 1);
  await freshnessPool.began(1);
  const coalesced = service.suggest('a', 1);
  await engine.searched(2);
  expect(freshnessPool.count(1)).toBe(1);

  for (let generation = 2; generation <= CURRENT_METADATA_RETENTION + 2; generation++) {
    engine.setActive(generation);
    const page = service.suggest('a', 1);
    await freshnessPool.began(generation);
    freshnessPool.release(generation);
    expect((await page).as_of).toBe(asOf(generation));
  }

  engine.setActive(1);
  const afterEviction = service.suggest('a', 1);
  await freshnessPool.began(1, 2);
  expect(freshnessPool.count(1)).toBe(2);
  freshnessPool.release(1);
  expect((await pinned).as_of).toBe(asOf(1));
  await freshnessPool.began(1, 3);
  freshnessPool.release(1);
  expect((await afterEviction).as_of).toBe(asOf(1));
  freshnessPool.release(1);
  expect((await coalesced).as_of).toBe(asOf(1));
});
