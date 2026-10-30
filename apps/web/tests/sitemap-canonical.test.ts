import { expect, mock, test } from 'bun:test';
import type { Kernel } from '@rezics/client';
import { locales } from '../src/paraglide/runtime.js';
import { pageLinks, type PagePaths } from '../src/shell/head.ts';
import { subjectViewPaths } from '../src/subject/subject-href.ts';
import { sitemapFamilyFromPagePaths, sitemapPagePaths } from '../src/sitemap/url.ts';
import { familyXml } from '../src/sitemap/xml.ts';

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

function endpoint<T>(name: string, data: () => T) {
  return {
    async get({ query }: { query: { cursor?: string; limit: number } }) {
      calls.push({ name, query });
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
  for (const pagePaths of [subjectPaths, subjectViewPaths(subjectPaths, 'details'), paths('/@CurrentHandle/works')]) {
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

test('missing native projections reject even empty pages and native errors keep the bounded request contract', async () => {
  calls.length = 0;
  for (const feed of [createSubjectFeed(), createRealmFeed(), createSpaceFeed()]) {
    await expect(feed.read('opaque-current-cursor')).rejects.toMatchObject({ status: 503 });
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
});

test('ready adapters retain source identity and cursors and map only owner supplied canonical families', async () => {
  subjects = { subjectPages: [{ id, labels: [{ language: 'ja', value: '原題' }] }], next: 'after-source' };
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

  realms = { items: [{ id, lastModified }], next: 'realm-cursor' };
  const carried = createRealmFeed(() => ({ kind: 'space', spaceId: id, address: 'current-space' }));
  expect(await carried.read(null)).toBe(realms);
  expect(carried.family(realms.items[0]!)?.paths.en).toBe('/en/spaces/current-space');
  expect(carried.family(realms.items[0]!)?.lastmod).toBeUndefined();
  const standaloneRealm = createRealmFeed(() => ({ kind: 'realm', realmId: id }));
  expect(standaloneRealm.family(realms.items[0]!)?.paths.en).toBe(`/en/realms/${id}`);

  spaces = { items: [{ id, address: 'standalone-space', lastModified }], next: 'space-cursor' };
  const standalone = createSpaceFeed((page) => page);
  expect(await standalone.read(null)).toBe(spaces);
  expect(standalone.family(spaces.items[0]!)?.paths.en).toBe('/en/spaces/standalone-space');
  expect(standalone.family(spaces.items[0]!)?.lastmod).toBeUndefined();
});
