import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const digest = 'release-results-digest';
const asOf = '2026-10-01T00:00:00.000Z';
const book = 'schema:Book';
const note = 'schema:note';
const author = 'schema:author';
const published = 'schema:datePublished';
const genre = 'schema:genre';
const cursor = 'opaque-page-2';

// The note property has a string datatype without a pattern, so it is not an admitted fact; the genre is a third
// admitted property that must stay unasked because only two are sent.
const release = {
  types: {
    [book]: {
      labels: { en: 'book', ja: '本', es: 'libro' },
      bases: [],
      facets: [note, author, published, genre],
    },
    'schema:Person': { labels: { en: 'person', ja: '人物' }, bases: [], facets: [author] },
  },
  properties: {
    [note]: { labels: { en: 'note' }, datatype: 'string' },
    [author]: { labels: { en: 'author', ja: '著者' }, datatype: 'wikibase-item' },
    [published]: { labels: { en: 'publication date', ja: '刊行日' }, datatype: 'time' },
    [genre]: { labels: { en: 'genre' }, datatype: 'string', value: { pattern: '^wd:Q[0-9]+$' } },
  },
};

type Hit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  descriptions?: Record<string, string>;
  facts?: Record<string, unknown[]>;
};
type SearchBody = {
  text?: string;
  cursor?: string;
  limit?: number;
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};

const kokoro: Hit = {
  id: '00000000-0000-4000-8000-000000000111',
  type: book,
  labels: { en: 'Kokoro', ja: 'こころ' },
  descriptions: {
    en: 'A student meets a reclusive teacher. <em>Not markup</em>',
    ja: '学生が隠遁する先生と出会う小説。',
  },
  facts: {
    [author]: [
      { kind: 'item', id: '00000000-0000-4000-8000-000000000201', labels: { en: 'Natsume Soseki', ja: '夏目漱石' } },
      { kind: 'item', id: '00000000-0000-4000-8000-000000000202', labels: { en: 'Second Author', ja: '第二著者' } },
      { kind: 'item', id: '00000000-0000-4000-8000-000000000203', labels: { en: 'Third Author', ja: '第三著者' } },
      { kind: 'item', id: '00000000-0000-4000-8000-000000000204', labels: { en: 'Fourth Author', ja: '第四著者' } },
    ],
    [published]: [{ kind: 'time', year: 1914 }],
  },
};
const kokoroTwo: Hit = {
  id: '00000000-0000-4000-8000-000000000112',
  type: book,
  labels: { en: 'Kokoro', ja: 'こころ' },
  descriptions: { en: 'A picture book about courage.', ja: '勇気についての絵本。' },
  facts: {
    [author]: [
      { kind: 'item', id: '00000000-0000-4000-8000-000000000205', labels: { en: 'Another Writer', ja: '別の作家' } },
    ],
  },
};
const bare: Hit = {
  id: '00000000-0000-4000-8000-000000000113',
  type: book,
  labels: { en: 'Untold book', ja: '語られない本' },
  descriptions: {},
};
const later: Hit = {
  id: '00000000-0000-4000-8000-000000000114',
  type: book,
  labels: { en: 'Later page book', ja: '次頁の本' },
  descriptions: { en: 'Found on the second page.', ja: '二頁目の本。' },
  facts: { [published]: [{ kind: 'time', year: 1925 }] },
};

const calls: { method: string; path: string; body: SearchBody | null }[] = [];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

function narrow(map: Record<string, string> | undefined, languages: string[] | undefined) {
  return Object.fromEntries(
    Object.entries(map ?? {}).filter(([language]) => !languages || languages.includes(language)),
  );
}

// Like the real kernel, a hit carries only what the request asked for, narrowed to the requested languages.
function project(hit: Hit, body: SearchBody): Hit {
  const result: Hit = { id: hit.id, type: hit.type, labels: narrow(hit.labels, body.languages) };
  if (body.descriptions) result.descriptions = narrow(hit.descriptions, body.languages);
  if (body.properties) {
    const facts: Record<string, unknown[]> = {};
    for (const property of body.properties) {
      const values = (hit.facts?.[property] ?? []).slice(0, 3).map((fact) => {
        const value = fact as { kind: string; labels?: Record<string, string> };
        return value.kind === 'item' ? { ...value, labels: narrow(value.labels, body.languages) } : value;
      });
      if (values.length > 0) facts[property] = values;
    }
    if (Object.keys(facts).length > 0) result.facts = facts;
  }
  return result;
}

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/definitions/active' && request.method === 'GET') return json({ digest });
    if (url.pathname === `/v1/definitions/releases/${digest}` && request.method === 'GET')
      return json({ digest, release }, 200, {
        etag: `"${digest}"`,
        'cache-control': 'public, max-age=31536000, immutable',
      });
    if (url.pathname === '/v1/subjects:search' && request.method === 'POST') {
      const body = (await request.json()) as SearchBody;
      calls.push({ method: request.method, path: url.pathname, body });
      const hits = body.cursor === cursor ? [later] : body.text === 'Untold' ? [bare] : [kokoro, kokoroTwo, bare];
      return json({
        subjects: hits.map((hit) => project(hit, body)),
        total: { value: hits.length, relation: 'exact' },
        next: body.cursor === cursor || body.text === 'Untold' ? null : cursor,
        as_of: asOf,
      });
    }
    if (url.pathname === '/v1/subjects:facets' && request.method === 'POST')
      return json({ facets: [], total: { value: 3, relation: 'exact' }, as_of: asOf });
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
    const origin = `http://127.0.0.1:${port}`;
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
        PUBLIC_ORIGIN: origin,
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

async function open(path: string, javaScriptEnabled = true, width = 1280): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (javaScriptEnabled) {
    try {
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    } catch (error) {
      throw new Error(`Search page did not hydrate. Browser errors: ${browserErrors.join('\n') || 'none'}`, {
        cause: error,
      });
    }
  }
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

const searches = (since: number) => calls.slice(since).filter((call) => call.path === '/v1/subjects:search');
const searchPath = (locale: string, query: string, type?: string) => {
  const params = new URLSearchParams({ q: query });
  if (type) params.set('type', type);
  return `/${locale}/search?${params}`;
};
const row = (page: Page, title: string, index = 0) =>
  page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) })
    .nth(index);
const text = async (locator: ReturnType<typeof row>) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

const cases = [
  {
    locale: 'en',
    language: 'en',
    languages: ['en'],
    title: 'Kokoro',
    type: 'Book',
    description: 'A student meets a reclusive teacher. <em>Not markup</em>',
    other: 'A picture book about courage.',
    facts: 'Natsume Soseki · Second Author · Third Author',
  },
  {
    locale: 'ja',
    language: 'ja',
    languages: ['ja'],
    title: 'こころ',
    type: '本',
    description: '学生が隠遁する先生と出会う小説。',
    other: '勇気についての絵本。',
    facts: '夏目漱石 · 第二著者 · 第三著者',
  },
];

test(
  "each search result shows its title, its type's name and a short description in the page's language",
  async () => {
    for (const spec of cases) {
      const page = await open(`/${spec.locale}/search?q=Kokoro`);
      try {
        const first = row(page, spec.title, 0);
        const link = first.getByRole('link', { name: spec.title, exact: true });
        expect(await link.getAttribute('lang')).toBe(spec.language);
        expect(await link.getAttribute('href')).toContain(kokoro.id);
        const label = first.getByText(spec.type, { exact: true });
        expect(await label.count()).toBe(1);
        expect(await label.getAttribute('lang')).toBe(spec.language);
        const description = first.getByText(spec.description, { exact: true });
        expect(await description.count()).toBe(1);
        expect(await description.getAttribute('lang')).toBe(spec.language);
        expect(await first.locator('em').count()).toBe(0);
        const second = row(page, spec.title, 1);
        expect(await second.getByRole('link', { name: spec.title, exact: true }).getAttribute('href')).toContain(
          kokoroTwo.id,
        );
        expect(await link.getAttribute('href')).not.toBe(
          await second.getByRole('link', { name: spec.title, exact: true }).getAttribute('href'),
        );
        expect(await second.getByText(spec.other, { exact: true }).count()).toBe(1);
        expect(await second.getByText(spec.type, { exact: true }).count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "a search filtered to one type shows that type's leading facts on each result",
  async () => {
    for (const spec of cases) {
      const before = calls.length;
      const query = 'Kokoro filtered facts';
      const page = await open(searchPath(spec.locale, query, book));
      try {
        expect(searches(before)).toHaveLength(1);
        expect(searches(before)[0]!.body).toMatchObject({
          text: query,
          descriptions: true,
          languages: spec.languages,
          properties: [author, published],
        });
        const first = row(page, spec.title, 0);
        // Three values of the author; the year sits beside the type, and the fourth author never shows.
        expect(await text(first)).toContain(spec.facts);
        expect(await first.locator('[data-slot="year"]').innerText()).toBe('1914');
        expect(await text(first)).not.toContain('Fourth');
        const facts = first.getByText(spec.facts, { exact: true });
        expect(await facts.count()).toBe(1);
        expect(await facts.getAttribute('lang')).toBeNull();
        expect(await first.getByText(spec.description, { exact: true }).count()).toBe(1);
        const second = row(page, spec.title, 1);
        expect(await text(second)).toContain(spec.language === 'en' ? 'Another Writer' : '別の作家');
        expect(await text(second)).not.toContain('1914');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'an unfiltered search asks only for the years and still shows type names and descriptions',
  async () => {
    for (const spec of cases) {
      const before = calls.length;
      const query = 'Kokoro years only';
      const page = await open(searchPath(spec.locale, query));
      try {
        expect(searches(before)).toHaveLength(1);
        const body = searches(before)[0]!.body!;
        expect(body.text).toBe(query);
        expect(body.descriptions).toBe(true);
        expect(body.languages).toEqual(spec.languages);
        expect(body.properties).toEqual([published]);
        const first = row(page, spec.title, 0);
        expect(await text(first)).toContain(spec.type);
        expect(await text(first)).toContain(spec.description);
        expect(await text(first)).not.toContain('Natsume');
        expect(await first.locator('[data-slot="year"]').innerText()).toBe('1914');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'the next page sends the same result fields as the first',
  async () => {
    for (const spec of cases) {
      for (const filtered of [true, false]) {
        const before = calls.length;
        const query = `Kokoro next page ${spec.locale} ${filtered ? 'filtered' : 'unfiltered'}`;
        const page = await open(searchPath(spec.locale, query, filtered ? book : undefined));
        try {
          const more = page.getByRole('main').getByRole('link', { name: /more|さらに表示/i });
          await more.click();
          await page
            .getByRole('main')
            .getByRole('link', { name: spec.language === 'en' ? 'Later page book' : '次頁の本' })
            .waitFor();
          const nextLink = page
            .getByRole('main')
            .getByRole('link', { name: spec.language === 'en' ? 'Later page book' : '次頁の本' });
          expect(await nextLink.getAttribute('href')).toContain(later.id);
          expect(searches(before)).toHaveLength(2);
          const [firstPage, secondPage] = searches(before).map((call) => call.body!);
          expect(firstPage!.text).toBe(query);
          expect(secondPage!.text).toBe(query);
          expect(secondPage!.cursor).toBe(cursor);
          expect(secondPage!.descriptions).toBe(true);
          expect(secondPage!.languages).toEqual(firstPage!.languages);
          expect(secondPage!.languages).toEqual(spec.languages);
          expect(secondPage!.properties).toEqual(firstPage!.properties);
          expect(secondPage!.properties).toEqual(filtered ? [author, published] : [published]);
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);

test(
  'search result links, header controls and rows remain usable at a phone width',
  async () => {
    const before = calls.length;
    const query = 'Kokoro phone layout';
    const page = await open(searchPath('en', query), true, 390);
    try {
      expect(searches(before)).toHaveLength(1);
      expect(searches(before)[0]!.body?.text).toBe(query);
      expect(searches(before)[0]!.body?.limit).toBe(100);
      const searchTrigger = page.getByRole('button', { name: 'Search subjects' });
      expect(await searchTrigger.count()).toBe(1);
      await searchTrigger.click();
      const headerSearch = page.getByRole('combobox', { name: 'Search subjects' });
      await headerSearch.waitFor();
      expect(await headerSearch.isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: /Filters/ }).count()).toBe(1);
      await page.keyboard.press('Escape');
      const rendered = await page
        .locator('main [data-slot="list-row"]')
        .evaluateAll((elements) =>
          elements.map((element) => element.querySelector<HTMLAnchorElement>('a[href*="/subjects/"]')?.href ?? ''),
        );
      expect(rendered.map((href) => new URL(href).pathname.match(/\/subjects\/([^/]+)/)?.[1])).toEqual([
        kokoro.id,
        kokoroTwo.id,
        bare.id,
      ]);
      const width = await page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      );
      expect(width).toBeLessThanOrEqual(390);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a result without a description or facts shows only its title and type',
  async () => {
    for (const spec of cases) {
      for (const filtered of [true, false]) {
        const type = filtered ? `&type=${encodeURIComponent(book)}` : '';
        const page = await open(`/${spec.locale}/search?q=Untold${type}`);
        try {
          const title = spec.language === 'en' ? 'Untold book' : '語られない本';
          // The cover's placeholder repeats the title as its picture; the text beside it is the title and the type.
          expect(await text(row(page, title).locator('[data-slot="item-content"]'))).toBe(`${title} ${spec.type}`);
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);
