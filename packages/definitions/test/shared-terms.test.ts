import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import type { Release } from '../src/index.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const roles = {
  'schema:author': 'wd:P50',
  'schema:translator': 'wd:P655',
  'schema:publisher': 'wd:P123',
  'schema:illustrator': 'wd:P110',
  'schema:director': 'wd:P57',
  'schema:musicBy': 'wd:P86',
  'schema:producer': 'wd:P162',
  'schema:productionCompany': 'wd:P272',
  'wdt:P58': 'wd:P58',
  'wdt:P178': 'wd:P178',
  'wdt:P725': 'wd:P725',
  'schema:contributor': 'wd:P767',
};
const sharedProperties = [
  ...Object.keys(roles).filter((key) => !['schema:author', 'schema:translator', 'schema:publisher'].includes(key)),
  'wdt:P1932',
  'wdt:P3831',
  'wdt:P453',
  'schema:character',
  'rezics:spoilerLevel',
  'skos:inScheme',
  'skos:broader',
  'foaf:focus',
  'schema:genre',
  'schema:keywords',
  'wdt:P179',
];

type Source = {
  classes: Record<string, { abstract?: boolean; is_a?: string; class_uri?: string; slots?: string[] }>;
  slots: Record<string, { slot_uri?: string; range?: string }>;
};
const source = (name: string) => Bun.YAML.parse(bundledSources().schemas[`${name}.yaml`]!) as Source;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Future verticals must extend the anchors without editing the shared ranges.
function extendedSources() {
  const sources = bundledSources();
  sources.schemas['fixture.yaml'] = JSON.stringify({
    id: 'https://rezics.com/catalogue/shared-fixture',
    name: 'shared_fixture',
    version: '1.0.0',
    imports: ['rezics'],
    prefixes: { ex: 'https://example.org/' },
    classes: {
      FixtureWork: { is_a: 'CreativeWork', class_uri: 'ex:Work' },
      FixtureCharacter: { is_a: 'Character', class_uri: 'ex:Character' },
      FixtureSeries: { is_a: 'CreativeWorkSeries', class_uri: 'ex:Series' },
    },
  });
  sources.root = 'fixture.yaml';
  sources.presentation['fixture/en'] = JSON.stringify({
    types: { 'ex:Work': 'fixture work', 'ex:Character': 'fixture character', 'ex:Series': 'fixture series' },
  });
  return sources;
}

let extendedReleaseCompilation: Promise<Release> | undefined;
function compileExtendedRelease(): Promise<Release> {
  extendedReleaseCompilation ??= compileCatalogue(freeze(extendedSources())).then(freeze);
  return extendedReleaseCompilation;
}
async function extendedRelease(): Promise<Release> {
  return structuredClone(await compileExtendedRelease());
}

test('a credit is a role statement qualified by credited-as, order and detailed role', () => {
  const { properties, types } = bundledRelease;
  for (const [key, mapping] of Object.entries(roles)) {
    expect(properties[key]).toMatchObject({
      datatype: 'wikibase-item',
      multivalued: true,
      targets: ['schema:Organization', 'schema:Person'],
      mappings: [mapping],
    });
    expect(properties[key]!.qualifiers).toEqual(expect.arrayContaining(['wdt:P1932', 'schema:position', 'wdt:P3831']));
  }
  expect(properties['schema:author']!.qualifiers).toEqual(
    expect.arrayContaining(['wdt:P648', 'wdt:P6298', 'wdt:P3180', 'schema:sameAs']),
  );
  expect(properties['schema:translator']!.qualifiers).toEqual(expect.arrayContaining(['wdt:P648', 'schema:sameAs']));
  expect(properties['schema:publisher']!.qualifiers).toEqual(expect.arrayContaining(['wdt:P3180', 'schema:sameAs']));
  expect(properties['wdt:P1932']).toMatchObject({ datatype: 'string' });
  expect(properties['wdt:P3831']).toMatchObject({ datatype: 'wikibase-item', targets: ['skos:Concept'] });
  expect(properties['schema:position']).toMatchObject({ datatype: 'string', mappings: ['wd:P1545'] });
  const core = source('core');
  expect(core.classes.CreativeWork).toMatchObject({
    abstract: true,
    is_a: 'Thing',
    class_uri: 'schema:CreativeWork',
  });
  const attachedRoles = (core.classes.CreativeWork!.slots ?? []).map((slot) => core.slots[slot]?.slot_uri);
  expect(attachedRoles.filter((key) => key && key in roles)).toEqual(['schema:contributor']);
  for (const key of [
    'schema:Book',
    'bf:Instance',
    'schema:MusicAlbum',
    'schema:TVSeries',
    'schema:VideoGame',
    'wd:Q689445',
  ])
    expect(types[key]!.properties).toContain('schema:contributor');
  expect(source('book').classes.Work!.is_a).toBe('CreativeWork');
  expect(source('book').classes.Edition!.is_a).toBe('CreativeWork');
  expect(source('works').classes.LaunchWork!.is_a).toBe('CreativeWork');
});

test('an appearance is a character statement qualified by its role and a voice actor names the character', async () => {
  expect(source('core').classes.Character).toMatchObject({ abstract: true, is_a: 'Thing' });
  const release = await extendedRelease();
  expect(release.properties['schema:character']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['ex:Character', 'wd:Q95074'],
    mappings: ['wd:P674'],
    qualifiers: ['rezics:spoilerLevel', 'wdt:P1932', 'wdt:P3831', 'wdt:P518'],
  });
  expect(release.properties['wdt:P453']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['ex:Character', 'wd:Q95074'],
  });
  expect(release.properties['wdt:P725']!.qualifiers).toContain('wdt:P453');
  expect(release.properties['rezics:spoilerLevel']).toMatchObject({
    iri: 'https://rezics.com/vocab/spoilerLevel',
    datatype: 'quantity',
    minimum: 0,
    maximum: 2,
    units: ['1'],
  });
});

test('shared fixture results are isolated from one another', async () => {
  const compilation = compileExtendedRelease();
  expect(compileExtendedRelease()).toBe(compilation);
  const result = await compilation;
  expect(Object.isFrozen(result.types['ex:Work']!.properties)).toBe(true);
  const [first, second] = await Promise.all([extendedRelease(), extendedRelease()]);
  first.types['ex:Work']!.properties.push('ex:localChange');
  expect(second.types['ex:Work']!.properties).not.toContain('ex:localChange');
});

test('genres, tags and detailed roles are SKOS concepts and a concept focuses on any subject', async () => {
  const { types, properties } = bundledRelease;
  expect(types['skos:Concept']).toBeDefined();
  expect(types['skos:ConceptScheme']).toBeDefined();
  expect(types['skos:Concept']!.properties).toEqual(
    expect.arrayContaining(['skos:inScheme', 'skos:broader', 'foaf:focus']),
  );
  for (const key of ['skos:Concept', 'skos:ConceptScheme'])
    expect(types[key]!.properties).toEqual(expect.arrayContaining(['schema:url', 'schema:name']));
  expect(properties['skos:inScheme']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['skos:ConceptScheme'],
  });
  expect(properties['skos:broader']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['skos:Concept'],
  });
  for (const key of ['schema:genre', 'schema:keywords']) {
    expect(properties[key]).toMatchObject({
      datatype: 'wikibase-item',
      multivalued: true,
      targets: ['skos:Concept'],
      qualifiers: ['rezics:spoilerLevel'],
    });
    for (const type of [
      'schema:Book',
      'bf:Instance',
      'schema:TVSeries',
      'schema:MusicAlbum',
      'schema:VideoGame',
      'wd:Q689445',
    ])
      expect(types[type]!.properties).toContain(key);
  }
  expect(properties['schema:genre']!.mappings).toContain('wd:P136');
  const release = await extendedRelease();
  expect(release.properties['foaf:focus']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['schema:Thing'],
  });
  expect(release.properties['schema:exampleOfWork']!.targets).toEqual(['schema:CreativeWork']);
});

test('series membership is a statement on the member with its order', async () => {
  expect(source('core').classes.CreativeWorkSeries).toMatchObject({
    abstract: true,
    is_a: 'CreativeWork',
    class_uri: 'schema:CreativeWorkSeries',
  });
  const release = await extendedRelease();
  expect(release.properties['wdt:P179']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['schema:CreativeWorkSeries'],
    qualifiers: ['schema:position'],
  });
  for (const type of [
    'schema:Book',
    'bf:Instance',
    'schema:TVSeries',
    'schema:MusicAlbum',
    'schema:VideoGame',
    'wd:Q689445',
    'ex:Work',
  ])
    expect(release.types[type]!.properties).toContain('wdt:P179');
  expect(release.properties['schema:position']!.mappings).toContain('wd:P1545');
});

test('shared terms carry labels in all eight UI locales', () => {
  for (const key of sharedProperties) {
    const term = bundledRelease.properties[key];
    expect(term).toBeDefined();
    expect(Object.keys(term!.labels).sort()).toEqual(locales);
    for (const label of Object.values(term!.labels)) expect(label.trim().length).toBeGreaterThan(0);
  }
  for (const key of ['skos:Concept', 'skos:ConceptScheme']) {
    const term = bundledRelease.types[key];
    expect(term).toBeDefined();
    expect(Object.keys(term!.labels).sort()).toEqual(locales);
  }
});
