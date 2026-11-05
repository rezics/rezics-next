import { expect, mock, test } from 'bun:test';
import type { Kernel } from '@rezics/client';
import type { SitemapFeed } from '../src/sitemap/feeds.ts';
import type {
  SitemapExportFeed,
  SitemapExportOptions,
  SitemapObject,
  SitemapStore,
  SitemapStepRunner,
  SitemapWriteCondition,
} from '../src/sitemap/export.ts';
import type { SitemapFamily } from '../src/sitemap/pack.ts';

mock.module('../src/sitemap/pack.ts', () => ({
  packShards: async () => [],
  sitemapIndexXml: () => '',
}));

const { exportSitemapFeed, exportSitemapFeedSegment, exportSitemaps } = await import('../src/sitemap/export.ts');

const origin = 'https://public.example';
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const lastModified = '2026-10-19T00:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000001';

type FeedName = 'boards' | 'threads' | 'realms' | 'spaces';
type SourceName = FeedName | 'agents' | 'collections' | 'subjects';

const samplePages: Record<FeedName, { items: Record<string, unknown>[]; next: string }> = {
  boards: { items: [{ id, lastModified }], next: 'boards-next' },
  threads: { items: [{ id, title: 'A discussion?', lastModified }], next: 'threads-next' },
  realms: { items: [{ id, lastModified, canonicalDestination: { kind: 'realm', realmId: id } }], next: 'realms-next' },
  spaces: { items: [{ id, address: 'sample-space', lastModified }], next: 'spaces-next' },
};
const subjectItem = {
  id,
  target: { family: 'subject' as const, subjectId: id },
  views: ['overview'],
  labels: [{ language: 'en', value: 'Sample subject' }],
  lastModified,
};
const nativePages = {
  ...samplePages,
  agents: { agentPages: [{ handle: 'CurrentHandle', kind: 'actor', lastModified }], next: 'agents-next' },
  collections: { items: [{ id, lastModified }], next: 'collections-next' },
  subjects: { subjectPages: [subjectItem], next: 'subjects-next' },
};
const endpointCalls: { feed: SourceName; query: Record<string, unknown> }[] = [];
let feedResponse:
  | ((feed: SourceName, query: Record<string, unknown>) => { status: number; data?: unknown })
  | undefined;

function endpoint(feed: SourceName) {
  return {
    async get({ query }: { query: Record<string, unknown> }) {
      endpointCalls.push({ feed, query });
      if (feedResponse) return feedResponse(feed, query);
      return { status: 200, data: nativePages[feed] };
    },
  };
}

mock.module('../src/kernel/client.ts', () => ({
  kernelClient() {
    return {
      'subject-pages': endpoint('subjects'),
      'agent-pages': endpoint('agents'),
      sitemap: Object.fromEntries(
        ([...Object.keys(samplePages), 'collections'] as SourceName[]).map((feed) => [feed, endpoint(feed)]),
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

  async list(prefix: string, cursor: string | null = null) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (cursor === null || key > cursor))
      .sort();
    const page = keys.slice(0, 1_000);
    return {
      objects: page.map((key) => ({ key, etag: 'etag', uploaded: '2026-10-20T00:00:00.000Z' })),
      cursor: keys.length > page.length ? page.at(-1)! : null,
    };
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

test('sitemapFeeds loads every registered feed including board, thread, Realm and Space canonical page families', async () => {
  const endpointModule = await import('../src/sitemap/feeds.ts');
  const { threadHref } = await import('../src/threads/thread-href.ts');
  const feeds = endpointModule.sitemapFeeds();
  expect(feeds.map(({ type }) => type).sort()).toEqual([
    'agents',
    'boards',
    'collections',
    'realms',
    'spaces',
    'subjects',
    'threads',
  ]);

  const paths: Record<SourceName, string> = {
    agents: '/@CurrentHandle',
    collections: `/collections/${id}`,
    subjects: `/subjects/${id}/sample-subject`,
    boards: `/boards/${id}`,
    threads: threadHref({ id, title: 'A discussion?' }),
    realms: `/realms/${id}`,
    spaces: '/spaces/sample-space',
  };
  endpointCalls.length = 0;
  for (const feed of feeds) {
    const type = feed.type as SourceName;
    const page = await feed.read(`${type}-cursor`);
    if (type === 'subjects') {
      const { subjectCanonicalPage } = await import('../src/sitemap/subject-canonical.ts');
      expect(page).toEqual(subjectCanonicalPage(nativePages.subjects));
    } else if (type === 'agents') {
      expect(page).toEqual({
        items: [{ ...nativePages.agents.agentPages[0], id: 'CurrentHandle' }],
        next: 'agents-next',
      });
    } else expect(page).toEqual(nativePages[type]);
    expect(endpointCalls.at(-1)).toEqual({ feed: type, query: { cursor: `${type}-cursor`, limit: 1_000 } });
    const item = page.items[0] as Record<string, unknown>;
    const meaningfulTime = ['agents', 'boards', 'subjects', 'threads'].includes(type) ? lastModified : undefined;
    expect(feed.family(item)).toEqual(family(paths[type], meaningfulTime));
    if (type === 'subjects') {
      const { subjectCanonicalPage } = await import('../src/sitemap/subject-canonical.ts');
      const unknownTime = subjectCanonicalPage({
        subjectPages: [{ ...subjectItem, lastModified: undefined }],
        next: null,
      }).items[0]!;
      expect(feed.family(unknownTime)).toEqual(family(paths[type]));
    } else expect(feed.family({ ...item, lastModified: undefined })).toEqual(family(paths[type]));
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

test('legacy segment state resumes without carrying cursor history into progress checks', async () => {
  const store = new MemoryStore();
  await store.put(
    'runs/legacy-state/state/boards.json',
    JSON.stringify({ segment: 1, cursor: 'resume-token', cursors: ['remembered-token'], restarted: false }),
  );
  const cursors: (string | null)[] = [];
  const feed: SitemapExportFeed<{ id: string }> & { key(item: { id: string }): string } = {
    type: 'boards',
    key: ({ id: itemId }) => `${itemId.slice(24, 28)}${itemId}`,
    async read(cursor) {
      cursors.push(cursor);
      if (cursor === 'resume-token') return { items: [{ id: keyedId(1) }], next: 'remembered-token' };
      if (cursor === 'remembered-token') return { items: [{ id: keyedId(2) }], next: null };
      throw new Error(`unexpected cursor ${cursor}`);
    },
    family: () => family('/boards/example', lastModified),
  };

  const completed = await exportSitemapFeedSegment(
    'legacy-state',
    feed,
    exportOptions(store, new MemorySteps(), feed),
    1,
  );
  expect(completed).toBe(true);
  expect(cursors).toEqual(['resume-token', 'remembered-token']);
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

test('default Community feeds consume actual tagged native canonical destinations and standalone Space inventory without hydration and retain sparse cursors raw items and unavailable replacement failure', async () => {
  const { feed: realms } = await import('../src/sitemap/feeds/realms.ts');
  const { feed: spaces } = await import('../src/sitemap/feeds/spaces.ts');
  type RealmPage = Kernel['~Routes']['v1']['sitemap']['realms']['get']['response'][200];
  type SpacePage = Kernel['~Routes']['v1']['sitemap']['spaces']['get']['response'][200];
  const carriedAddress = 'current space/空?#%';
  const standaloneAddress = 'standalone space/空?#%';
  const realmId = keyedId(20);
  const realmPage: RealmPage = {
    items: [
      {
        id: keyedId(1),
        lastModified,
        canonicalDestination: { kind: 'space', spaceId: keyedId(10), address: carriedAddress },
      },
      { id: keyedId(2), lastModified, canonicalDestination: { kind: 'realm', realmId } },
    ],
    next: 'opaque-source-cursor',
  };
  const spacePage: SpacePage = {
    items: [{ id: keyedId(3), address: standaloneAddress, lastModified }],
    next: 'opaque-source-cursor',
  };

  async function verify<Item extends { id: string }>(
    feed: SitemapFeed<Item>,
    source: { items: Item[]; next: string | null },
    paths: string[],
  ) {
    const sparse = { items: [], next: 'opaque-sparse-cursor' };
    const terminal = { items: [], next: null };
    feedResponse = (name, query) => {
      if (name !== feed.type) throw new Error(`Unexpected hydration read: ${name}`);
      const data =
        query.cursor === undefined
          ? source
          : query.cursor === source.next
            ? sparse
            : query.cursor === sparse.next
              ? terminal
              : undefined;
      if (!data) throw new Error(`Unexpected cursor: ${query.cursor}`);
      return { status: 200, data };
    };
    endpointCalls.length = 0;
    const page = await feed.read(null);
    expect(page).toBe(source);
    expect(page.items).toBe(source.items);
    expect(endpointCalls).toEqual([{ feed: feed.type, query: { limit: 1_000 } }]);
    // Both default adapters preserve the native page, ids and ordering key.
    page.items.forEach((item, index) => {
      expect(item).toBe(source.items[index]);
      expect(feed.key!(item)).toBe(`${item.id.slice(24, 28)}${item.id}`);
      expect(feed.family(item)).toEqual(family(paths[index]!));
    });
    expect(await feed.read(source.next)).toBe(sparse);
    expect(endpointCalls).toHaveLength(2);
    endpointCalls.length = 0;
    const packed: SitemapFamily[] = [];
    const store = new MemoryStore();
    const options = {
      ...exportOptions(store, new MemorySteps(), feed),
      pack: async (_origin: string, families: readonly SitemapFamily[]) => {
        packed.push(...families);
        return [];
      },
    };
    await exportSitemapFeed('default-community', feed, options);
    expect(endpointCalls).toEqual([
      { feed: feed.type, query: { limit: 1_000 } },
      { feed: feed.type, query: { cursor: source.next, limit: 1_000 } },
      { feed: feed.type, query: { cursor: sparse.next, limit: 1_000 } },
    ]);
    expect(packed).toEqual(paths.map((path) => family(path)));

    await store.put('index.xml', 'prior index');
    await store.put('shards/prior.xml.gz', 'prior shard');
    const previous = new Map(store.objects);
    for (const status of [503, 200]) {
      feedResponse = () => ({ status });
      await expect(exportSitemaps(options)).rejects.toMatchObject({ status });
      for (const [key, bytes] of previous) expect(store.objects.get(key)).toEqual(bytes);
      expect(store.objects.has(`runs/${options.runId}/published.json`)).toBe(false);
    }
    const transportError = new Error('Community transport unavailable');
    feedResponse = () => {
      throw transportError;
    };
    await expect(feed.read(null)).rejects.toBe(transportError);
  }

  try {
    await verify(realms, realmPage, [`/spaces/${encodeURIComponent(carriedAddress)}`, `/realms/${realmId}`]);
    await verify(spaces, spacePage, [`/spaces/${encodeURIComponent(standaloneAddress)}`]);
  } finally {
    feedResponse = undefined;
  }
});

test('default subject projection exports a full native window with multiple views inside existing packing bounds and retains the previous index on refusal', async () => {
  const { createSubjectFeed } = await import('../src/sitemap/feeds/subjects.ts');
  const feed = createSubjectFeed();
  const source = {
    subjectPages: Array.from({ length: 1_000 }, (_, index) => {
      const id = keyedId(index);
      return {
        ...subjectItem,
        id,
        target: { family: 'subject' as const, subjectId: id },
        views: ['overview', 'editions', 'credits', 'details'],
      };
    }),
    next: 'native-full-next',
  };
  const packed: SitemapFamily[] = [];
  const store = new MemoryStore();
  const options = {
    ...exportOptions(store, new MemorySteps(), feed),
    pack: async (_origin: string, families: readonly SitemapFamily[]) => {
      expect(families.length).toBeLessThanOrEqual(3_000);
      packed.push(...families);
      return [];
    },
  };
  feedResponse = (name, query) => {
    if (name !== 'subjects') throw new Error(`Unexpected hydration read: ${name}`);
    if (query.cursor === undefined) return { status: 200, data: source };
    if (query.cursor === source.next) return { status: 200, data: { subjectPages: [], next: 'native-empty-next' } };
    if (query.cursor === 'native-empty-next') return { status: 200, data: { subjectPages: [], next: null } };
    throw new Error(`Unexpected native cursor: ${query.cursor}`);
  };
  endpointCalls.length = 0;
  try {
    await exportSitemapFeed('default-subjects', feed, options);
    expect(endpointCalls).toEqual([
      { feed: 'subjects', query: { limit: 1_000 } },
      { feed: 'subjects', query: { cursor: source.next, limit: 1_000 } },
      { feed: 'subjects', query: { cursor: 'native-empty-next', limit: 1_000 } },
    ]);
    expect(packed).toEqual(
      source.subjectPages.flatMap(({ id }) =>
        ['', '/editions', '/credits', '/details'].map((view) =>
          family(`/subjects/${id}/sample-subject${view}`, lastModified),
        ),
      ),
    );
    await store.put('index.xml', 'prior index');
    await store.put('shards/prior.xml.gz', 'prior shard');
    const previous = new Map(store.objects);
    for (const unavailable of [
      { status: 503 },
      { status: 200, data: { subjectPages: [{ ...subjectItem, target: undefined }], next: null } },
      ...['posts', 'reviews', 'collections'].map((view) => ({
        status: 200,
        data: {
          subjectPages: [
            {
              ...subjectItem,
              target: { family: 'account', accountId: subjectItem.id, canonicalPath: '/@CurrentHandle' },
              views: ['overview', view],
            },
          ],
          next: null,
        },
      })),
    ]) {
      feedResponse = () => unavailable;
      await expect(exportSitemaps(options)).rejects.toMatchObject({ status: 503 });
      for (const [key, bytes] of previous) expect(store.objects.get(key)).toEqual(bytes);
      expect(store.objects.has(`runs/${options.runId}/published.json`)).toBe(false);
    }
    for (const next of ['opaque-repeat', 'different-opaque-repeat']) {
      feedResponse = () => ({ status: 200, data: { subjectPages: [subjectItem], next } });
      await expect(exportSitemapFeed('repeated-subject', feed, options)).rejects.toThrow(/subjects.*progress/iu);
    }
  } finally {
    feedResponse = undefined;
  }
});
