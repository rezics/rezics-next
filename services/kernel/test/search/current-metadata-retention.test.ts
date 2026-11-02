import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { subjectAlias, subjectIndexName, SUBJECT_SORT_FORMAT } from '../../src/search/indices.ts';
import {
  compileKinds,
  CURRENT_METADATA_RETENTION,
  kindDigest,
  SUGGEST_TEMPLATE,
} from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import freshness from '../../src/search/freshness.sql';
import { createFakeSource } from './support/fake-source.ts';

function catalogue(n: number): FilterRelease {
  return {
    types: Object.fromEntries(
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
  first.types['kind:Kind0-0'] = { bases: [], labels: { en: 'Mutated' } };
  expect(pinned.label('kind:Kind0-0', ['en'])).toEqual({ value: 'Kind 0-0', language: 'en' });
  const page = pinned.page(undefined, ['en']);
  expect(page.values).toHaveLength(8);
  expect(page.values[0]).toMatchObject({ value: 'kind:Kind0-0', icon: 'book' });
  page.values[0]!.label.value = 'Caller mutation';
  expect(pinned.page(undefined, ['en']).values[0]!.label.value).toBe('Kind 0-0');
  expect(pinned.page(page.after!, ['en']).values).toHaveLength(1);

  const later = Array.from({ length: CURRENT_METADATA_RETENTION }, (_, n) => {
    const release = catalogue(n + 1);
    return compileKinds(release, kindDigest(release));
  });
  expect(compileKinds(catalogue(CURRENT_METADATA_RETENTION), later.at(-1)!.digest)).toBe(later.at(-1));
  expect(compileKinds(first, digest)).not.toBe(pinned);
  expect(enumerations).toBe(2);
  expect(pinned.label('kind:Kind0-8', ['fr'])).toEqual({ value: 'kind:Kind0-8', language: 'und' });
  expect(pinned.page(undefined, ['en']).values[0]!.label.value).toBe('Kind 0-0');
});

function heldFreshness(prefix: string) {
  const consumerOf = (generation: number) => subjectConsumer(prefix, generation);
  const started = new Map<string, { count: number; waiters: ((count: number) => void)[] }>();
  const held = new Map<string, { open: () => void; wait: Promise<void> }[]>();
  const consumers: string[] = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      if (text !== freshness.sql) return { rows: [] };
      const consumer = String(values![freshness.params.indexOf('consumer')]);
      consumers.push(consumer);
      const state = started.get(consumer) ?? { count: 0, waiters: [] };
      state.count++;
      started.set(consumer, state);
      for (const waiter of state.waiters) waiter(state.count);
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      const queue = held.get(consumer) ?? [];
      queue.push({ open, wait });
      held.set(consumer, queue);
      await wait;
      const generation = Number(/g(\d+)$/.exec(consumer)?.[1]);
      return { rows: [{ now: new Date(Date.UTC(2026, 0, 1, 0, 0, generation)), behind: 0, oldest: null }] };
    },
  } as unknown as Pool;
  return {
    pool,
    consumers: () => consumers.slice(),
    count(generation: number) {
      return started.get(consumerOf(generation))?.count ?? 0;
    },
    async began(generation: number, count = 1) {
      const consumer = consumerOf(generation);
      const state = started.get(consumer);
      if ((state?.count ?? 0) >= count) return;
      await new Promise<void>((resolve) => {
        const current = started.get(consumer) ?? { count: 0, waiters: [] };
        current.waiters.push((n) => {
          if (n >= count) resolve();
        });
        started.set(consumer, current);
      });
    },
    release(generation: number) {
      const queue = held.get(consumerOf(generation));
      queue?.shift()?.open();
    },
  };
}

function catalogueEngine(prefix: string) {
  let active = 1;
  const scripts = new Map<string, { script: unknown }>();
  const alias = subjectAlias(prefix);
  const client: OpenSearch = {
    async request(method, path, body) {
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
  };
  return {
    client,
    setActive(generation: number) {
      active = generation;
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
  engine.setActive(1);
  const pinned = service.suggest('a', 1);
  await freshnessPool.began(1);
  const coalesced = service.suggest('a', 1);
  await Promise.resolve();
  expect(freshnessPool.count(1)).toBe(1);

  for (let generation = 2; generation <= CURRENT_METADATA_RETENTION + 2; generation++) {
    engine.setActive(generation);
    const page = service.suggest('a', 1);
    await freshnessPool.began(generation);
    freshnessPool.release(generation);
    expect((await page).as_of).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, generation)).toISOString());
  }

  engine.setActive(1);
  const afterEviction = service.suggest('a', 1);
  await freshnessPool.began(1, 2);
  expect(freshnessPool.count(1)).toBe(2);
  freshnessPool.release(1);
  expect((await pinned).as_of).toBe('2026-01-01T00:00:01.000Z');
  expect(await coalesced).toEqual(await pinned);
  freshnessPool.release(1);
  expect((await afterEviction).as_of).toBe('2026-01-01T00:00:01.000Z');
  expect(freshnessPool.consumers().every((consumer) => consumer.startsWith(`search_${prefix.replaceAll('-', '_')}`))).toBe(
    true,
  );
  expect(SUGGEST_TEMPLATE).toBe('subjects-suggest-v1');
});
