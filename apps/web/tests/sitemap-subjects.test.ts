import { expect, mock, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { subjectHref } from '../src/subject/subject-href.ts';
import { subjectPageTitle, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { sitemapLocales } from '../src/sitemap/feeds.ts';
import { subjectCanonicalPage, type SubjectSitemapPage } from '../src/sitemap/subject-canonical.ts';
import type { CanonicalSitemapItem } from '../src/sitemap/canonical.ts';

type Entry = SubjectSitemapPage['subjectPages'][number];
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const id = '01a1740d-7480-71e4-841f-66c04022d7d0';
const template = (
  platform.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
    views: { overview: CompositionDocument };
  }
).views.overview;

function pageFor(entry: Entry): SubjectPageData {
  const labels = Object.fromEntries(entry.labels.map(({ language, value }) => [language, value]));
  const original = entry.originalLanguage;
  const statements = original
    ? {
        'schema:inLanguage': [
          {
            id: 'language',
            rank: 'normal',
            property: { id: 'schema:inLanguage', data_type: 'string' },
            value: { type: 'value', content: original },
            qualifiers: [],
            references: [],
          },
        ],
      }
    : {};
  const subject = {
    id: entry.id,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:release',
    context: '00000000-0000-8000-8000-000000000000',
    resolution: {},
    labels,
    descriptions: {},
    aliases: {},
    statements,
  };
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(planReads(platformRegistry, template, { subject: entry.id }).reads))
    reads[key] =
      read.kind === 'subject'
        ? { status: 200, body: { subject, related: {}, summary: null } }
        : read.kind === 'links'
          ? { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } }
          : read.kind === 'collections'
            ? { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } }
            : { status: 200, body: { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: '' } };
  return {
    subject: entry.id,
    profile: 'sha256:release',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: template as never,
    reads,
  };
}

let pages: { subjectPages: Entry[]; next: string | null; status?: number }[] = [];
const requests: { cursor: string | null; limit: number; fetch: RequestInit }[] = [];
mock.module('../src/kernel/client.ts', () => ({
  kernelClient() {
    return {
      'subject-pages': {
        async get({ query, fetch }: { query: { cursor?: string; limit: number }; fetch: RequestInit }) {
          const cursor = query.cursor ?? null;
          requests.push({ cursor, limit: query.limit, fetch });
          const page = pages.shift() ?? { subjectPages: [], next: null };
          return { status: page.status ?? 200, data: { subjectPages: page.subjectPages, next: page.next } };
        },
      },
    };
  },
}));

const { feed } = await import('../src/sitemap/feeds/subjects.ts');

function entry(labels: Record<string, string>, originalLanguage?: string, lastModified?: string, sourceId = id): Entry {
  return {
    id: sourceId,
    target: { family: 'subject', subjectId: sourceId },
    views: ['overview'],
    labels: Object.entries(labels).map(([language, value]) => ({ language, value })),
    ...(originalLanguage === undefined ? {} : { originalLanguage }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

function projected(item: Entry): CanonicalSitemapItem {
  return subjectCanonicalPage({ subjectPages: [item], next: null }).items[0]!;
}

function expected(entry: Entry) {
  const page = pageFor(entry);
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      subjectHref({ id: entry.id, label: subjectPageTitle(page, locale) }, locale).href,
    ]),
  );
}

test('subject feed emits the page canonical URL for each locale from page labels and original language', () => {
  const examples = [
    entry(Object.fromEntries(locales.map((locale) => [locale, `Label ${locale}`])), 'ja'),
    entry({ ja: '日本語の題名' }, 'ja'),
    entry({ fr: 'Le livre', 'zh-Hant': '書' }, 'ja'),
    entry({ fr: 'Le livre', en: 'The book' }),
    entry({}),
  ];
  for (const item of examples) {
    const actual = feed.family(projected(item));
    expect(actual?.paths).toEqual(expected(item));
  }
});

test('subject feed follows short and empty pages with a continuation and uses the endpoint limit', async () => {
  const first = entry({ en: 'First' }, 'en', '2026-10-29T00:00:00.000Z');
  const final = entry({ ja: '最後' }, 'ja', undefined, id.replace(/0$/u, '1'));
  pages = [
    { subjectPages: [first], next: 'after-first' },
    { subjectPages: [], next: 'after-empty' },
    { subjectPages: [final], next: null },
  ];
  requests.length = 0;
  const collected: CanonicalSitemapItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await feed.read(cursor);
    collected.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  expect(collected).toEqual([projected(first), projected(final)]);
  expect(collected.map(({ id }) => id)).toEqual([first.id, final.id]);
  expect(requests).toEqual([
    { cursor: null, limit: 1000, fetch: { cache: 'no-store' } },
    { cursor: 'after-first', limit: 1000, fetch: { cache: 'no-store' } },
    { cursor: 'after-empty', limit: 1000, fetch: { cache: 'no-store' } },
  ]);
  expect(feed.family(collected[0]!)?.lastmod).toBe(first.lastModified);
  expect(feed.family(collected[1]!)?.lastmod).toBeUndefined();
});

test('a failed subject feed response rejects the export step without changing existing feed families', async () => {
  pages = [{ subjectPages: [], next: null, status: 503 }];
  requests.length = 0;
  await expect(feed.read(null)).rejects.toThrow('subjects returned 503');
  const { sitemapFeeds } = await import('../src/sitemap/feeds.ts');
  expect(sitemapFeeds().map(({ type }) => type)).toEqual([
    'agents',
    'boards',
    'collections',
    'realms',
    'spaces',
    'subjects',
    'threads',
  ]);
});

test('subject feed hrefs reach XML and reciprocal page links with exactly one locale prefix', async () => {
  const { familyXml } = await import('../src/sitemap/xml.ts');
  const { pageLinks } = await import('../src/shell/head.ts');
  const { sitemapPagePaths } = await import('../src/sitemap/url.ts');
  const origin = 'https://public.example';
  // Actual target and admitted views accompany sparse labels; no guessed original language.
  const item = entry({ fr: 'Le livre', 'zh-Hant': '書' });
  const family = feed.family(projected(item))!;
  const result = familyXml(origin, family.paths);
  expect(result.urls).toEqual(locales.map((locale) => `${origin}${family.paths[locale]}`));
  expect(result.xml.match(/<url>/g)).toHaveLength(8);
  expect(result.xml.match(/<xhtml:link /g)).toHaveLength(64);
  expect(result.xml).not.toContain('<lastmod>');
  const paths = sitemapPagePaths(family.paths);
  for (const locale of locales) {
    const links = pageLinks(origin, locale, '/', paths);
    expect(links[0]!.href).toBe(`${origin}${family.paths[locale]}`);
    for (const alternate of locales)
      expect(links).toContainEqual({
        rel: 'alternate',
        hrefLang: alternate,
        href: `${origin}${family.paths[alternate]}`,
      });
  }
});

test('the existing default subject sitemap adapter consumes actual owner canonical target/views and retains current canonical locale/view paths sparse cursor semantics and native failure without per-row hydration or guessed eligibility', async () => {
  const subject = { ...entry({ fr: 'Le livre', 'zh-Hant': '書' }, 'ja'), views: ['overview', 'editions', 'details'] };
  const account: Entry = {
    // Native route order can advance while UUID lexical order decreases.
    ...entry({ en: 'Not a handle' }, undefined, '2026-10-29T00:00:00.123Z', '00000000-0000-7000-8000-66c100000001'),
    target: { family: 'account', accountId: id, canonicalPath: '/@Current_Handle-' },
    views: ['overview', 'posts', 'reviews', 'collections'],
  };
  pages = [{ subjectPages: [subject, account], next: 'native-next' }];
  requests.length = 0;
  const page = await feed.read(null);
  expect(page.next).toBe('native-next');
  expect(requests).toEqual([{ cursor: null, limit: 1000, fetch: { cache: 'no-store' } }]);
  expect(page.items.map(({ id }) => id)).toEqual([
    subject.id,
    subject.id,
    subject.id,
    account.id,
    account.id,
    account.id,
    account.id,
  ]);
  const keys = page.items.map((item) => feed.key!(item));
  expect(new Set(keys).size).toBe(7);
  expect(keys).toEqual([...keys].sort());
  expect(page.items.map((item) => feed.family(item)?.paths.en ?? null)).toEqual([
    expected(subject).en,
    `${expected(subject).en}/editions`,
    `${expected(subject).en}/details`,
    '/en/@Current_Handle-',
    '/en/@Current_Handle-/posts',
    '/en/@Current_Handle-/reviews',
    '/en/@Current_Handle-/collections',
  ]);
  for (const locale of sitemapLocales) {
    expect(page.items[1]!.family?.paths[locale]).toBe(`${expected(subject)[locale]}/editions`);
    expect(page.items[3]!.family?.paths[locale]).toBe(`/${locale}/@Current_Handle-`);
    for (const [index, view] of ['posts', 'reviews', 'collections'].entries())
      expect(page.items[index + 4]!.family?.paths[locale]).toBe(`/${locale}/@Current_Handle-/${view}`);
  }
  expect(page.items[3]!.family?.lastmod).toBe(account.lastModified);
  expect(page.items[4]!.family?.lastmod).toBe(account.lastModified);
  expect(projected({ ...subject, lastModified: '2026-02-30T00:00:00Z' }).family?.lastmod).toBeUndefined();
  const onlyAccountOverview = subjectCanonicalPage({
    subjectPages: [{ ...account, views: ['overview'] }],
    next: 'continue',
  });
  expect(onlyAccountOverview).toEqual({
    items: [{ id: account.id, key: keys[3], family: page.items[3]!.family }],
    next: 'continue',
  });
});

test('explicit empty native views retain raw source progress through short and empty continuations without URL families', async () => {
  const account: Entry = {
    ...entry({ en: 'Labels do not admit overview' }),
    target: { family: 'account', accountId: id.replace(/0$/u, '9'), canonicalPath: '/@CurrentHandle' },
    views: [],
  };
  const subject = { ...entry({}, undefined, undefined, id.replace(/0$/u, '1')), views: [] };
  const final: Entry = { ...account, id: id.replace(/0$/u, '2'), views: ['collections'] };
  pages = [
    { subjectPages: [account, subject], next: 'after-known-empty' },
    { subjectPages: [], next: 'after-empty-window' },
    { subjectPages: [final], next: null },
  ];
  requests.length = 0;
  const empty = await feed.read(null);
  expect(empty.next).toBe('after-known-empty');
  expect(empty.items.map(({ id }) => id)).toEqual([account.id, subject.id]);
  expect(empty.items.map((item) => feed.family(item))).toEqual([null, null]);
  expect(empty.items.map((item) => feed.key!(item))).toEqual([
    `${account.id.slice(24, 28)}${account.id}:empty`,
    `${subject.id.slice(24, 28)}${subject.id}:empty`,
  ]);
  expect(await feed.read(empty.next)).toEqual({ items: [], next: 'after-empty-window' });
  const resumed = await feed.read('after-empty-window');
  expect(resumed.next).toBeNull();
  expect(resumed.items).toHaveLength(1);
  expect(resumed.items[0]!.id).toBe(final.id);
  expect(feed.family(resumed.items[0]!)?.paths.en).toBe('/en/@CurrentHandle/collections');
  expect(feed.family(resumed.items[0]!)?.lastmod).toBeUndefined();
  expect(requests).toEqual([
    { cursor: null, limit: 1000, fetch: { cache: 'no-store' } },
    { cursor: 'after-known-empty', limit: 1000, fetch: { cache: 'no-store' } },
    { cursor: 'after-empty-window', limit: 1000, fetch: { cache: 'no-store' } },
  ]);
});
