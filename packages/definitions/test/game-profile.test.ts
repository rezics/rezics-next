import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const uiLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const workFacets = [
  'schema:gamePlatform',
  'schema:genre',
  'schema:keywords',
  'schema:datePublished',
  'wdt:P408',
  'schema:numberOfPlayers',
];

type Mapping = {
  status: 'existing' | 'proposed' | 'omitted';
  term?: string;
  on?: string;
  reason?: string;
  profile?: Mapping;
  value?: Mapping;
  qualifiers?: Record<string, Mapping>;
};
type Inventory = {
  infobox: { id: string; fields: { id: string; mapping: Mapping }[] }[];
  enumerations: { id: string; values: { id: number | string; mapping: Mapping }[] }[];
};

function expectBundledOrOmitted(mapping: Mapping) {
  if (mapping.status === 'omitted') {
    expect(mapping.reason?.trim().length).toBeGreaterThan(15);
    expect(mapping.term).toBeUndefined();
  } else {
    expect(mapping.status).toBe('existing');
    expect(mapping.term).toBeDefined();
    expect(mapping.on).toBeDefined();
    const type = bundledRelease.types[mapping.on!];
    expect(type).toBeDefined();
    const properties = type!.properties;
    expect(
      mapping.term === mapping.on ||
        properties.includes(mapping.term!) ||
        properties.some((property) => bundledRelease.properties[property]?.qualifiers.includes(mapping.term!)),
    ).toBe(true);
  }
  if (mapping.profile) expectBundledOrOmitted(mapping.profile);
  if (mapping.value) expectBundledOrOmitted(mapping.value);
  for (const qualifier of Object.values(mapping.qualifiers ?? {})) expectBundledOrOmitted(qualifier);
}

test('a game, its releases by platform and language and its add-ons are catalogue profiles', () => {
  const { types, properties } = bundledRelease;
  const game = types['schema:VideoGame'];
  const release = types['wd:Q20631656'];
  const addOn = types['wd:Q209163'];
  expect(game?.mappings).toContain('wd:Q7889');
  expect(addOn?.mappings).toContain('wd:Q209163');

  const shared = [
    'schema:abstract',
    'schema:alternateName',
    'schema:author',
    'schema:character',
    'schema:contributor',
    'schema:datePublished',
    'schema:director',
    'schema:gamePlatform',
    'schema:genre',
    'schema:illustrator',
    'schema:inLanguage',
    'schema:keywords',
    'schema:musicBy',
    'schema:publisher',
    'wdt:P178',
    'wdt:P179',
    'wdt:P5732',
    'wdt:P725',
  ];
  for (const type of [game, addOn]) {
    expect(type?.properties).toEqual(expect.arrayContaining(shared));
    expect(type?.facets).toEqual(expect.arrayContaining(workFacets));
    expect(type?.bases).toContain('schema:CreativeWork');
  }
  expect(game?.facets).toEqual(expect.arrayContaining(workFacets));
  expect(game?.facets).toEqual(expect.arrayContaining(['wdt:P179', 'rezics:stylisticallyComparableTo']));
  expect(game?.facets).toHaveLength(17);
  expect(addOn?.properties).toContain('wdt:P8646');
  expect(addOn?.facets).toEqual(expect.arrayContaining([...workFacets, 'wdt:P8646']));
  expect(addOn?.facets?.length).toBeLessThanOrEqual(16);
  expect(release?.properties).toEqual(
    expect.arrayContaining([
      'schema:exampleOfWork',
      'schema:gamePlatform',
      'schema:inLanguage',
      'schema:datePublished',
      'schema:publisher',
      'wdt:P178',
      'wdt:P31',
      'wdt:P437',
    ]),
  );
  expect(release?.facets).toEqual(
    expect.arrayContaining(['schema:gamePlatform', 'schema:datePublished', 'schema:exampleOfWork']),
  );
  expect(properties['schema:exampleOfWork']?.targets).toEqual(['schema:CreativeWork']);
  expect(properties['schema:gamePlatform']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    mappings: ['wd:P400'],
    targets: ['skos:Concept'],
  });
  expect(properties['schema:inLanguage']).toMatchObject({ datatype: 'string', multivalued: true });
  expect(properties['wdt:P408']).toMatchObject({ datatype: 'wikibase-item', mappings: ['wd:P408'] });
  expect(properties['schema:numberOfPlayers']).toMatchObject({
    datatype: 'quantity',
    mappings: ['wd:P1873'],
    minimum: 1,
    units: ['1'],
  });
  expect(properties['wdt:P8646']).toMatchObject({ datatype: 'wikibase-item', mappings: ['wd:P8646'] });
  expect(properties['wdt:P8646']?.targets).toEqual(expect.arrayContaining(['schema:VideoGame']));
  for (const credit of [
    'schema:author',
    'schema:contributor',
    'schema:director',
    'schema:illustrator',
    'schema:musicBy',
    'schema:publisher',
    'wdt:P178',
    'wdt:P725',
  ])
    expect(properties[credit]?.qualifiers).toEqual(
      expect.arrayContaining(['wdt:P1932', 'schema:position', 'wdt:P3831']),
    );
});

test('Bangumi game fields are bundled or omitted with a reason', () => {
  const data = Bun.YAML.parse(readFileSync(new URL('../sources/bangumi.yaml', import.meta.url), 'utf8')) as Inventory;
  const subject = data.enumerations.find(({ id }) => id === 'subject.type')!;
  expectBundledOrOmitted(subject.values.find(({ id }) => String(id) === '4')!.mapping);
  const platforms = data.enumerations.find(({ id }) => id === 'platform.game')!;
  expect(platforms.values.length).toBeGreaterThan(0);
  for (const { mapping } of platforms.values) expectBundledOrOmitted(mapping);
  for (const id of ['Game', 'doujinGame']) {
    const template = data.infobox.find((entry) => entry.id === id)!;
    expect(template.fields.length).toBeGreaterThan(0);
    for (const { mapping } of template.fields) expectBundledOrOmitted(mapping);
  }
});

test('game terms carry labels in all eight UI locales', () => {
  const schema = Bun.YAML.parse(readFileSync(new URL('../catalogue/game.yaml', import.meta.url), 'utf8')) as {
    classes: Record<string, { abstract?: boolean; class_uri?: string }>;
    slots: Record<string, { slot_uri: string }>;
  };
  const types = Object.values(schema.classes)
    .filter(({ abstract }) => !abstract)
    .map(({ class_uri }) => class_uri!);
  const properties = Object.values(schema.slots).map(({ slot_uri }) => slot_uri);
  for (const locale of uiLocales) {
    const presentation = Bun.YAML.parse(
      readFileSync(new URL(`../presentation/game/${locale}.yaml`, import.meta.url), 'utf8'),
    ) as { types: Record<string, string>; properties: Record<string, string> };
    for (const term of types) {
      expect(presentation.types[term]?.trim().length).toBeGreaterThan(0);
      expect(bundledRelease.types[term]?.labels[locale]).toBe(presentation.types[term]);
    }
    for (const term of properties) {
      expect(presentation.properties[term]?.trim().length).toBeGreaterThan(0);
      expect(bundledRelease.properties[term]?.labels[locale]).toBe(presentation.properties[term]);
    }
  }
});
