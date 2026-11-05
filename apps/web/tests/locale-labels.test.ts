import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { localeChain, pickText } from '@rezics/composition';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const digest = 'release-locale-labels';
const asOf = '2026-10-01T00:00:00.000Z';
const book = 'schema:Book';
const film = 'schema:Film';
const author = 'schema:author';
const language = 'schema:inLanguage';
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];

// Book has a name in zh-Hans; Film only in zh-Hant, so a zh-Hans reader must reach it through the chain.
const release = {
  types: {
    [book]: {
      labels: { en: 'book', 'zh-Hans': '图书', 'zh-Hant': '圖書', ja: '本' },
      bases: [],
      facets: [author],
    },
    [film]: { labels: { en: 'film', 'zh-Hant': '電影' }, bases: [], facets: [author] },
  },
  properties: {
    [author]: { labels: { en: 'author' }, datatype: 'wikibase-item' },
  },
};

const chains: Record<string, string[]> = {
  en: ['en'],
  'zh-Hans': ['zh-Hans', 'zh', 'zh-Hant', 'en'],
  'zh-Hant': ['zh-Hant', 'zh', 'zh-Hans', 'en'],
  ja: ['ja', 'en'],
  ko: ['ko', 'en'],
  de: ['de', 'en'],
  fr: ['fr', 'en'],
  es: ['es', 'en'],
};
const headers: Record<string, string> = {
  en: 'en',
  'zh-Hans': 'zh-Hans, zh;q=0.9, zh-Hant;q=0.8',
  'zh-Hant': 'zh-Hant, zh;q=0.9, zh-Hans;q=0.8',
  ja: 'ja',
  ko: 'ko',
  de: 'de',
  fr: 'fr',
  es: 'es',
};

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
type Texts = Record<string, string>;
type Spec = { labels: Texts; descriptions: Texts; language?: string };

// Each subject lacks the earlier steps of the chain it is meant to exercise.
const subjects = new Map<string, Spec>();
function subject(n: number, labels: Texts, descriptions: Texts, original?: string) {
  subjects.set(id(n), { labels, descriptions, ...(original ? { language: original } : {}) });
  return id(n);
}
const exact = subject(
  1,
  texts('t', ['zh-Hans', 'zh', 'zh-Hant', 'ja', 'en']),
  texts('d', ['zh-Hans', 'zh', 'zh-Hant', 'ja', 'en']),
);
const bare = subject(2, texts('t', ['zh', 'zh-Hant', 'ja', 'en']), texts('d', ['zh', 'zh-Hant', 'ja', 'en']));
const sibling = subject(3, texts('t', ['zh-Hant', 'ja', 'en']), texts('d', ['zh-Hant', 'ja', 'en']), 'ja');
const original = subject(4, texts('t', ['de', 'fr', 'ja', 'en']), texts('d', ['de', 'fr', 'ja', 'en']), 'ja');
const english = subject(5, texts('t', ['de', 'fr', 'en']), texts('d', ['de', 'fr', 'en']), 'it');
const first = subject(6, texts('t', ['fr', 'de']), texts('d', ['fr', 'de']));
const french = subject(7, texts('t', ['de', 'fr', 'en']), texts('d', ['de', 'fr', 'en']), 'fr');
const hantOnly = subject(8, texts('t', ['zh-Hans', 'en']), texts('d', ['zh-Hans', 'en']));
const hantBare = subject(9, texts('t', ['zh', 'zh-Hans', 'en']), texts('d', ['zh', 'zh-Hans', 'en']));

function texts(prefix: string, tags: string[]): Texts {
  return Object.fromEntries(tags.map((tag) => [tag, `${prefix}-${tag}`]));
}

const recorded = (await Bun.file(join(app, 'src/kernel/recorded/subject-page.json')).json()) as {
  status: number;
  subject: string;
  reads: { r0: { body: { subject: Record<string, unknown>; related: Record<string, unknown> } } };
  [key: string]: unknown;
};

function pageFor(subjectId: string, spec: Spec) {
  const { status: _status, ...page } = structuredClone(recorded);
  page.subject = subjectId;
  const body = page.reads.r0.body;
  body.subject = {
    ...body.subject,
    id: subjectId,
    labels: spec.labels,
    descriptions: spec.descriptions,
    aliases: {},
    statements: spec.language
      ? {
          [language]: [
            {
              id: id(900),
              rank: 'normal',
              property: { id: language, data_type: 'string' },
              value: { type: 'value', content: spec.language },
              qualifiers: [],
              references: [],
            },
          ],
        }
      : {},
  };
  body.related = { [language]: { labels: { en: 'language', 'zh-Hans': '语言', 'zh-Hant': '語言', ja: '言語' } } };
  return page;
}

type Call = { method: string; path: string; accept: string | null };
const calls: Call[] = [];
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...(status >= 400 ? { 'content-type': 'application/problem+json' } : {}) },
  });
const problem = (status: number, code: string) => ({
  type: `https://rezics.com/problems/${code}`,
  title: code,
  status,
  code,
  retryable: false,
  effect_status: 'not_applicable',
  request_id: 'locale-labels',
});

const collectionId = id(500);
const members = [
  {
    id: id(601),
    subjectId: id(701),
    note: null,
    addedAt: asOf,
    subject: { id: id(701), type: book, label: 'Book row' },
  },
  {
    id: id(602),
    subjectId: id(702),
    note: null,
    addedAt: asOf,
    subject: { id: id(702), type: film, label: 'Film row' },
  },
  {
    id: id(603),
    subjectId: id(703),
    note: null,
    addedAt: asOf,
    subject: { id: id(703), type: 'wd:Q9999999', label: 'Unnamed type row' },
  },
];

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, accept: request.headers.get('accept-language') });
    if (url.pathname === '/v1/definitions/active') return json({ digest });
    if (url.pathname === `/v1/definitions/releases/${digest}`) return json({ digest, release }, 200);
    if (url.pathname === '/v1/pages:read' && request.method === 'POST') {
      const target = ((await request.json()) as { target?: { subject?: string } }).target;
      const spec = target?.subject ? subjects.get(target.subject) : undefined;
      return spec ? json(pageFor(target!.subject!, spec)) : json(problem(404, 'not_found'), 404);
    }
    const subjectMatch = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && subjectMatch) {
      const subjectId = decodeURIComponent(subjectMatch[1]!);
      const spec = subjects.get(subjectId);
      return spec ? json(pageFor(subjectId, spec).reads.r0.body) : json(problem(404, 'not_found'), 404);
    }
    if (url.pathname === '/v1/subjects:search' && request.method === 'POST')
      return json({
        subjects: [{ id: id(701), type: book, labels: { en: 'Kokoro' } }],
        total: { value: 1, relation: 'exact' },
        next: null,
        as_of: asOf,
      });
    if (url.pathname === '/v1/subjects:facets' && request.method === 'POST')
      return json({ facets: [], total: { value: 1, relation: 'exact' }, as_of: asOf });
    if (url.pathname === '/v1/subjects:suggest' && request.method === 'GET')
      return json({ subjects: [{ id: id(701), type: book, labels: { en: 'Kokoro' } }], as_of: asOf });
    if (url.pathname === `/v1/collections/${collectionId}` && request.method === 'GET')
      return json({
        collection: {
          id: collectionId,
          curatorAccountId: 'alice',
          title: 'Shelf',
          description: null,
          visibility: 'public',
          revision: 1,
          memberCount: members.length,
          createdAt: asOf,
          updatedAt: asOf,
          curator: { id: 'alice', handle: 'ada', displayName: 'Ada' },
        },
      });
    if (url.pathname === `/v1/collections/${collectionId}/members` && request.method === 'GET')
      return json({ members, next: null });
    return json(problem(404, 'not_found'), 404);
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
        WEBSITE_SCOPES: 'openid',
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
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

afterAll(() => {
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

async function html(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${await site()}${path}`, init);
  expect(response.status, path).toBe(200);
  return response.text();
}
const main = (page: string) => /<main\b[^>]*>([\s\S]*)<\/main>/.exec(page)?.[1] ?? page;
const plain = (fragment: string) =>
  fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const heading = (page: string) => plain(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(main(page))?.[1] ?? '');
const description = (page: string) => plain(/<p\b[^>]*max-w-prose[^>]*>([\s\S]*?)<\/p>/.exec(main(page))?.[1] ?? '');

async function shown(locale: string, subjectId: string) {
  const page = await html(`/${locale}/subjects/${subjectId}`);
  return { title: heading(page), description: description(page), page };
}

test(
  'a zh-Hans reader sees zh-Hans text, then zh, then zh-Hant, then the original-language title, then English',
  async () => {
    expect(localeChain('zh-Hans')).toEqual(['zh-Hans', 'zh', 'zh-Hant', 'en']);
    const value = { 'zh-Hans': 'a', zh: 'b', 'zh-Hant': 'c', ja: 'd', en: 'e', de: 'f' };
    const order = ['a', 'b', 'c', 'd', 'e', 'f'];
    const remaining: Record<string, string> = { ...value };
    for (const [index, key] of ['zh-Hans', 'zh', 'zh-Hant', 'ja', 'en', 'de'].entries()) {
      expect(pickText(remaining, 'zh-Hans', 'ja').text).toBe(order[index]!);
      delete remaining[key];
    }
    expect(pickText({ de: 'x', fr: 'y' }, 'zh-Hans').text).toBe('x');
    expect(pickText({ de: 'x', ja: 'y', en: 'z' }, 'zh-Hans', 'ja').text).toBe('y');
    expect(pickText({ de: 'x', en: 'z' }, 'zh-Hans', 'ja').text).toBe('z');

    const cases = [
      [exact, 'zh-Hans'],
      [bare, 'zh'],
      [sibling, 'zh-Hant'],
      [original, 'ja'],
      [english, 'en'],
      [first, 'de'],
    ] as const;
    for (const [subjectId, tag] of cases) {
      const view = await shown('zh-Hans', subjectId);
      expect(view.title, tag).toBe(`t-${tag}`);
      expect(view.description, tag).toBe(`d-${tag}`);
    }
    // The original language is named, but English still wins when the subject has no entry in it.
    expect((await shown('zh-Hans', french)).title).toBe('t-fr');
  },
  timeout,
);

test(
  'every other locale follows the same chain: the locale, its language, sibling scripts, the original language, English',
  async () => {
    for (const locale of locales) expect(localeChain(locale), locale).toEqual(chains[locale]!);
    for (const locale of locales) {
      // An English reader already has the original-language step after English.
      const steps = locale === 'en' ? ['en', 'it'] : [...chains[locale]!.slice(0, -1), 'it', 'en'];
      const remaining: Record<string, string> = Object.fromEntries([...steps, 'zz'].map((tag) => [tag, tag]));
      for (const tag of steps) {
        expect(pickText(remaining, locale, 'it').text, `${locale} before ${tag}`).toBe(tag);
        delete remaining[tag];
      }
      expect(pickText(remaining, locale, 'it').text, locale).toBe('zz');
    }

    const hant = await shown('zh-Hant', hantOnly);
    expect(hant.title).toBe('t-zh-Hans');
    expect(hant.description).toBe('d-zh-Hans');
    expect((await shown('zh-Hant', hantBare)).title).toBe('t-zh');
    expect((await shown('zh-Hant', exact)).title).toBe('t-zh-Hant');
    expect((await shown('ja', exact)).title).toBe('t-ja');
    expect((await shown('ja', original)).title).toBe('t-ja');
    expect((await shown('ja', french)).title).toBe('t-fr');
    expect((await shown('ja', english)).title).toBe('t-en');
    expect((await shown('de', french)).title).toBe('t-de');
    expect((await shown('ko', french)).title).toBe('t-fr');
    expect((await shown('ko', exact)).title).toBe('t-en');
  },
  timeout,
);

test(
  "every kernel read from the site sends the reader's language chain",
  async () => {
    const origin = await site();
    for (const locale of locales) {
      calls.length = 0;
      await html(`/${locale}/subjects/${exact}`);
      await html(`/${locale}`);
      await html(`/${locale}/collections/${collectionId}`);
      await html(`/${locale}/search?q=Kokoro&type=${encodeURIComponent(book)}`);
      // The shell's suggestion box asks for its page's language; a bare request falls back to the page it came from.
      expect((await fetch(`${origin}/api/search/suggestions?q=Ko&locale=${locale}`)).status).toBe(200);
      expect(
        (await fetch(`${origin}/api/search/suggestions?q=Ko`, { headers: { referer: `${origin}/${locale}/search` } }))
          .status,
      ).toBe(200);

      const reads = calls.filter((call) => !call.path.startsWith('/v1/definitions/'));
      const paths = new Set(reads.map((call) => `${call.method} ${call.path}`));
      for (const expected of [
        'POST /v1/pages:read',
        `GET /v1/collections/${collectionId}`,
        `GET /v1/collections/${collectionId}/members`,
        'POST /v1/subjects:search',
        'POST /v1/subjects:facets',
        'GET /v1/subjects:suggest',
      ])
        expect(paths.has(expected), `${locale} ${expected}`).toBe(true);
      for (const call of reads) expect(call.accept, `${locale} ${call.method} ${call.path}`).toBe(headers[locale]!);
    }
  },
  timeout,
);

test(
  "types and languages show localized names in the reader's language, never a CURIE or a language code",
  async () => {
    for (const [locale, bookName, filmName] of [
      ['zh-Hans', '图书', '電影'],
      ['zh-Hant', '圖書', '電影'],
      ['ja', '本', 'Film'],
      ['de', 'Book', 'Film'],
    ] as const) {
      const shelf = main(await html(`/${locale}/collections/${collectionId}`));
      // The decorative cover's initials are not part of what the row says.
      const rows = [...shelf.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((row) =>
        plain(row[1]!.replace(/<span\b[^>]*font-work-title[^>]*>[^<]*<\/span>/g, '')),
      );
      expect(rows, locale).toEqual([`Book row ${bookName}`, `Film row ${filmName}`, 'Unnamed type row']);
      expect(shelf).not.toMatch(/schema:|wd:Q/);

      const names = new Intl.DisplayNames([locale], { type: 'language' });
      const view = await shown(locale, french);
      const reading = plain(main(view.page));
      expect(reading, locale).toContain(names.of('fr')!);
      expect(reading, locale).not.toMatch(/(^|\s)fr(\s|$)/);
      expect(reading, locale).not.toContain('schema:');
    }
  },
  timeout,
);
