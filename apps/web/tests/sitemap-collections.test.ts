import { expect, mock, test } from 'bun:test';
import type { SitemapStore, SitemapWriteCondition } from '../src/sitemap/export.ts';

mock.module('../src/sitemap/pack.ts', () => ({ packShards: async () => [], sitemapIndexXml: () => '' }));

const { exportSitemapFeed } = await import('../src/sitemap/export.ts');

const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const id = '00000000-0000-4000-8000-000000000001';
const lastModified = '2026-10-19T00:00:00.000Z';
type FeedName = 'boards' | 'realms' | 'spaces' | 'threads' | 'collections';
type Page = { items: Record<string, unknown>[]; next: string | null };

const pages: Record<FeedName, Page> = {
  boards: { items: [{ id, lastModified }], next: null },
  realms: { items: [{ id, lastModified }], next: null },
  spaces: { items: [{ id, address: 'sample-space', lastModified }], next: null },
  threads: { items: [{ id, title: 'A discussion?', lastModified }], next: null },
  collections: { items: [{ id, lastModified }], next: null },
};
const calls: { feed: FeedName; query: Record<string, unknown> }[] = [];
const statuses: Partial<Record<FeedName, number>> = {};

mock.module('../src/kernel/client.ts', () => ({
  kernelClient() {
    return {
      sitemap: Object.fromEntries(
        (Object.keys(pages) as FeedName[]).map((feed) => [
          feed,
          {
            async get({ query }: { query: Record<string, unknown> }) {
              calls.push({ feed, query });
              const status = statuses[feed] ?? 200;
              return { status, ...(status === 200 ? { data: pages[feed] } : {}) };
            },
          },
        ]),
      ),
    };
  },
}));

class MemoryStore implements SitemapStore {
  readonly objects = new Map<string, Uint8Array>();

  async head(key: string) {
    return this.objects.has(key) ? { key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' } : null;
  }

  async get(key: string) {
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }

  async put(key: string, value: string | Uint8Array, _condition?: SitemapWriteCondition) {
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    return { key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' };
  }

  async list(prefix: string) {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' }));
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function expectedFamily(path: string, time?: string) {
  return {
    paths: Object.fromEntries(locales.map((locale) => [locale, `/${locale}${path}`])),
    ...(time === undefined ? {} : { lastmod: time }),
  };
}

test('collections feed is loaded from its module and fallback list, with existing feed output unchanged', async () => {
  const [{ feed: collections }, endpointModule, { threadHref }] = await Promise.all([
    import('../src/sitemap/feeds/collections.ts'),
    import('../src/sitemap/feeds.ts'),
    import('../src/threads/thread-href.ts'),
  ]);
  const feeds = endpointModule.sitemapFeeds();
  expect(feeds.map(({ type }) => type).sort()).toEqual(['boards', 'collections', 'realms', 'spaces', 'threads']);
  expect(feeds.find(({ type }) => type === collections.type)).toBeDefined();

  const paths: Record<Exclude<FeedName, 'collections'>, string> = {
    boards: `/boards/${id}`,
    realms: `/realms/${id}`,
    spaces: '/spaces/sample-space',
    threads: threadHref({ id, title: 'A discussion?' }),
  };
  calls.length = 0;
  for (const feed of feeds) {
    if (feed.type === 'collections') continue;
    const type = feed.type as Exclude<FeedName, 'collections'>;
    const page = await feed.read(null);
    const item = page.items[0] as Record<string, unknown>;
    expect(feed.family(item)).toEqual(expectedFamily(paths[type], lastModified));
    expect(feed.family({ ...item, lastModified: undefined })).toEqual(expectedFamily(paths[type]));
  }
  expect(calls.map(({ feed }) => feed)).toEqual(['boards', 'realms', 'spaces', 'threads']);

  const collectionPage = await collections.read(null);
  expect(calls.at(-1)).toEqual({ feed: 'collections', query: { limit: 1_000 } });
  expect(collections.family(collectionPage.items[0]!)).toEqual(expectedFamily(`/collections/${id}`, lastModified));
  expect(collections.family({ id })).toEqual(expectedFamily(`/collections/${id}`));
});

test('collection export follows every opaque cursor and reads once per page', async () => {
  const { feed } = await import('../src/sitemap/feeds/collections.ts');
  for (const pageCount of [1, 3]) {
    const cursors: (string | null)[] = [];
    const nextPages = Array.from({ length: pageCount }, (_, index) => ({
      items: [{ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }],
      next: index + 1 === pageCount ? null : `opaque-${index + 1}`,
    }));
    const original = pages.collections;
    pages.collections = nextPages[0]!;
    const pageByCursor = new Map<string | null, Page>([[null, nextPages[0]!]]);
    nextPages.forEach((page, index) => {
      if (index > 0) pageByCursor.set(`opaque-${index}`, page);
    });
    const originalGet = (await import('../src/sitemap/feeds/collections.ts')).feed.read;
    const pagedFeed = {
      ...feed,
      async read(cursor: string | null) {
        cursors.push(cursor);
        const page = pageByCursor.get(cursor);
        if (!page) throw new Error(`unexpected cursor ${cursor}`);
        pages.collections = page;
        return originalGet.call(feed, cursor);
      },
    };
    const runner = { async do<T>(_name: string, run: () => Promise<T>) { return run(); } };
    await exportSitemapFeed(`collections-${pageCount}`, pagedFeed, {
      runId: `collections-${pageCount}`,
      origin: 'https://public.example',
      store: new MemoryStore(),
      runner,
      feeds: [pagedFeed],
      pack: async () => [],
    });
    expect(cursors).toEqual(pageCount === 1 ? [null] : [null, 'opaque-1', 'opaque-2']);
    expect(calls.filter(({ feed: name }) => name === 'collections').slice(-pageCount).map(({ query }) => query.limit)).toEqual(
      Array(pageCount).fill(1_000),
    );
    pages.collections = original;
  }
});

test('a non-200 collection feed response rejects the export read', async () => {
  const { feed } = await import('../src/sitemap/feeds/collections.ts');
  const statusBefore = statuses.collections;
  statuses.collections = 503;
  const runner = { async do<T>(_name: string, run: () => Promise<T>) { return run(); } };
  try {
    await expect(
      exportSitemapFeed('collections-failed', feed, {
        runId: 'collections-failed',
        origin: 'https://public.example',
        store: new MemoryStore(),
        runner,
        feeds: [feed],
        pack: async () => [],
      }),
    ).rejects.toThrow('Sitemap feed collections returned 503');
  } finally {
    if (statusBefore === undefined) delete statuses.collections;
    else statuses.collections = statusBefore;
  };
});
