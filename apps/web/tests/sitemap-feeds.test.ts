import { expect, mock, test } from 'bun:test';
import {
  exportSitemapFeed,
  exportSitemapFeedSegment,
  type SitemapExportFeed,
  type SitemapExportOptions,
  type SitemapObject,
  type SitemapStore,
  type SitemapStepRunner,
  type SitemapWriteCondition,
} from '../src/sitemap/export.ts';
import type { SitemapFamily } from '../src/sitemap/pack.ts';

const origin = 'https://public.example';
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const lastModified = '2026-10-19T00:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000001';

type FeedName = 'boards' | 'threads' | 'realms' | 'spaces';

const samplePages: Record<FeedName, { items: Record<string, unknown>[]; next: string }> = {
  boards: { items: [{ id, lastModified }], next: 'boards-next' },
  threads: { items: [{ id, title: 'A discussion?', lastModified }], next: 'threads-next' },
  realms: { items: [{ id, lastModified }], next: 'realms-next' },
  spaces: { items: [{ id, address: 'sample-space', lastModified }], next: 'spaces-next' },
};
const endpointCalls: { feed: FeedName; query: Record<string, unknown> }[] = [];

mock.module('../src/kernel/client.ts', () => ({
  kernelClient() {
    return {
      sitemap: Object.fromEntries(
        (Object.keys(samplePages) as FeedName[]).map((feed) => [
          feed,
          {
            async get({ query }: { query: Record<string, unknown> }) {
              endpointCalls.push({ feed, query });
              return { status: 200, data: samplePages[feed] };
            },
          },
        ]),
      ),
    };
  },
}));

function family(path: string, time?: string): SitemapFamily {
  return {
    paths: Object.fromEntries(locales.map((locale) => [locale, `/${locale}${path}`])) as SitemapFamily['paths'],
    ...(time === undefined ? {} : { lastmod: time }),
  };
}

function keyedId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

class MemoryStore implements SitemapStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly stateSizes: number[] = [];

  async head(key: string): Promise<SitemapObject | null> {
    const body = this.objects.get(key);
    return body ? { key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' } : null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const body = this.objects.get(key);
    return body ? new Uint8Array(body) : null;
  }

  async put(
    key: string,
    value: string | Uint8Array,
    _condition?: SitemapWriteCondition,
  ): Promise<SitemapObject | null> {
    const body = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, body);
    if (key.includes('/state/')) this.stateSizes.push(body.length);
    return { key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' };
  }

  async list(prefix: string): Promise<SitemapObject[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' }));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class MemorySteps implements SitemapStepRunner {
  async do<T>(
    _name: string,
    run: () => Promise<T>,
    retry: { limit: number; delay(error: unknown, attempt: number): number; shouldRetry(error: unknown): boolean },
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= retry.limit || !retry.shouldRetry(error)) throw error;
        retry.delay(error, attempt + 1);
      }
    }
  }
}

function exportOptions<Item>(store: MemoryStore, runner: MemorySteps, feed: SitemapExportFeed<Item>) {
  return {
    runId: 'sitemaps-2026-10-20',
    origin,
    store,
    runner,
    feeds: [feed],
    pack: async () => [],
  } satisfies SitemapExportOptions<Item>;
}

test('sitemapFeeds loads board, thread, Realm and Space feeds with canonical page families', async () => {
  const endpointModule = await import('../src/sitemap/feeds.ts');
  const { threadHref } = await import('../src/threads/thread-href.ts');
  const feeds = endpointModule.sitemapFeeds();
  expect(feeds.map(({ type }) => type).sort()).toEqual(['boards', 'realms', 'spaces', 'threads']);

  const paths: Record<FeedName, string> = {
    boards: `/boards/${id}`,
    threads: threadHref({ id, title: 'A discussion?' }),
    realms: `/realms/${id}`,
    spaces: '/spaces/sample-space',
  };
  endpointCalls.length = 0;
  for (const feed of feeds) {
    const type = feed.type as FeedName;
    const page = await feed.read(`${type}-cursor`);
    expect(page).toEqual(samplePages[type]);
    expect(endpointCalls.at(-1)).toEqual({ feed: type, query: { cursor: `${type}-cursor`, limit: 1_000 } });
    const item = page.items[0] as Record<string, unknown>;
    expect(feed.family(item)).toEqual(family(paths[type], lastModified));
    expect(feed.family({ ...item, lastModified: undefined })).toEqual(family(paths[type]));
  }
});

test('random opaque cursors do not stop advancing feeds, and reads stay at one per 1,000 items', async () => {
  for (const size of [10, 1_000, 100_000]) {
    const offsets = new Map<string, number>();
    let reads = 0;
    let issued = 0;
    let packed = 0;
    const feed: SitemapExportFeed<number> & { key(item: number): string } = {
      type: 'boards',
      key: (item) => `${keyedId(item).slice(24, 28)}${keyedId(item)}`,
      async read(cursor) {
        reads += 1;
        const start = cursor === null ? 0 : offsets.get(cursor);
        if (start === undefined) throw new Error(`unexpected cursor ${cursor}`);
        const end = Math.min(start + 1_000, size);
        const items = Array.from({ length: end - start }, (_, index) => start + index);
        let next: string | null = null;
        if (end < size) {
          next = `salt-${crypto.randomUUID()}-${issued++}`;
          offsets.set(next, end);
        }
        return { items, next };
      },
      family: (item) => {
        packed += 1;
        return family(`/boards/${keyedId(item)}`, lastModified);
      },
    };
    const store = new MemoryStore();
    await exportSitemapFeed(`growth-${size}`, feed, {
      ...exportOptions(store, new MemorySteps(), feed),
      pack: async (_origin, families) => {
        packed = Math.max(packed, 0);
        expect(families.length).toBeGreaterThan(0);
        return [];
      },
    });
    expect(reads).toBe(Math.ceil(size / 1_000));
    expect(packed).toBe(size);
  }
});

test('keyed segment state stays bounded as the feed grows', async () => {
  const sizes: number[] = [];
  for (const size of [10, 1_000, 100_000]) {
    const dataPages = Math.ceil(size / 1_000);
    const emptyPages = 25;
    const positions = new Map<string, number>();
    const feed: SitemapExportFeed<{ id: string }> & { key(item: { id: string }): string } = {
      type: 'boards',
      key: ({ id: itemId }) => `${itemId.slice(24, 28)}${itemId}`,
      async read(cursor) {
        const position = cursor === null ? 0 : positions.get(cursor);
        if (position === undefined) throw new Error(`unexpected cursor ${cursor}`);
        const items =
          position < dataPages
            ? Array.from({ length: Math.min(1_000, size - position * 1_000) }, (_, index) => ({
                id: keyedId(position * 1_000 + index),
              }))
            : [];
        const hasNext = position + 1 < dataPages + emptyPages;
        const next = hasNext ? `t${String(position + 1).padStart(8, '0')}` : null;
        if (next !== null) positions.set(next, position + 1);
        return { items, next };
      },
      family: () => family('/boards/example', lastModified),
    };
    const store = new MemoryStore();
    const options = exportOptions(store, new MemorySteps(), feed);
    let segment = 0;
    while (!(await exportSitemapFeedSegment(`state-${size}`, feed, options, segment, 1))) segment += 1;
    expect(store.stateSizes.length).toBeGreaterThan(0);
    sizes.push(Math.max(...store.stateSizes));
  }
  expect(sizes[1]).toBe(sizes[0]);
  expect(sizes[2]).toBe(sizes[0]);
});

test('item-order stalls fail for keyed feeds and repeated thread ids, regardless of cursor tokens', async () => {
  const badKeyedFeed = (
    type: 'boards' | 'realms' | 'spaces',
  ): SitemapExportFeed<{ id: string }> & {
    key(item: { id: string }): string;
  } => {
    const items = [{ id: keyedId(2) }, { id: keyedId(1) }];
    return {
      type,
      key: ({ id: itemId }) => `${itemId.slice(24, 28)}${itemId}`,
      async read(cursor) {
        return cursor === null
          ? { items: [items[0]!], next: `random-${type}-one` }
          : { items: [items[1]!], next: null };
      },
      family: () => family(`/${type}/example`, lastModified),
    };
  };
  for (const type of ['boards', 'realms', 'spaces'] as const) {
    const feed = badKeyedFeed(type);
    await expect(
      exportSitemapFeed(`bad-${type}`, feed, exportOptions(new MemoryStore(), new MemorySteps(), feed)),
    ).rejects.toThrow(new RegExp(`feed ${type}.*progress`, 'i'));
  }

  const threads: SitemapExportFeed<{ id: string }> = {
    type: 'threads',
    async read(cursor) {
      return cursor === null ? { items: [{ id }], next: 'thread-random-one' } : { items: [{ id }], next: null };
    },
    family: () => family(`/threads/${id}/thread`, lastModified),
  };
  await expect(
    exportSitemapFeed('bad-threads', threads, exportOptions(new MemoryStore(), new MemorySteps(), threads)),
  ).rejects.toThrow(/feed threads.*progress/i);
});

test('an expired 400 cursor still restarts the feed exactly once', async () => {
  const cursors: (string | null)[] = [];
  let restarted = false;
  const feed: SitemapExportFeed<string> = {
    type: 'boards',
    async read(cursor) {
      cursors.push(cursor);
      if (cursor === 'expired-token' && !restarted) {
        restarted = true;
        throw Object.assign(new Error('cursor expired'), { status: 400 });
      }
      return cursor === null
        ? { items: ['board'], next: restarted ? null : 'expired-token' }
        : { items: ['board'], next: null };
    },
    family: () => family('/boards/example', lastModified),
  };
  await exportSitemapFeed('expired-cursor', feed, exportOptions(new MemoryStore(), new MemorySteps(), feed));
  expect(cursors).toEqual([null, 'expired-token', null]);
});
