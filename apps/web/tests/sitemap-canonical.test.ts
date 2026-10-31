import { expect, mock, test } from 'bun:test';
import type { Kernel } from '@rezics/client';
import { locales } from '../src/paraglide/runtime.js';
import { pageLinks, type PagePaths } from '../src/shell/head.ts';
import { subjectViewPaths } from '../src/subject/subject-href.ts';
import { sitemapFamilyFromPagePaths, sitemapPagePaths } from '../src/sitemap/url.ts';
import { familyXml } from '../src/sitemap/xml.ts';
import { subjectCanonicalPage } from '../src/sitemap/subject-canonical.ts';

type SubjectPage = Kernel['~Routes']['v1']['subject-pages']['get']['response'][200];
type RealmPage = Kernel['~Routes']['v1']['sitemap']['realms']['get']['response'][200];
type SpacePage = Kernel['~Routes']['v1']['sitemap']['spaces']['get']['response'][200];
const id = '01a1740d-7480-71e4-841f-66c04022d7d0';
const lastModified = '2026-10-29T00:00:00.000Z';
const calls: { name: string; query: { cursor?: string; limit: number } }[] = [];
let status = 200;
let subjects: SubjectPage = { subjectPages: [], next: null };
let realms: RealmPage = { items: [], next: null };
let spaces: SpacePage = { items: [], next: null };
let failure: Error | undefined;

function endpoint<T>(name: string, data: () => T) {
  return {
    async get({ query }: { query: { cursor?: string; limit: number } }) {
      calls.push({ name, query });
      if (failure) throw failure;
      return { status, data: data() };
    },
  };
}
mock.module('../src/kernel/client.ts', () => ({
  kernelClient: () => ({
    'subject-pages': endpoint('subjects', () => subjects),
    sitemap: { realms: endpoint('realms', () => realms), spaces: endpoint('spaces', () => spaces) },
  }),
}));
const { createSubjectFeed } = await import('../src/sitemap/feeds/subjects.ts');
const { createRealmFeed } = await import('../src/sitemap/feeds/realms.ts');
const { createSpaceFeed } = await import('../src/sitemap/feeds/spaces.ts');

function paths(path: string): PagePaths {
  return Object.fromEntries(locales.map((locale) => [locale, path])) as PagePaths;
}

test('canonical reader paths reach sitemap and HTML unchanged across sparse languages, views and current accounts', () => {
  // Already resolved public paths: the exporter must not reselect a fallback label or infer an account handle.
  const subjectPaths = paths(`/subjects/${id}/original-title`);
  subjectPaths.fr = `/subjects/${id}/titre-français`;
  for (const pagePaths of [
    subjectPaths,
    subjectViewPaths(subjectPaths, 'details'),
    paths('/@CurrentHandle'),
    paths('/@CurrentHandle/works'),
    paths('/@CurrentHandle/posts'),
    paths('/@CurrentHandle/reviews'),
    paths('/@CurrentHandle/collections'),
  ]) {
    const family = sitemapFamilyFromPagePaths(pagePaths);
    expect(sitemapPagePaths(family.paths)).toEqual(pagePaths);
    expect(family.lastmod).toBeUndefined();
    const xml = familyXml('https://public.example', family.paths);
    expect(xml.urls).toHaveLength(8);
    expect(xml.xml.match(/<xhtml:link /gu)).toHaveLength(64);
    for (const locale of locales) {
      const links = pageLinks('https://public.example', locale, '/', pagePaths);
      expect(xml.urls).toContain(links[0]!.href);
      for (const alternate of locales)
        expect(links).toContainEqual({
          rel: 'alternate',
          hrefLang: alternate,
          href: `https://public.example${family.paths[alternate]}`,
        });
    }
  }
  expect(sitemapFamilyFromPagePaths(subjectPaths, lastModified).lastmod).toBe(lastModified);
  for (const path of ['https://other.example/page', '//other.example/page', '/en/subjects/id/title', '/page?filter=1'])
    expect(() => sitemapFamilyFromPagePaths(paths(path))).toThrow('Invalid canonical page path');
});

test('delivered defaults retain ready empty continuations and native errors keep the bounded request contract', async () => {
  calls.length = 0;
  subjects = { subjectPages: [], next: 'subject-empty-next' };
  realms = { items: [], next: 'realm-empty-next' };
  spaces = { items: [], next: 'space-empty-next' };
  for (const feed of [createSubjectFeed(), createRealmFeed(), createSpaceFeed()]) {
    expect(await feed.read('opaque-current-cursor')).toEqual({
      items: [],
      next: `${feed.type.slice(0, -1)}-empty-next`,
    });
    expect(calls.at(-1)).toEqual({ name: feed.type, query: { cursor: 'opaque-current-cursor', limit: 1_000 } });
  }
  expect(calls).toHaveLength(3);
  status = 503;
  try {
    await expect(createSubjectFeed().read(null)).rejects.toThrow('subjects returned 503');
    expect(calls.at(-1)).toEqual({ name: 'subjects', query: { limit: 1_000 } });
  } finally {
    status = 200;
  }
  failure = new Error('native transport unavailable');
  try {
    await expect(createSubjectFeed().read(null)).rejects.toBe(failure);
  } finally {
    failure = undefined;
  }
  expect(calls).toHaveLength(5);
});

test('ready adapters retain source identity and cursors and map only owner supplied canonical families', async () => {
  subjects = {
    subjectPages: [
      {
        id,
        target: { family: 'subject', subjectId: id },
        views: ['overview'],
        labels: [{ language: 'ja', value: '原題' }],
      },
    ],
    next: 'after-source',
  };
  const family = sitemapFamilyFromPagePaths(paths('/@CurrentHandle/works'));
  const subjectFeed = createSubjectFeed((page) => ({
    items: page.subjectPages.map((item) => ({ id: item.id, key: `${item.id.slice(24, 28)}${item.id}`, family })),
    next: page.next,
  }));
  const page = await subjectFeed.read(null);
  expect(page.next).toBe('after-source');
  expect(page.items[0]!.id).toBe(id);
  expect(subjectFeed.family(page.items[0]!)).toBe(family);
  subjects = { subjectPages: [], next: 'after-empty' };
  expect(await subjectFeed.read('after-source')).toEqual({ items: [], next: 'after-empty' });

  realms = {
    items: [{ id, lastModified, canonicalDestination: { kind: 'space', spaceId: id, address: 'current-space' } }],
    next: 'realm-cursor',
  };
  const carried = createRealmFeed(() => ({ kind: 'space', spaceId: id, address: 'current-space' }));
  expect(await carried.read(null)).toBe(realms);
  expect(carried.family(realms.items[0]!)?.paths.en).toBe('/en/spaces/current-space');
  expect(carried.family(realms.items[0]!)?.lastmod).toBeUndefined();
  expect(createRealmFeed().family(realms.items[0]!)).toEqual(carried.family(realms.items[0]!));
  const standaloneRealm = createRealmFeed(() => ({ kind: 'realm', realmId: id }));
  expect(standaloneRealm.family(realms.items[0]!)?.paths.en).toBe(`/en/realms/${id}`);

  spaces = { items: [{ id, address: 'standalone-space', lastModified }], next: 'space-cursor' };
  const standalone = createSpaceFeed((page) => page);
  expect(await standalone.read(null)).toBe(spaces);
  expect(standalone.family(spaces.items[0]!)?.paths.en).toBe('/en/spaces/standalone-space');
  expect(standalone.family(spaces.items[0]!)?.lastmod).toBeUndefined();
  expect(createSpaceFeed().family(spaces.items[0]!)).toEqual(standalone.family(spaces.items[0]!));
});

test('missing or invalid required native targets and views refuse projection instead of guessing a successful family', async () => {
  const item: SubjectPage['subjectPages'][number] = {
    id,
    labels: [{ language: 'en', value: 'Title only is not eligibility' }],
    target: { family: 'subject', subjectId: id },
    views: ['overview'],
  };
  const invalid = [
    { ...item, target: undefined },
    { ...item, target: { family: 'subject', subjectId: id.replace(/0$/u, '1') } },
    { ...item, target: { family: 'unknown' } },
    { ...item, views: undefined },
    { ...item, views: null },
    { ...item, views: 'overview' },
    { ...item, views: ['overview', 'overview'] },
    { ...item, views: ['details', 'overview'] },
    { ...item, views: ['overview', 'editor'] },
    ...['works', 'details'].map((view) => ({
      ...item,
      target: { family: 'account', accountId: id, canonicalPath: '/@CurrentHandle' },
      views: ['overview', view],
    })),
    { ...item, target: { family: 'account', accountId: 'not-an-account', canonicalPath: '/@CurrentHandle' } },
    { ...item, target: { family: 'account', accountId: id, canonicalPath: null } },
    ...[
      '',
      '/@',
      '/accounts/id',
      '//elsewhere/@handle',
      '/@handle/works',
      '/@handle?filter=1',
      '/@handle#fragment',
      '/en/@handle',
      '/@%ZZ',
      '/@%2Fother',
    ].map((canonicalPath) => ({ ...item, target: { family: 'account', accountId: id, canonicalPath } })),
  ];
  calls.length = 0;
  for (const bad of invalid) {
    subjects = { subjectPages: [bad], next: 'unchanged-native-next' } as SubjectPage;
    await expect(createSubjectFeed().read(null)).rejects.toMatchObject({ status: 503 });
  }
  expect(calls).toHaveLength(invalid.length);
  expect(calls.every(({ name, query }) => name === 'subjects' && query.limit === 1_000)).toBe(true);
  expect(() => subjectCanonicalPage({ subjectPages: Array(1_001).fill(item), next: null })).toThrow('bounded native');
  for (const subjectPages of [
    [item, item],
    [
      {
        ...item,
        id: id.replace(/0$/u, '1'),
        target: { family: 'subject' as const, subjectId: id.replace(/0$/u, '1') },
      },
      item,
    ],
  ])
    expect(() => subjectCanonicalPage({ subjectPages, next: null })).toThrow('source order');
});

test('existing default sitemap canonical projection consumes actual native admitted Account views while retaining canonical overview raw source identity sparse cursor explicit missing-data failure and current native authority without extra IO', async () => {
  calls.length = 0;
  const admitted = [
    ['overview', 'posts', 'reviews', 'collections'],
    ['overview'],
    ['posts'],
    ['reviews'],
    ['collections'],
    ['posts', 'collections'],
  ];
  let allKeys: string[] = [];
  for (const views of admitted) {
    const item: SubjectPage['subjectPages'][number] = {
      id,
      labels: [{ language: 'fr', value: 'Never a handle or permission' }],
      target: { family: 'account', accountId: id.replace(/0$/u, '1'), canonicalPath: '/@CurrentHandle' },
      views,
      lastModified,
    };
    subjects = { subjectPages: [item], next: 'native-next' };
    const feed = createSubjectFeed();
    const page = await feed.read('native-current');
    expect(page.next).toBe('native-next');
    expect(page.items.map(({ id }) => id)).toEqual(views.map(() => item.id));
    expect(page.items).toHaveLength(views.length);
    const keys = page.items.map((entry) => feed.key!(entry));
    if (views.length === 4) allKeys = keys;
    expect(keys).toEqual(views.map((view) => allKeys[admitted[0]!.indexOf(view)]!));
    for (const [index, view] of views.entries()) {
      const family = feed.family(page.items[index]!)!;
      const canonical = paths(`/@CurrentHandle${view === 'overview' ? '' : `/${view}`}`);
      expect(family).toEqual(sitemapFamilyFromPagePaths(canonical, lastModified));
      const xml = familyXml('https://public.example', family.paths, family.lastmod);
      expect(xml.urls).toHaveLength(8);
      for (const locale of locales) {
        const links = pageLinks('https://public.example', locale, '/', canonical);
        expect(xml.urls).toContain(links[0]!.href);
      }
    }
    const ordinary = { ...item, target: { family: 'subject' as const, subjectId: id } };
    const ordinaryItems = subjectCanonicalPage({ subjectPages: [ordinary], next: null }).items;
    expect(ordinaryItems).toHaveLength(views.length);
    for (const [index, view] of views.entries())
      if (view !== 'overview') expect(ordinaryItems[index]!.family?.paths.en).toEndWith(`/${view}`);
  }
  expect(allKeys).toEqual(['00', '08', '09', '12'].map((suffix) => `${id.slice(24, 28)}${id}:${suffix}`));
  expect(calls).toEqual(admitted.map(() => ({ name: 'subjects', query: { cursor: 'native-current', limit: 1_000 } })));
});

test('projection injection cannot drop reorder or replace native source identities or change a continuation', async () => {
  const second = id.replace(/0$/u, '1');
  subjects = {
    subjectPages: [id, second].map((id) => ({
      id,
      labels: [],
      target: { family: 'subject', subjectId: id },
      views: ['overview'],
    })),
    next: 'native-next',
  };
  const item = (id: string) => ({ id, key: id, family: null });
  for (const items of [[], [item(id)], [item(second), item(id)], [item(id), item('not-native')]])
    await expect(createSubjectFeed(() => ({ items, next: subjects.next })).read(null)).rejects.toThrow(
      'native source identity',
    );
  await expect(
    createSubjectFeed(() => ({ items: [item(id), item(second)], next: 'invented' })).read(null),
  ).rejects.toThrow('native cursor');
});
