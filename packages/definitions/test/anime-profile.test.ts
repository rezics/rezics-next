import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '../src/bundled.ts';

const uiLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

type Mapping = {
  status: 'existing' | 'proposed' | 'omitted';
  term?: string;
  on?: string;
  reason?: string;
  profile?: Mapping;
};
type Field = { id: string | number; mapping: Mapping };
type Inventory = {
  files: { id: string; type: Mapping; fields: Field[] }[];
  infobox: { id: string; fields: Field[] }[];
  enumerations: { id: string; values: Field[] }[];
};

const inventory = () =>
  Bun.YAML.parse(readFileSync(new URL('../sources/bangumi.yaml', import.meta.url), 'utf8')) as Inventory;

function expectBundledOrOmitted(mapping: Mapping) {
  if (mapping.status === 'omitted') {
    expect(mapping.reason?.trim().length).toBeGreaterThan(15);
    expect(mapping.term).toBeUndefined();
    return;
  }

  expect(mapping.status).toBe('existing');
  expect(mapping.term).toBeDefined();
  expect(mapping.on).toBeDefined();
  const type = bundledRelease.types[mapping.on!];
  expect(type).toBeDefined();
  expect(mapping.term === mapping.on || type!.properties.includes(mapping.term!)).toBe(true);
}

test('an anime work, its seasons, episodes and releases are catalogue profiles', () => {
  const { types, properties } = bundledRelease;

  expect(types['schema:TVSeries']).toMatchObject({ mappings: ['wd:Q5398426'] });
  expect(types['schema:Movie']).toBeDefined();
  expect(types['schema:Movie']?.mappings).toContain('wd:Q11424');
  expect(types['schema:TVSeason']).toBeDefined();
  expect(types['schema:Episode']).toBeDefined();
  expect(types['schema:Movie']!.properties).toEqual(
    expect.arrayContaining(['wdt:P5732', 'schema:url', 'schema:datePublished', 'schema:duration']),
  );
  expect(types['schema:TVSeason']!.properties).toEqual(
    expect.arrayContaining(['wdt:P5732', 'schema:url', 'schema:name', 'schema:datePublished']),
  );

  for (const type of ['schema:TVSeries', 'schema:Movie', 'schema:TVSeason']) {
    expect(types[type]!.properties).toContain('wdt:P5732');
    expect(types[type]!.properties).toEqual(expect.arrayContaining(['schema:genre', 'schema:keywords', 'wdt:P179']));
  }
  expect(types['schema:TVSeries']!.facets).toEqual(expect.arrayContaining([
    'wdt:P7937',
    'schema:genre',
    'schema:keywords',
    'schema:datePublished',
    'schema:numberOfEpisodes',
  ]));
  expect(types['schema:TVSeries']!.facets.length).toBeLessThanOrEqual(16);
  expect(types['schema:Movie']!.facets).toEqual(expect.arrayContaining([
    'wdt:P7937',
    'schema:genre',
    'schema:keywords',
    'schema:datePublished',
  ]));
  expect(types['schema:Movie']!.facets.length).toBeLessThanOrEqual(16);
  expect(types['schema:TVSeason']!.facets).toEqual(expect.arrayContaining([
    'wdt:P7937',
    'schema:genre',
    'schema:keywords',
    'schema:datePublished',
    'schema:numberOfEpisodes',
  ]));
  expect(types['schema:TVSeason']!.facets.length).toBeLessThanOrEqual(16);
  expect(types['schema:Episode']!.properties).toEqual(
    expect.arrayContaining(['schema:url', 'schema:name', 'schema:datePublished', 'schema:episodeNumber']),
  );
  expect(types['schema:Episode']!.facets).toEqual(
    expect.arrayContaining(['schema:isPartOf', 'schema:datePublished', 'schema:duration']),
  );
  expect(types['schema:Episode']!.facets.length).toBeLessThanOrEqual(16);
  expect(properties['schema:episodeNumber']).toMatchObject({
    datatype: 'string',
    mappings: ['wd:P1545'],
  });
  expect(properties['schema:isPartOf']).toMatchObject({
    datatype: 'wikibase-item',
    mappings: ['wd:P361'],
    targets: ['schema:TVSeason', 'schema:TVSeries'],
  });
});

test('Bangumi anime subject and episode fields are bundled or omitted with a reason', () => {
  const data = inventory();
  const animeSubjectType = data.enumerations
    .find(({ id }) => id === 'subject.type')!
    .values.find(({ id }) => String(id) === '2')!.mapping;
  expectBundledOrOmitted(animeSubjectType);

  const animePlatforms = data.enumerations.find(({ id }) => id === 'platform.anime')!;
  for (const { mapping } of animePlatforms.values) {
    expectBundledOrOmitted(mapping);
    if (mapping.profile) expectBundledOrOmitted(mapping.profile);
  }

  for (const template of ['TVAnime', 'OVA', 'Movie', 'Anime']) {
    const fields = data.infobox.find(({ id }) => id === template)!.fields;
    for (const { mapping } of fields) expectBundledOrOmitted(mapping);
  }

  const episode = data.files.find(({ id }) => id === 'episode')!;
  expectBundledOrOmitted(episode.type);
  for (const { mapping } of episode.fields) expectBundledOrOmitted(mapping);
});

test('anime terms carry labels in all eight UI locales', () => {
  const schema = Bun.YAML.parse(readFileSync(new URL('../catalogue/anime.yaml', import.meta.url), 'utf8')) as {
    classes?: Record<string, { class_uri?: string; slots?: string[] }>;
    slots?: Record<string, { slot_uri?: string }>;
  };
  const classes = schema.classes ?? {};
  const slots = schema.slots ?? {};
  const types = Object.values(classes)
    .map(({ class_uri }) => class_uri)
    .filter((term): term is string => term !== undefined);
  const properties = Object.values(slots)
    .map(({ slot_uri }) => slot_uri)
    .filter((term): term is string => term !== undefined);

  for (const locale of uiLocales) {
    const presentation = Bun.YAML.parse(
      readFileSync(new URL(`../presentation/anime/${locale}.yaml`, import.meta.url), 'utf8'),
    ) as { types?: Record<string, string>; properties?: Record<string, string> };
    for (const term of types) {
      expect(presentation.types?.[term]).toEqual(expect.any(String));
      expect(presentation.types![term]!.trim().length).toBeGreaterThan(0);
    }
    for (const term of properties) {
      expect(presentation.properties?.[term]).toEqual(expect.any(String));
      expect(presentation.properties![term]!.trim().length).toBeGreaterThan(0);
    }
  }
});
