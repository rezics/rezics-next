import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { subjectHead } from '../src/features/pages/subject-head.ts';
import { subjectPageTitle } from '../src/features/pages/subject.tsx';
import type { PagePaths } from '../src/shell/head.ts';

const id = '01a1740d-7480-71e4-841f-66c04022d7d0';
const context = '00000000-0000-8000-8000-000000000000';
const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const paths = Object.fromEntries(locales.map((locale) => [locale, `/${locale}/subjects/${id}/lamp`])) as PagePaths;
const template = (
  platform.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
    views: { overview: CompositionDocument };
  }
).views.overview;
const value = (content: unknown) => ({ type: 'value', content });

function makePage({
  type = 'schema:Book',
  labels = { en: 'The Lamp', 'zh-Hans': '灯', 'zh-Hant': '燈' },
  descriptions = {},
  aliases = {},
  statements = {},
  summary = null,
}: {
  type?: string;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  aliases?: Record<string, string[]>;
  statements?: Record<string, unknown[]>;
  summary?: unknown;
} = {}): SubjectPageData {
  const subject = {
    id,
    type,
    revision: 1,
    release: 'sha256:released',
    context,
    resolution: {},
    labels,
    descriptions,
    aliases,
    statements,
  };
  const reads: SubjectPageData['reads'] = {};
  const planned = planReads(platformRegistry, template, { subject: id }).reads;
  const subjectRead = Object.entries(planned).find(([, read]) => read.kind === 'subject');
  if (!subjectRead) throw new Error('platform subject read missing');
  reads[subjectRead[0]] = { status: 200, body: { subject, related: {}, summary } };
  for (const [key, read] of Object.entries(planned)) {
    if (key === subjectRead[0]) continue;
    reads[key] =
      read.kind === 'links'
        ? { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } }
        : read.kind === 'collections'
          ? { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } }
          : { status: 200, body: { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: '' } };
  }
  return {
    subject: id,
    profile: 'sha256:released',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: template as never,
    reads,
  };
}

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const pagePaths = (page: SubjectPageData) => paths;
const head = (page: SubjectPageData, locale = 'en', extras: Record<string, unknown> = {}) =>
  subjectHead(page, {
    origin: 'https://rezics.example.test',
    locale,
    path: paths[locale as keyof PagePaths],
    paths: pagePaths(page),
    typeLabel: 'Book',
    ...extras,
  } as never);
const meta = (result: ReturnType<typeof head>, key: string, attribute = 'name') => {
  const entry = result.meta.find((item) =>
    attribute === 'title'
      ? 'title' in item
      : attribute === 'name'
        ? 'name' in item && item.name === key
        : 'property' in item && item.property === key,
  );
  return entry && 'content' in entry ? entry.content : entry && 'title' in entry ? entry.title : undefined;
};

test('subject metadata uses the localized label, type and available year, localized plain description and card', () => {
  const long =
    'A lantern keeper follows a winding road through the old archive and discovers a secret library. '.repeat(3);
  const page = makePage({
    labels: { en: 'The Lamp', 'zh-Hans': '灯' },
    descriptions: { en: long, 'zh-Hans': '一本关于灯的故事。' },
    statements: {
      'schema:datePublished': [
        {
          id: 'date',
          rank: 'normal',
          property: { id: 'schema:datePublished', data_type: 'time' },
          value: value({ time: '+2021-00-00T00:00:00Z', precision: 9 }),
          qualifiers: [],
          references: [],
        },
      ],
    },
    summary: {
      id,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: 'The Lamp', language: 'en' },
      creativeWork: true,
      cover: {
        media: 'native-cover',
        width: 1200,
        height: 1800,
        placeholder: { thumbhash: '', color: '#777' },
        variants: [
          { format: 'webp', width: 240 },
          { format: 'webp', width: 480 },
          { format: 'webp', width: 1200 },
        ],
        focalPoint: null,
        credit: null,
      },
    },
  });

  const en = head(page);
  expect(meta(en, 'title', 'title')).toBe('The Lamp (Book, 2021) – REZICS');
  expect(meta(en, 'description')).toBe(
    long
      .trim()
      .slice(0, 160)
      .replace(/\s+\S*$/, '')
      .trimEnd(),
  );
  expect(meta(en, 'og:type', 'property')).toBe('website');
  expect(meta(en, 'og:image', 'property')).toContain('/media/native-cover/');

  const zh = head(page, 'zh-Hans');
  expect(meta(zh, 'title', 'title')).toBe('灯 (Book, 2021年) – REZICS');
  expect(meta(zh, 'description')).toBe('一本关于灯的故事。');
  expect(subjectPageTitle(page, 'zh-Hans')).toBe('灯');

  const view = head(page, 'en', { view: 'editions', viewLabel: 'Editions' });
  expect(meta(view, 'title', 'title')).toBe('The Lamp (Book, 2021) – Editions – REZICS');
});

test('structured data uses the released type, keeps the fallback mapping, and adds only public breadcrumbs', () => {
  const page = makePage({ labels: { en: 'The Lamp' }, aliases: { en: ['Old Lamp'] } });
  const releaseType = JSON.parse(
    head(page, 'en', { schemaOrgType: 'https://schema.org/CreativeWorkSeries' }).scripts[0]!.children!,
  );
  expect(releaseType['@type']).toBe('CreativeWorkSeries');
  expect(releaseType.alternateName).toEqual(['Old Lamp']);
  expect(releaseType['@graph']).toContainEqual({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'REZICS', item: 'https://rezics.example.test/en' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Book',
        item: 'https://rezics.example.test/en/search?type=schema%3ABook',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'The Lamp',
        item: 'https://rezics.example.test/en/subjects/' + id + '/the-lamp',
      },
    ],
  });

  const mapped = JSON.parse(head(page, 'en', { schemaOrgType: undefined }).scripts[0]!.children!);
  expect(mapped['@type']).toBe('Book');
  const unknown = makePage({ type: 'wd:Q5', labels: { en: 'A Person' } });
  const fallback = JSON.parse(head(unknown, 'en', { typeLabel: undefined }).scripts[0]!.children!);
  expect(fallback['@type']).toBe('Thing');
  expect(JSON.stringify(fallback)).not.toContain('Private');
});

test('aggregateRating is present only for the shown Global native average and uses its native scale', () => {
  const page = makePage({ labels: { en: 'The Lamp' } });
  const ratings = {
    figures: [
      { population: '00000000-0000-8000-8000-000000000000', count: 28, mean: 8.4, histogram: [1, 2, 3] },
      { population: 'private-realm', count: 90, mean: 9.8 },
    ],
    statistics: [{ source: 'imported', scale: { min: 1, max: 10 }, mean: 9.9, count: 100, asOf: '2026-01-01' }],
    realms: [],
    own: null,
  };
  const json = JSON.parse(head(page, 'en', { ratings }).scripts[0]!.children!);
  expect(json.aggregateRating).toEqual({
    '@type': 'AggregateRating',
    ratingValue: 8.4,
    bestRating: 20,
    worstRating: 0,
    ratingCount: 28,
  });
  expect(JSON.stringify(json)).not.toContain('imported');
  expect(JSON.stringify(json)).not.toContain('private-realm');
  const noMean = { ...ratings, figures: [{ population: '00000000-0000-8000-8000-000000000000', count: 5 }] };
  expect(JSON.parse(head(page, 'en', { ratings: noMean }).scripts[0]!.children!).aggregateRating).toBeUndefined();
});

test('thin subjects and later relations pages are noindex, while the page cover is the only high-priority image', () => {
  const thin = makePage({ labels: { en: 'The Lamp' } });
  expect(meta(head(thin), 'robots')).toBe('noindex, follow');
  expect(meta(head(thin, 'en', { view: 'relations', page: 1 }), 'robots')).toBe('noindex, follow');
  const visible = makePage({ labels: { en: 'The Lamp' }, descriptions: { en: 'A public description.' } });
  expect(meta(head(visible, 'en', { view: 'relations', page: 1 }), 'robots')).toBeUndefined();
  expect(meta(head(visible, 'en', { view: 'relations', page: 2 }), 'robots')).toBe('noindex, follow');
  expect(meta(head(visible, 'en', { view: 'editions', viewLabel: 'Editions', cursor: 'next' }), 'robots')).toBe(
    'noindex, follow',
  );

  const page = makePage({
    labels: { en: 'The Lamp' },
    descriptions: { en: 'A public description.' },
    summary: {
      id,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: 'The Lamp', language: 'en' },
      creativeWork: true,
      cover: {
        media: 'native-cover',
        width: 1200,
        height: 1800,
        placeholder: { thumbhash: '', color: '#777' },
        variants: [
          { format: 'webp', width: 240 },
          { format: 'webp', width: 1200 },
        ],
        focalPoint: null,
        credit: null,
      },
    },
  });
  const rendered = renderToString(
    createElement(SubjectPage, { page, locale: 'en', messages, renderJsonLd: false, typeLabel: 'Book' } as never),
  );
  const cover = rendered.match(/<img[^>]*fetch[Pp]riority="high"[^>]*>/g) ?? [];
  expect(cover).toHaveLength(1);
  const imagePreload = head(page).links.find((link) => link.rel === 'preload' && link.as === 'image');
  expect(imagePreload?.imagesrcset).toContain('/media/native-cover/webp-1200');
  expect(imagePreload?.imagesizes).toBeTruthy();
  expect(imagePreload?.fetchpriority).toBe('high');
});
