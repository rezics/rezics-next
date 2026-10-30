import { expect, mock, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { subjectHref } from '../src/subject/subject-href.ts';
import { subjectPageTitle, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { sitemapLocales } from '../src/sitemap/feeds.ts';

type Entry = {
  id: string;
  labels: { language: string; value: string }[];
  originalLanguage?: string;
  lastModified?: string;
};
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
const requests: { cursor: string | null; limit: number }[] = [];
mock.module('../src/kernel/client.ts', () => ({
  kernelClient() {
    return {
      'subject-pages': {
        async get({ query }: { query: { cursor?: string; limit: number } }) {
          const cursor = query.cursor ?? null;
          requests.push({ cursor, limit: query.limit });
          const page = pages.shift() ?? { subjectPages: [], next: null };
          return { status: page.status ?? 200, data: { subjectPages: page.subjectPages, next: page.next } };
        },
      },
    };
  },
}));

const { feed } = await import('../src/sitemap/feeds/subjects.ts');

function entry(labels: Record<string, string>, originalLanguage?: string, lastModified?: string): Entry {
  return {
    id,
    labels: Object.entries(labels).map(([language, value]) => ({ language, value })),
    ...(originalLanguage === undefined ? {} : { originalLanguage }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
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
    const actual = feed.family(item);
    expect(actual?.paths).toEqual(expected(item));
  }
});

test('subject feed follows short and empty pages with a continuation and uses the endpoint limit', async () => {
  const first = entry({ en: 'First' }, 'en', '2026-10-29T00:00:00.000Z');
  const final = entry({ ja: '最後' }, 'ja');
  pages = [
    { subjectPages: [first], next: 'after-first' },
    { subjectPages: [], next: 'after-empty' },
    { subjectPages: [final], next: null },
  ];
  requests.length = 0;
  const collected: Entry[] = [];
  let cursor: string | null = null;
  do {
    const page = await feed.read(cursor);
    collected.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  expect(collected).toEqual([first, final]);
  expect(requests).toEqual([
    { cursor: null, limit: 1000 },
    { cursor: 'after-first', limit: 1000 },
    { cursor: 'after-empty', limit: 1000 },
  ]);
  expect(feed.family(first)?.lastmod).toBe(first.lastModified);
  expect(feed.family(final)?.lastmod).toBeUndefined();
});

test('a failed subject feed response rejects the export step without changing existing feed families', async () => {
  pages = [{ subjectPages: [], next: null, status: 503 }];
  requests.length = 0;
  await expect(feed.read(null)).rejects.toThrow('subjects returned 503');
  const { sitemapFeeds } = await import('../src/sitemap/feeds.ts');
  expect(sitemapFeeds().map(({ type }) => type)).toEqual([
    'boards',
    'collections',
    'realms',
    'spaces',
    'subjects',
    'threads',
  ]);
});
