import { startDevServer } from './support/dev-server.ts';
import { pickText } from '@rezics/composition';
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const digest = 'release-type-names';
const bookId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const animeId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';

type RecordedPage = {
  status?: number;
  subject: string;
  reads: {
    r0: {
      body: {
        summary: Record<string, unknown>;
        subject: Record<string, unknown>;
      };
    };
  };
  [key: string]: unknown;
};

const recorded = (await Bun.file(join(app, 'src/kernel/recorded/subject-page.json')).json()) as RecordedPage;
const bookPage = pageFor(bookId, 'schema:Book');
const animePage = pageFor(animeId, 'schema:Anime');

function pageFor(id: string, type: string) {
  const { status: _status, ...page } = structuredClone(recorded);
  page.subject = id;
  const body = page.reads.r0.body;
  body.subject.id = id;
  body.subject.type = type;
  body.summary.id = id;
  body.summary.type = type;
  body.summary.types = [type, ...((body.summary.types as string[] | undefined) ?? []).filter((name) => name !== type)];
  return page;
}

const release = {
  types: {
    'schema:Book': {
      labels: {
        en: 'book',
        fr: 'livre',
        es: 'libro',
        de: 'Buch',
        'zh-Hans': '书籍',
        'zh-Hant': '書籍',
        ja: '書籍',
        ko: '책',
      },
      bases: [],
    },
    'schema:Anime': { labels: { en: 'anime television series' }, bases: [] },
  },
  properties: {
    'schema:author': {
      labels: { en: 'author' },
      datatype: 'wikibase-item',
      relation: { group: 'association', symmetric: true },
    },
    'rezics:sideStoryOf': {
      labels: { en: 'side story of' },
      datatype: 'wikibase-item',
      relation: { group: 'world', symmetric: false, inverseLabels: { en: 'side stories' } },
    },
  },
};

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
  request_id: 'type-names',
});

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/definitionTypes/')) {
      const typeId = decodeURIComponent(url.pathname.slice('/v1/definitionTypes/'.length));
      const definition = release.types[typeId as keyof typeof release.types];
      if (!definition) return json(problem(404, 'not_found'), 404);
      const label = pickText(definition.labels, url.searchParams.get('locale') ?? 'en');
      return json({ typeId, releaseDigest: digest, label: label.text, language: label.lang, definition });
    }
    if (url.pathname === '/v1/definitions/active') return json({ digest });
    if (url.pathname === `/v1/definitions/releases/${digest}`) return json({ digest, release });
    if (url.pathname === '/v1/pages:read' && request.method === 'POST') {
      const target = ((await request.json()) as { target?: { subject?: string } }).target;
      const page = target?.subject === bookId ? bookPage : target?.subject === animeId ? animePage : undefined;
      return page ? json(page) : json(problem(404, 'not_found'), 404);
    }
    if (url.pathname === `/v1/subjects/${bookId}/links` && request.method === 'GET')
      return json({ links: [], count: { value: 0, exact: true }, next: null });
    return json(problem(404, 'not_found'), 404);
  },
});



let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_CLIENT_KEY: '{}',
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'openid',
    },
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
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

async function pageHtml(path: string): Promise<string> {
  const response = await fetch(`${await site()}${path}`);
  expect(response.status, path).toBe(200);
  return response.text();
}

async function subjectTypeLabel(locale: string, id = bookId): Promise<string> {
  const html = await pageHtml(`/${locale}/subjects/${id}/relations`);
  const meta = /<div data-slot="subject-frame"[\s\S]*?<p class="text-sm text-muted-foreground">([\s\S]*?)<\/p>/.exec(
    html,
  );
  expect(meta, `${locale} subject type label`).not.toBeNull();
  return meta![1]!
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .trim()
    .split(' · ')[0]!;
}

function relationHeading(html: string): string {
  const heading = /<div data-slot="view-heading"[^>]*>\s*<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  expect(heading, 'relation property heading').not.toBeNull();
  return heading![1]!.replace(/<[^>]+>/g, '').trim();
}

test(
  "a type's first letter follows the locale's display case, with the rest unchanged",
  async () => {
    for (const [locale, expected] of [
      ['en', 'Book'],
      ['fr', 'Livre'],
      ['es', 'Libro'],
      ['de', 'Buch'],
      ['zh-Hans', '书籍'],
      ['zh-Hant', '書籍'],
      ['ja', '書籍'],
      ['ko', '책'],
    ] as const)
      expect(await subjectTypeLabel(locale), locale).toBe(expected);

    expect(await subjectTypeLabel('en', animeId)).toBe('Anime television series');
  },
  timeout,
);

test(
  'property and relation labels keep the case declared by the release',
  async () => {
    const author = await pageHtml(`/en/subjects/${bookId}/relations?property=schema%3Aauthor`);
    expect(relationHeading(author)).toBe('author');

    const sideStories = await pageHtml(`/en/subjects/${bookId}/relations?property=rezics%3AsideStoryOf`);
    expect(relationHeading(sideStories)).toBe('side stories');
  },
  timeout,
);
