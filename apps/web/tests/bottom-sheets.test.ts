import { afterAll, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const digest = 'release-test-digest';
const asOf = '2026-10-01T00:00:00.000Z';
const book = 'schema:Book';
const author = 'schema:author';
const genre = 'schema:genre';
const authorOne = '00000000-0000-4000-8000-000000000123';
const authorTwo = '00000000-0000-4000-8000-000000000456';
const genreOne = 'wd:Q789';

const release = {
  types: {
    [book]: {
      labels: { en: 'book', es: 'libro', fr: 'livre' },
      bases: ['schema:CreativeWork'],
      facets: [author, genre],
    },
    'schema:CreativeWork': {
      labels: { en: 'creative work', es: 'obra creativa' },
      bases: [],
      facets: ['schema:datePublished'],
    },
    'schema:Recipe': { labels: { en: 'recipe', es: 'receta' }, bases: [], facets: [author] },
    'schema:Person': { labels: { en: 'person', es: 'persona' }, bases: [], facets: [] },
    [authorOne]: { labels: {}, bases: [book], facets: [] },
    [authorTwo]: { labels: {}, bases: ['schema:Recipe'], facets: [] },
  },
  properties: {
    [author]: { labels: { en: 'author', es: 'autor', fr: 'auteur' }, datatype: 'wikibase-item' },
    [genre]: {
      labels: { en: 'genre', es: 'género', fr: 'genre' },
      datatype: 'string',
      value: { pattern: '^wd:Q[0-9]+$' },
    },
    'schema:datePublished': { labels: { en: 'publication date' }, datatype: 'time' },
  },
};

const calls: { method: string; path: string; query: string | null; body: any }[] = [];
let failFacets = false;
let emptySearch = false;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/definitions/active' && request.method === 'GET') {
      calls.push({ method: request.method, path: url.pathname, query: null, body: null });
      return json({ digest });
    }
    if (url.pathname === `/v1/definitions/releases/${digest}` && request.method === 'GET') {
      calls.push({ method: request.method, path: url.pathname, query: null, body: null });
      return json({ digest, release }, 200, {
        etag: `"${digest}"`,
        'cache-control': 'public, max-age=31536000, immutable',
      });
    }
    if (url.pathname === '/v1/subjects:search' && request.method === 'POST') {
      const body = await request.json();
      calls.push({ method: request.method, path: url.pathname, query: null, body });
      return json({
        subjects: emptySearch
          ? []
          : [{ id: '00000000-0000-4000-8000-000000000111', type: book, labels: { en: 'Kokoro', es: 'Kokoro' } }],
        total: { value: 1, relation: 'exact' },
        next: null,
        as_of: asOf,
      });
    }
    if (url.pathname === '/v1/subjects:facets' && request.method === 'POST') {
      const body = await request.json();
      calls.push({ method: request.method, path: url.pathname, query: null, body });
      if (failFacets) return json({ type: 'about:blank', status: 503 }, 503);
      return json({
        facets: (body.facets ?? []).map(({ property }: { property: string }) => ({
          property,
          relation: 'exact',
          values:
            property === 'type'
              ? [
                  { value: 'schema:Recipe', count: 1, labels: { en: 'recipe', es: 'receta' } },
                  { value: book, count: 9, labels: { en: 'book', es: 'libro' } },
                  { value: 'schema:CreativeWork', count: 4, labels: { en: 'creative work', es: 'obra creativa' } },
                ]
              : property === author
                ? [
                    { value: authorTwo, count: 1, labels: { en: 'Natsume Soseki', es: 'Natsume Sōseki' } },
                    { value: authorOne, count: 7, labels: { en: 'Natsume Soseki', es: 'Natsume Sōseki' } },
                    { value: authorOne, count: 2, labels: { en: 'Natsume Soseki', es: 'Natsume Sōseki' } },
                  ]
                : property === genre
                  ? [{ value: genreOne, count: 3, labels: { en: 'Historical novel', es: 'novela histórica' } }]
                  : property === 'schema:datePublished'
                    ? [{ value: '2020-01-01T00:00:00Z', count: 1, labels: {} }]
                    : [],
        })),
        total: { value: 1, relation: 'exact' },
        as_of: asOf,
      });
    }
    if (url.pathname.startsWith('/auth/')) return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: '{}',
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read_reservation media:read media:complete media:erase',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

let browser: Browser | undefined;

async function open(path: string, javaScriptEnabled = true): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled,
  });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (javaScriptEnabled) await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const callsAt = (since: number, path: string) => calls.slice(since).filter((call) => call.path === path);

const root = join(import.meta.dir, '..', '..', '..');
const read = (path: string) => readFile(join(root, path), 'utf8');

test(
  'phone search filters follow the page heading, sit above results and Done restores focus',
  async () => {
    const page = await open(
      `/en/search?q=Kokoro&type=${encodeURIComponent(book)}&f.${encodeURIComponent(author)}=${authorOne}`,
    );
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const main = page.getByRole('main');
      const filterButton = main.getByRole('button', { name: 'Filters (2)' });
      expect(await filterButton.count()).toBe(1);
      const result = main.getByRole('link', { name: 'Kokoro', exact: true });
      const headingBox = await main.getByRole('heading', { level: 1 }).boundingBox();
      const filterBox = await filterButton.boundingBox();
      const resultBox = await result.boundingBox();
      expect(headingBox && filterBox && resultBox && headingBox.y < filterBox.y && filterBox.y < resultBox.y).toBe(
        true,
      );
      expect(await filterButton.evaluate((button) => getComputedStyle(button).borderTopStyle)).toBe('solid');
      expect(await filterButton.locator('svg').count()).toBe(1);
      await filterButton.click();
      const dialog = page.getByRole('dialog', { name: 'Filters (2)' });
      await dialog.waitFor({ state: 'visible' });
      expect(await dialog.locator('[data-slot="drawer-swipe-handle"]').count()).toBe(1);
      const done = dialog.getByRole('button', { name: 'Done' });
      expect(await done.evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await done.click();
      await dialog.waitFor({ state: 'detached' });
      expect(await filterButton.evaluate((button) => button === document.activeElement)).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test('no app or UI component imports the shadcn drawer outside the shared component', async () => {
  const files = [...(await sourceFiles('apps/web/src')), ...(await sourceFiles('packages/ui/src/components'))].filter(
    (path) => path !== 'packages/ui/src/components/bottom-sheet.tsx',
  );
  const consumers = await Promise.all(files.map(async (path) => [path, await read(path)] as const));
  expect(
    consumers.filter(([, source]) => /from ['\"](?:@rezics\/ui\/)?(?:\.\.\/)*shadcn\/drawer/.test(source)),
  ).toEqual([]);
  for (const path of [
    'apps/web/src/search/search.tsx',
    'apps/web/src/library/progress-session.tsx',
    'apps/web/src/library/copies-page.tsx',
    'packages/ui/src/components/menu.tsx',
  ]) {
    expect(await read(path)).toContain('BottomSheet');
  }
});

test('the shared component provides a handle, a close control and safe-area padding', async () => {
  const source = await read('packages/ui/src/components/bottom-sheet.tsx');
  expect(source).toContain('showSwipeHandle');
  expect(source).toContain('DrawerTitle');
  expect(source).toContain('DrawerClose');
  expect(source).toContain('min-h-11');
  expect(source).toContain('env(safe-area-inset-bottom)');
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}
