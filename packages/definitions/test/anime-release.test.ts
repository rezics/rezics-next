import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { UI_LOCALES, platformRegistry, validateZoneStarter } from '@rezics/composition';
import { bundledRelease } from '../src/bundled.ts';

const releaseType = 'rezics:AnimeRelease';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('anime publications use a distinct unprofiled CreativeWork grain and standard release relations', () => {
  const type = bundledRelease.types[releaseType]!;
  expect(type).toMatchObject({
    iri: 'https://rezics.com/vocab/AnimeRelease',
    bases: ['schema:CreativeWork', 'schema:Thing'],
    mappings: [],
    schemaOrgType: 'https://schema.org/CreativeWork',
    coverRatio: '5:7',
  });
  expect(type.library).toBeUndefined();
  for (const property of [
    'schema:exampleOfWork',
    'bf:hasPart',
    'marcrel:fds',
    'schema:inLanguage',
    'schema:datePublished',
    'wdt:P437',
    'schema:publisher',
    'schema:translator',
  ])
    expect(type.properties).toContain(property);
  for (const property of ['wdt:P5732', 'wdt:P3180', 'schema:episodeNumber', 'schema:isPartOf', 'wdt:P7937'])
    expect(type.properties).not.toContain(property);
  for (const property of ['bf:hasPart', 'marcrel:fds']) {
    const definition = bundledRelease.properties[property]!;
    expect(definition.mappings).toEqual([]);
    expect(definition.multivalued).toBe(true);
    for (const locale of UI_LOCALES) {
      expect(definition.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(definition.relation?.inverseLabels?.[locale]?.trim().length).toBeGreaterThan(0);
      expect(type.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(type.descriptions?.[locale]?.trim().length).toBeGreaterThan(0);
    }
  }
  expect(bundledRelease.properties['bf:partOf']).toBeUndefined();
  expect(bundledRelease.properties['rezics:filmDistributionOf']).toBeUndefined();
  expect(bundledRelease.properties['schema:exampleOfWork']!.targets).toEqual(['schema:CreativeWork']);
  for (const work of ['schema:TVSeries', 'schema:TVSeason', 'schema:Episode', 'schema:Movie']) {
    expect(bundledRelease.types[work]!.properties).not.toContain('bf:hasPart');
    expect(bundledRelease.types[work]!.properties).not.toContain('marcrel:fds');
  }
});

test('anime release discovery has its own saved filter and inert TypeList without changing work scopes', () => {
  expect(bundledRelease.filters?.['anime/releases']?.filter).toEqual({ type: { in: [releaseType] } });
  for (const locale of UI_LOCALES)
    expect(bundledRelease.filters?.['anime/releases']?.labels[locale]?.trim().length).toBeGreaterThan(0);
  expect(bundledRelease.filters?.['anime/all']?.filter).toEqual({
    type: { in: ['schema:Movie', 'schema:TVSeries'] },
  });
  expect(bundledRelease.filters?.['anime/films']?.filter).toEqual({ type: { in: ['schema:Movie'] } });
  expect(bundledRelease.filters?.['anime/series']?.filter).toEqual({ type: { in: ['schema:TVSeries'] } });
  expect(bundledRelease.filters?.['anime/before-2000']?.filter).toEqual({
    and: [
      { type: { in: ['schema:Movie', 'schema:TVSeries'] } },
      { statement: { property: 'schema:datePublished', range: { lte: 1999 } } },
    ],
  });
  expect(bundledRelease.contexts?.anime?.defaults).toEqual({});
  const starter = JSON.parse(read('presentation/anime/zone.json')) as {
    scope: string[];
    pages: {
      route: string;
      document: { content: { props: { children: { type: string; props: Record<string, unknown> }[] } }[] };
    }[];
  };
  expect(
    validateZoneStarter(platformRegistry, starter, { filters: new Set(Object.keys(bundledRelease.filters!)) }),
  ).toEqual([]);
  expect(starter.scope).toContain('anime/releases');
  const pages = starter.pages.filter((page) => page.route === 'releases');
  expect(pages).toHaveLength(1);
  const lists = pages[0]!.document.content[0]!.props.children.filter((node) => node.type === 'TypeList');
  expect(lists).toHaveLength(1);
  expect(lists[0]!.props).toEqual({
    id: 'releases',
    title: bundledRelease.filters!['anime/releases']!.labels,
    types: [releaseType],
    sort: 'name',
    limit: 24,
  });
});
