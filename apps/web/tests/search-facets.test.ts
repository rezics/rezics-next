import { afterAll, expect, test } from 'bun:test';
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

test(
  'an unrestricted search offers type choices, and a chosen type shows localized facet checkboxes without counts',
  async () => {
    const callsBefore = calls.length;
    const page = await open('/es/search?q=Kokoro');
    try {
      const main = page.getByRole('main');
      expect(await main.getByRole('link', { name: 'Libro', exact: true }).count()).toBe(1);
      expect(await main.getByRole('link', { name: 'Receta', exact: true }).count()).toBe(1);
      expect(await main.getByRole('link', { name: 'persona', exact: true }).count()).toBe(0);
      const typeChoices = await main
        .locator('a[href*="type="]')
        .evaluateAll((anchors) =>
          anchors.map((anchor) => new URL((anchor as HTMLAnchorElement).href).searchParams.get('type')),
        );
      expect(typeChoices).toEqual(['schema:Recipe', book, 'schema:CreativeWork']);
      const typeFacetCalls = calls
        .slice(callsBefore)
        .filter(
          (call) =>
            call.path === '/v1/subjects:facets' &&
            call.body?.facets?.some((facet: { property: string }) => facet.property === 'type'),
        );
      expect(typeFacetCalls).toHaveLength(1);
      await main.getByRole('link', { name: 'Libro', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('type') === book);
      expect(new URL(page.url()).searchParams.get('q')).toBe('Kokoro');
      expect(await main.getByRole('group', { name: 'Autor' }).count()).toBe(1);
      expect(await main.getByRole('group', { name: 'Género' }).count()).toBe(1);
      expect(await main.getByRole('checkbox', { name: 'Natsume Sōseki (libro)' }).count()).toBe(1);
      expect(await main.getByRole('checkbox', { name: 'Natsume Sōseki (receta)' }).count()).toBe(1);
      expect(
        await main
          .locator(`input[name="f.${author}"]`)
          .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
      ).toEqual([authorTwo, authorOne]);
      expect(await main.getByText('Natsume Sōseki (7)', { exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'choosing facet values narrows results with one filter sent to search and facets, without JavaScript',
  async () => {
    const page = await open(`/en/search?q=Kokoro&type=${encodeURIComponent(book)}`, false);
    try {
      const authorOneInput = page.locator(`input[name="f.${author}"][value="${authorOne}"]`);
      const authorTwoInput = page.locator(`input[name="f.${author}"][value="${authorTwo}"]`);
      const genreInput = page.locator(`input[name="f.${genre}"][value="${genreOne}"]`);
      expect(await authorOneInput.count()).toBe(1);
      const since = calls.length;
      await authorOneInput.check();
      await authorTwoInput.check();
      await genreInput.check();
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.waitForURL((url) => url.searchParams.getAll(`f.${author}`).length === 2);
      expect(new URL(page.url()).searchParams.getAll(`f.${author}`)).toEqual([authorOne, authorTwo]);
      expect(new URL(page.url()).searchParams.getAll(`f.${genre}`)).toEqual([genreOne]);
      const expected = {
        and: [
          { type: { in: [book] } },
          { statement: { property: author, in: [authorOne, authorTwo] } },
          { statement: { property: genre, in: [genreOne] } },
        ],
      };
      const searchCalls = callsAt(since, '/v1/subjects:search');
      const facetCalls = callsAt(since, '/v1/subjects:facets');
      expect(searchCalls).toHaveLength(1);
      expect(facetCalls).toHaveLength(1);
      expect(searchCalls[0]!.body).toMatchObject({ text: 'Kokoro', filter: expected });
      expect(facetCalls[0]!.body).toEqual({
        text: 'Kokoro',
        filter: expected,
        languages: ['en'],
        facets: [
          { property: author, size: 10 },
          { property: genre, size: 10 },
          { property: 'schema:datePublished', size: 10 },
        ],
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'types, properties and values are labelled in the page locale',
  async () => {
    const page = await open(`/es/search?q=Kokoro&type=${encodeURIComponent(book)}`);
    try {
      const main = page.getByRole('main');
      expect(await main.getByText('Libro', { exact: true }).count()).toBeGreaterThan(0);
      const property = main.getByRole('group', { name: 'Autor' });
      expect(await property.count()).toBe(1);
      expect(await property.getByRole('checkbox', { name: 'Natsume Sōseki (libro)' }).count()).toBe(1);
      expect(await property.getByRole('checkbox', { name: 'Natsume Sōseki (receta)' }).count()).toBe(1);
      expect(await property.locator('input[type="checkbox"]').count()).toBe(2);
      expect(await property.locator('legend').getAttribute('lang')).toBe('es');
      expect(await property.locator('label').first().getAttribute('lang')).toBe('es');
      const fallback = main.getByRole('group', { name: 'Publication date' });
      expect(await fallback.locator('legend').getAttribute('lang')).toBe('en');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a failed facet read still shows the results',
  async () => {
    failFacets = true;
    const since = calls.length;
    const page = await open(`/en/search?q=Kokoro&type=${encodeURIComponent(book)}`);
    try {
      const main = page.getByRole('main');
      expect(await main.getByRole('link', { name: 'Kokoro', exact: true }).count()).toBe(1);
      expect(callsAt(since, '/v1/subjects:facets')).toHaveLength(1);
      expect(await main.getByRole('group').count()).toBe(0);
      expect(await main.getByText('Filters', { exact: true }).count()).toBe(0);
    } finally {
      failFacets = false;
      await page.context().close();
    }
  },
  timeout,
);

test(
  'searches read the definitions release once per digest and make two kernel reads each',
  async () => {
    const origin = await site();
    const before = calls.length;
    const queries = Array.from({ length: 10 }, (_, index) => `cost-${index}`);
    for (const query of queries) {
      const response = await fetch(
        `${origin}/en/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(book)}`,
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const recent = calls.slice(before);
    const searchCalls = recent.filter((call) => call.path === '/v1/subjects:search');
    const facetCalls = recent.filter((call) => call.path === '/v1/subjects:facets');
    expect(searchCalls).toHaveLength(10);
    expect(facetCalls).toHaveLength(10);
    for (const query of queries) {
      const search = searchCalls.filter((call) => call.body?.text === query);
      const facets = facetCalls.filter((call) => call.body?.text === query);
      expect(search).toHaveLength(1);
      expect(facets).toHaveLength(1);
      expect(search[0]!.body.filter).toEqual(facets[0]!.body.filter);
    }
    expect(calls.filter((call) => call.path === '/v1/definitions/releases/' + digest)).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/v1/definitions/active').length).toBeLessThanOrEqual(1);
  },
  timeout,
);

test(
  'empty queries and searches with no results show no facet list',
  async () => {
    const emptyPage = await open('/en/search');
    try {
      const main = emptyPage.getByRole('main');
      expect(await main.getByRole('group').count()).toBe(0);
      expect(await main.getByRole('checkbox').count()).toBe(0);
      expect(await main.getByRole('button', { name: /Filters/ }).count()).toBe(0);
    } finally {
      await emptyPage.context().close();
    }

    emptySearch = true;
    const noResultsPage = await open('/en/search?q=Kokoro');
    try {
      const main = noResultsPage.getByRole('main');
      expect(await main.getByText('No results found.').count()).toBe(1);
      expect(await main.getByRole('group').count()).toBe(0);
      expect(await main.getByRole('checkbox').count()).toBe(0);
      expect(await main.getByRole('button', { name: /Filters/ }).count()).toBe(0);
    } finally {
      emptySearch = false;
      await noResultsPage.context().close();
    }
  },
  timeout,
);

test(
  'phone filters sit between the query and results and close with Done; desktop facets sit beside results',
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
      expect(await result.isVisible()).toBe(true);
      const queryBox = await main.locator('#search-form').boundingBox();
      const filterBox = await filterButton.boundingBox();
      const mobileResultBox = await result.boundingBox();
      expect(
        queryBox && filterBox && mobileResultBox && queryBox.y < filterBox.y && filterBox.y < mobileResultBox.y,
      ).toBe(true);
      expect(await filterButton.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(await filterButton.locator('svg').count()).toBe(1);
      expect(await main.getByRole('checkbox').count()).toBe(0);
      await filterButton.click();
      expect(await page.getByRole('dialog').count()).toBe(1);
      const dialog = page.getByRole('dialog');
      expect(await dialog.getByRole('heading', { name: 'Filters (2)' }).count()).toBe(1);
      expect(
        await dialog.getByRole('button', { name: 'Done' }).evaluate((button) => button.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      expect(await dialog.locator('[data-slot="drawer-swipe-handle"]').count()).toBe(1);
      expect(await page.getByRole('dialog').getByRole('checkbox').count()).toBeGreaterThan(0);
      expect(
        await page.getByRole('dialog').locator(`input[name="f.${author}"][value="${authorOne}"]`).isChecked(),
      ).toBe(true);
      await dialog.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      expect(await filterButton.evaluate((button) => button === document.activeElement)).toBe(true);
      await page.setViewportSize({ width: 1280, height: 860 });
      expect(await main.getByRole('checkbox').count()).toBeGreaterThan(0);
      const resultBox = await result.boundingBox();
      const facetBox = await main.getByRole('group', { name: 'Author' }).boundingBox();
      expect(resultBox && facetBox && facetBox.x).toBeLessThan(resultBox?.x ?? 0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
