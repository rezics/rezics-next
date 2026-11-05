import { expect, mock, test } from 'bun:test';
import { createKernelClient, type Kernel } from '@rezics/client';
import type { SitemapObject, SitemapStore, SitemapStepRunner } from '../src/sitemap/export.ts';
import type { SitemapFamily } from '../src/sitemap/pack.ts';

type AgentPage = Kernel['~Routes']['v1']['agent-pages']['get']['response'][200];
const lastModified = '2026-10-29T12:34:56.789+01:00';
const cursor = 'signed.payload/+?=%2F.signature';
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const requests: { url: URL; method: string; headers: Headers }[] = [];
let respond: (url: URL) => { status: number; body: unknown };
const client = createKernelClient('https://kernel.example', {
  fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const { status, body } = respond(url);
    return Response.json(body, { status });
  },
});

mock.module('../src/kernel/client.ts', () => ({ kernelClient: () => client }));
const { feed } = await import('../src/sitemap/feeds/agents.ts');
const { sitemapFeeds } = await import('../src/sitemap/feeds.ts');
const { exportSitemapFeed, exportSitemaps } = await import('../src/sitemap/export.ts');

class MemoryStore implements SitemapStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: string[] = [];

  async head(key: string): Promise<SitemapObject | null> {
    return this.objects.has(key) ? { etag: 'stored', uploaded: '2026-10-30T00:00:00.000Z' } : null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, value: string | Uint8Array): Promise<SitemapObject> {
    this.writes.push(key);
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
    return { etag: 'stored', uploaded: '2026-10-30T00:00:00.000Z' };
  }

  async list(prefix: string): Promise<SitemapObject[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, etag: 'stored', uploaded: '2026-10-30T00:00:00.000Z' }));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const runner: SitemapStepRunner = { do: (_name, run) => run() };
const options = (store: MemoryStore) => ({
  runId: 'agent-inventory',
  origin: 'https://public.example',
  store,
  runner,
  feeds: [feed],
});
const agentPages: AgentPage['agentPages'] = [
  { handle: 'Z', kind: 'actor', lastModified },
  { handle: 'Existing_Org-', kind: 'organization', lastModified },
];

test('actual public agent inventory yields bounded locale URL families and typed failures preserve the existing index', async () => {
  expect(sitemapFeeds().map(({ type }) => type)).toEqual([
    'agents',
    'boards',
    'collections',
    'realms',
    'spaces',
    'subjects',
    'threads',
  ]);
  expect(sitemapFeeds().filter(({ type }) => type === 'agents')).toEqual([feed]);
  expect(feed.key).toBeUndefined();

  for (const size of [1, 1_000]) {
    const source: AgentPage = {
      agentPages: Array.from({ length: size }, (_, index) =>
        index < agentPages.length ? agentPages[index]! : { handle: `agent_${index}`, kind: 'actor', lastModified },
      ),
      next: cursor,
    };
    respond = () => ({ status: 200, body: source });
    requests.length = 0;
    const page = await feed.read(cursor);
    expect(page.next).toBe(cursor);
    expect(page.items).toHaveLength(size);
    for (const [index, item] of page.items.entries()) {
      expect(item).toEqual({ ...source.agentPages[index], id: source.agentPages[index]!.handle });
      const family = feed.family(item)!;
      expect(family.paths).toEqual(
        Object.fromEntries(locales.map((locale) => [locale, `/${locale}/@${source.agentPages[index]!.handle}`])),
      );
      expect(family.lastmod).toBe(lastModified);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.origin).toBe('https://kernel.example');
    expect(requests[0]!.url.pathname).toBe('/v1/agent-pages');
    expect([...requests[0]!.url.searchParams]).toEqual([
      ['cursor', cursor],
      ['limit', '1000'],
    ]);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(requests[0]!.headers.has('rezics-session-token')).toBe(false);
  }

  for (const [status, code] of [
    [400, 'invalid_request'],
    [400, 'invalid_cursor'],
    [403, 'permission_denied'],
    [503, 'unavailable'],
  ] as const) {
    // Even a failure carrying an empty-looking inventory must remain a typed failure.
    const problem = { code, agentPages: [], next: null };
    respond = () => ({ status, body: problem });
    await expect(feed.read(cursor)).rejects.toMatchObject({ status, problem });

    const store = new MemoryStore();
    await store.put('index.xml', 'previous index');
    await store.put('shards/previous.xml.gz', 'previous shard');
    const previous = new Map(store.objects);
    store.writes.length = 0;
    // Discovery can fail after a valid first page; staging must never replace the public index.
    respond = (url) =>
      url.searchParams.has('cursor')
        ? { status, body: problem }
        : { status: 200, body: { agentPages, next: cursor } satisfies AgentPage };
    await expect(exportSitemaps(options(store))).rejects.toThrow();
    for (const [key, bytes] of previous) expect(store.objects.get(key)).toEqual(bytes);
    expect(store.writes).not.toContain('index.xml');
    expect(store.objects.has('runs/agent-inventory/published.json')).toBe(false);
  }
});

test('sparse agent pages keep signed cursors and native order without prefetch or identity hydration', async () => {
  const sparseCursor = 'signed.empty-page.next';
  respond = (url) => ({
    status: 200,
    body:
      url.searchParams.get('cursor') === cursor
        ? { agentPages: [], next: sparseCursor }
        : url.searchParams.get('cursor') === sparseCursor
          ? { agentPages: [agentPages[1]], next: null }
          : { agentPages: [agentPages[0]], next: cursor },
  });
  requests.length = 0;
  expect(await feed.read(cursor)).toEqual({ items: [], next: sparseCursor });
  expect(requests).toHaveLength(1);

  requests.length = 0;
  const packed: SitemapFamily[] = [];
  const store = new MemoryStore();
  await exportSitemapFeed('agent-inventory', feed, {
    ...options(store),
    pack: async (_origin, families) => {
      packed.push(...families);
      return [];
    },
  });
  expect(packed.map((family) => family.paths.en)).toEqual(['/en/@Z', '/en/@Existing_Org-']);
  expect(requests.map(({ url }) => url.pathname)).toEqual(Array(3).fill('/v1/agent-pages'));
  expect(requests.map(({ url }) => url.searchParams.get('cursor'))).toEqual([null, cursor, sparseCursor]);
  expect(requests.every(({ url }) => url.searchParams.get('limit') === '1000')).toBe(true);
});

test('invalid agent inventories fail replacement and invalid publication times are omitted without guessing', async () => {
  const invalidBodies: unknown[] = [
    null,
    { agentPages: [] },
    { agentPages: [], next: 12 },
    { agentPages: [], next: '' },
    { agentPages: [], next: null, code: 'unavailable' },
    { agentPages: [{ ...agentPages[0], kind: 'subject' }], next: null },
    { agentPages: [{ handle: 'valid', kind: 'actor' }], next: null },
    { agentPages: Array(1_001).fill(agentPages[0]), next: null },
    ...['', '_leading', 'with space', 'slash/name', 'encoded%2Fname', '非ASCII', 'trailing\n', 'a'.repeat(65)].map(
      (handle) => ({ agentPages: [{ ...agentPages[0], handle }], next: null }),
    ),
  ];
  for (const body of invalidBodies) {
    respond = () => ({ status: 200, body });
    const store = new MemoryStore();
    await store.put('index.xml', 'previous index');
    const previous = store.objects.get('index.xml');
    store.writes.length = 0;
    await expect(exportSitemaps(options(store))).rejects.toMatchObject({ status: 502 });
    expect(store.objects.get('index.xml')).toEqual(previous);
    expect(store.writes).not.toContain('index.xml');
    expect(store.objects.has('runs/agent-inventory/published.json')).toBe(false);
  }

  for (const time of ['', 'unknown', '2026-02-30T00:00:00Z', '2026-10-29T12:00:00']) {
    respond = () => ({ status: 200, body: { agentPages: [{ ...agentPages[0], lastModified: time }], next: null } });
    const page = await feed.read(null);
    expect(page.items[0]!.lastModified).toBe(time);
    expect(feed.family(page.items[0]!)!.lastmod).toBeUndefined();
  }

  const unavailable = new Error('Agent inventory transport unavailable');
  respond = () => {
    throw unavailable;
  };
  await expect(feed.read(null)).rejects.toBe(unavailable);
});
