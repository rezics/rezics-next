import { expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  exportSitemaps,
  startDailySitemapExport,
  type SitemapExportFeed,
  type SitemapExportOptions,
  type SitemapObject,
  type SitemapStore,
  type SitemapStepRunner,
  type SitemapWriteCondition,
} from '../src/sitemap/export.ts';
import type { SitemapFamily } from '../src/sitemap/pack.ts';

const origin = 'https://public.example';
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const startTime = Date.parse('2026-10-20T03:00:00.000Z');
const encoder = new TextEncoder();

type Stored = SitemapObject & { body: Uint8Array };

class MemoryStore implements SitemapStore {
  readonly objects = new Map<string, Stored>();
  readonly counts = { head: 0, get: 0, put: 0, list: 0, delete: 0 };
  readonly putKeys: string[] = [];
  time = startTime;

  async head(key: string): Promise<SitemapObject | null> {
    this.counts.head += 1;
    const object = this.objects.get(key);
    return object ? { etag: object.etag, uploaded: object.uploaded } : null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.counts.get += 1;
    const object = this.objects.get(key);
    return object ? new Uint8Array(object.body) : null;
  }

  async put(key: string, value: string | Uint8Array, condition?: SitemapWriteCondition): Promise<SitemapObject | null> {
    this.counts.put += 1;
    this.putKeys.push(key);
    const previous = this.objects.get(key);
    if (condition?.ifMatch !== undefined && previous?.etag !== condition.ifMatch) return null;
    if (condition?.ifNoneMatch && previous) return null;
    const body = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
    const etag = await digest(body);
    const uploaded = new Date(this.time).toISOString();
    const stored = { etag, uploaded, body };
    this.objects.set(key, stored);
    return { etag, uploaded };
  }

  async list(prefix: string): Promise<SitemapObject[]> {
    this.counts.list += 1;
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, etag: object.etag, uploaded: object.uploaded }));
  }

  async delete(key: string): Promise<void> {
    this.counts.delete += 1;
    this.objects.delete(key);
  }

  text(key: string): string {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing ${key}`);
    return new TextDecoder().decode(object.body);
  }
}

class MemorySteps implements SitemapStepRunner {
  readonly calls: string[] = [];
  readonly attempts = new Map<string, number>();
  maxFamilies = 0;
  before?: (name: string) => Promise<void>;

  async do<T>(
    name: string,
    run: () => Promise<T>,
    retry: { limit: number; delay: (error: unknown, retry: number) => number },
  ): Promise<T> {
    this.calls.push(name);
    await this.before?.(name);
    for (let attempt = 0; ; attempt += 1) {
      this.attempts.set(name, (this.attempts.get(name) ?? 0) + 1);
      try {
        return await run();
      } catch (error) {
        if (attempt >= retry.limit) throw error;
        retry.delay(error, attempt + 1);
      }
    }
  }
}

function family(id: string, lastmod = '2026-10-19T00:00:00.000Z'): SitemapFamily {
  return {
    paths: Object.fromEntries(locales.map((locale) => [locale, `/subjects/${id}-${locale}`])) as SitemapFamily['paths'],
    lastmod,
  };
}

function pagesFeed(
  type: string,
  pages: readonly { items: string[]; next: string | null }[],
): SitemapExportFeed<string> & {
  cursors: (string | null)[];
} {
  const cursors: (string | null)[] = [];
  const byCursor = new Map<string | null, number>();
  let input: string | null = null;
  for (const [index, page] of pages.entries()) {
    byCursor.set(input, index);
    input = page.next;
  }
  return {
    type,
    cursors,
    async read(cursor) {
      cursors.push(cursor);
      const index = byCursor.get(cursor);
      if (index === undefined) throw new Error(`unexpected cursor ${cursor}`);
      return pages[index]!;
    },
    family: (id) => family(id),
  };
}

function options<Item>(store: MemoryStore, runner: MemorySteps, feeds: readonly SitemapExportFeed<Item>[], extra = {}) {
  return {
    runId: 'sitemaps-2026-10-20',
    origin,
    store,
    runner,
    feeds,
    now: () => new Date(store.time),
    ...extra,
  } satisfies SitemapExportOptions;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function listedPaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!);
}

async function listedFamilies(store: MemoryStore, type: string): Promise<string[]> {
  const paths = listedPaths(store.text('index.xml'));
  const keys = paths
    .map((path) => new URL(path).pathname)
    .filter((path) => path.startsWith(`/sitemap-${type}-`))
    .map((path) => `shards/${path.slice('/sitemap-'.length)}`);
  const found: string[] = [];
  for (const key of keys) {
    const body = await store.get(key);
    if (!body) throw new Error(`index listed missing ${key}`);
    const xml = gunzipSync(body).toString('utf8');
    for (const match of xml.matchAll(/<loc>https:\/\/public\.example\/subjects\/([^<]+)-en<\/loc>/g)) {
      found.push(match[1]!);
    }
  }
  return found;
}

test('an export reads short and empty pages from three feeds until next is null and publishes each family once', async () => {
  const store = new MemoryStore();
  const runner = new MemorySteps();
  const subjects = pagesFeed('subjects', [
    { items: ['subject-a'], next: 's1' },
    { items: [], next: 's2' },
    { items: ['subject-b'], next: null },
  ]);
  const agents = pagesFeed('agents', [
    { items: [], next: 'a1' },
    { items: ['agent-a'], next: null },
  ]);
  const boards = pagesFeed('boards', [{ items: ['board-a', 'board-b'], next: null }]);

  await exportSitemaps(options(store, runner, [subjects, agents, boards]));

  expect(subjects.cursors).toEqual([null, 's1', 's2']);
  expect(agents.cursors).toEqual([null, 'a1']);
  expect(boards.cursors).toEqual([null]);
  const indexPaths = listedPaths(store.text('index.xml')).map((path) => new URL(path).pathname);
  for (const type of ['subjects', 'agents', 'boards']) {
    const ownFiles = indexPaths.filter((path) => path.startsWith(`/sitemap-${type}-`));
    expect(ownFiles.length).toBeGreaterThan(0);
    expect(new Set(ownFiles).size).toBe(ownFiles.length);
    expect(await listedFamilies(store, type)).toEqual(
      type === 'subjects' ? ['subject-a', 'subject-b'] : type === 'agents' ? ['agent-a'] : ['board-a', 'board-b'],
    );
  }
});

test('unchanged files keep their upload time, and changing one feed rewrites only that feed file', async () => {
  const store = new MemoryStore();
  const firstFeeds = [
    pagesFeed('subjects', [{ items: ['subject-a'], next: null }]),
    pagesFeed('agents', [{ items: ['agent-a'], next: null }]),
  ];
  await exportSitemaps(options(store, new MemorySteps(), firstFeeds));
  const before = new Map(
    [...store.objects].filter(([key]) => key.startsWith('shards/')).map(([key, object]) => [key, object.uploaded]),
  );
  const shardPuts = store.putKeys.filter((key) => key.startsWith('shards/')).length;

  store.time += 24 * 60 * 60 * 1000;
  await exportSitemaps(
    options(store, new MemorySteps(), [
      pagesFeed('subjects', [{ items: ['subject-a'], next: null }]),
      pagesFeed('agents', [{ items: ['agent-a'], next: null }]),
    ]),
  );
  expect(store.putKeys.filter((key) => key.startsWith('shards/')).length - shardPuts).toBe(0);
  for (const [key, uploaded] of before) expect(store.objects.get(key)?.uploaded).toBe(uploaded);

  const putsBeforeChange = store.putKeys.filter((key) => key.startsWith('shards/')).length;
  store.time += 24 * 60 * 60 * 1000;
  const changed = pagesFeed('agents', [{ items: ['agent-a'], next: null }]);
  changed.family = () => family('agent-a', '2026-10-22T00:00:00.000Z');
  await exportSitemaps(
    options(store, new MemorySteps(), [pagesFeed('subjects', [{ items: ['subject-a'], next: null }]), changed]),
  );
  const changedShardPuts = store.putKeys.filter((key) => key.startsWith('shards/')).length - putsBeforeChange;
  expect(changedShardPuts).toBe(1);
  const current = listedPaths(store.text('index.xml')).map((path) => new URL(path).pathname);
  expect(current.filter((path) => path.startsWith('/sitemap-subjects-'))).toEqual(
    [...before.keys()]
      .filter((key) => key.startsWith('shards/subjects-'))
      .map((key) => `/sitemap-${key.slice('shards/'.length)}`),
  );
  expect(current.filter((path) => path.startsWith('/sitemap-agents-'))).toHaveLength(1);
});

test('a feed that fails after retries leaves the previous index and every file it lists untouched', async () => {
  const store = new MemoryStore();
  await exportSitemaps(options(store, new MemorySteps(), [pagesFeed('subjects', [{ items: ['old'], next: null }])]));
  const previousIndex = store.text('index.xml');
  const previousFiles = [...store.objects]
    .filter(([key]) => key.startsWith('shards/'))
    .map(([key, object]) => [key, new Uint8Array(object.body)] as const);

  const pages = Array.from({ length: 20 }, (_, index) => ({
    items: index === 0 ? ['new'] : [],
    next: `p${index + 1}`,
  }));
  const cursors: (string | null)[] = [];
  const failing: SitemapExportFeed<string> = {
    type: 'subjects',
    async read(cursor) {
      cursors.push(cursor);
      if (cursor === 'p20') throw Object.assign(new Error('upstream unavailable'), { status: 503 });
      const index = cursor === null ? 0 : Number(cursor.slice(1));
      return pages[index]!;
    },
    family: (id) => family(id),
  };
  store.time += 60_000;
  const runner = new MemorySteps();
  await expect(exportSitemaps(options(store, runner, [failing]))).rejects.toThrow(/upstream unavailable/);

  expect(runner.calls).toHaveLength(2);
  expect(runner.attempts.get(runner.calls[1]!)).toBe(6);
  expect(cursors.filter((cursor) => cursor === 'p20')).toHaveLength(6);
  expect(store.text('index.xml')).toBe(previousIndex);
  for (const [key, body] of previousFiles) expect(store.objects.get(key)?.body).toEqual(body);
});

test('a rejected cursor restarts that feed once, while a repeated cursor and a second rejection fail', async () => {
  const store = new MemoryStore();
  let rejected = false;
  const restart: SitemapExportFeed<string> = {
    type: 'subjects',
    async read(cursor) {
      if (cursor === 'rejected' && !rejected) {
        rejected = true;
        throw Object.assign(new Error('cursor rejected'), { status: 400 });
      }
      if (cursor === null) return { items: ['subject-a'], next: rejected ? null : 'rejected' };
      throw new Error(`unexpected cursor ${cursor}`);
    },
    family: (id) => family(id),
  };
  await exportSitemaps(options(store, new MemorySteps(), [restart]));
  expect(await listedFamilies(store, 'subjects')).toEqual(['subject-a']);

  const repeated = pagesFeed('subjects', [
    { items: ['once'], next: 'repeat' },
    { items: ['twice'], next: 'repeat' },
  ]);
  await expect(exportSitemaps(options(new MemoryStore(), new MemorySteps(), [repeated]))).rejects.toThrow(
    /repeated cursor/i,
  );

  let rejections = 0;
  const twice: SitemapExportFeed<string> = {
    type: 'subjects',
    async read(cursor) {
      if (cursor === null) return { items: ['subject-a'], next: rejections === 0 ? 'first' : 'second' };
      rejections += 1;
      throw Object.assign(new Error('cursor rejected'), { status: 400 });
    },
    family: (id) => family(id),
  };
  await expect(exportSitemaps(options(new MemoryStore(), new MemorySteps(), [twice]))).rejects.toThrow(
    /rejected.*twice|twice.*rejected/i,
  );
  expect(rejections).toBe(2);
});

test('daily starts use one UTC id, and an export with an older index ETag cannot replace a newer publication', async () => {
  const created: string[] = [];
  const workflow = {
    async create({ id }: { id: string }) {
      if (created.includes(id)) throw Object.assign(new Error('instance already exists'), { code: 409 });
      created.push(id);
    },
  };
  expect(await startDailySitemapExport(workflow, Date.parse('2026-10-20T03:00:00.000Z'))).toBe(true);
  expect(await startDailySitemapExport(workflow, Date.parse('2026-10-20T22:00:00.000Z'))).toBe(false);
  expect(created).toEqual(['sitemaps-2026-10-20']);

  const store = new MemoryStore();
  await exportSitemaps(
    options(store, new MemorySteps(), [pagesFeed('subjects', [{ items: ['initial'], next: null }])]),
  );
  const blocked = new MemorySteps();
  let entered!: () => void;
  let release!: () => void;
  const isEntered = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  blocked.before = async () => {
    entered();
    await gate;
  };
  store.time += 60_000;
  const stale = exportSitemaps(options(store, blocked, [pagesFeed('subjects', [{ items: ['stale'], next: null }])]));
  await isEntered;
  await exportSitemaps(
    options(store, new MemorySteps(), [pagesFeed('subjects', [{ items: ['newer'], next: null }])], {
      runId: 'manual-newer-run',
    }),
  );
  const newerIndex = store.text('index.xml');
  release();
  await expect(stale).rejects.toThrow(/stale|conditional|index/i);
  expect(store.text('index.xml')).toBe(newerIndex);
  expect(await listedFamilies(store, 'subjects')).toEqual(['newer']);
});

test('unlisted shard files are kept until seven days after their last published listing', async () => {
  const store = new MemoryStore();
  const run = async (runId: string, ids: string[]) => {
    await exportSitemaps(
      options(store, new MemorySteps(), [pagesFeed('subjects', [{ items: ids, next: null }])], { runId }),
    );
  };
  await run('day-zero', ['old', 'kept']);
  const oldFile = [...store.objects.keys()].find((key) => key.startsWith('shards/subjects-'))!;
  store.time += 6 * 24 * 60 * 60 * 1000;
  await run('day-six', ['kept']);
  expect(store.objects.has(oldFile)).toBe(true);
  store.time += 24 * 60 * 60 * 1000;
  await run('day-seven', ['kept']);
  expect(store.objects.has(oldFile)).toBe(false);
});

test('feed reads, R2 operations and bounded step batches grow linearly through 300,000 families', async () => {
  const metrics: { families: number; reads: number; r2: number; steps: number; held: number }[] = [];
  for (const size of [3_000, 30_000, 300_000]) {
    const store = new MemoryStore();
    const runner = new MemorySteps();
    let reads = 0;
    let packed = 0;
    const feed: SitemapExportFeed<number> = {
      type: 'subjects',
      async read(cursor) {
        reads += 1;
        const start = cursor === null ? 0 : Number(cursor);
        const end = Math.min(start + 1_000, size);
        return {
          items: Array.from({ length: end - start }, (_, offset) => start + offset),
          next: end < size ? String(end) : null,
        };
      },
      family: (id) => family(String(id)),
    };
    await exportSitemaps(
      options(store, runner, [feed], {
        runId: `growth-${size}`,
        pack: async (_origin: string, families: readonly SitemapFamily[]) => {
          runner.maxFamilies = Math.max(runner.maxFamilies, families.length);
          packed += 1;
          const digestValue = String(packed).padStart(24, '0');
          return [
            {
              digest: digestValue,
              families: families.length,
              urls: families.length * 8,
              bytes: families.length,
              gzip: new Uint8Array([packed & 255]),
            },
          ];
        },
      }),
    );
    metrics.push({
      families: size,
      reads,
      r2: store.counts.head + store.counts.get + store.counts.put + store.counts.list + store.counts.delete,
      steps: runner.calls.length,
      held: runner.maxFamilies,
    });
  }

  expect(metrics.map(({ families }) => families)).toEqual([3_000, 30_000, 300_000]);
  expect(metrics.map(({ reads }) => reads)).toEqual([3, 30, 300]);
  expect(metrics.map(({ steps }) => steps)).toEqual([2, 15, 150]);
  expect(metrics.every(({ held }) => held <= 3_000)).toBe(true);
  for (const field of ['reads', 'r2', 'steps'] as const) {
    const firstRatio = metrics[1]![field] / metrics[0]![field];
    const secondRatio = metrics[2]![field] / metrics[1]![field];
    expect(firstRatio).toBeGreaterThanOrEqual(7);
    expect(firstRatio).toBeLessThanOrEqual(12);
    expect(secondRatio).toBeGreaterThanOrEqual(7);
    expect(secondRatio).toBeLessThanOrEqual(12);
  }
});
