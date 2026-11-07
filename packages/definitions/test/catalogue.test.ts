import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease } from '../src/index.ts';

const uiLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

test('the committed bundled release is the compilation of the bundled catalogue', async () => {
  const sources = bundledSources();
  expect(sources.root).toBe('rezics.yaml');
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(sources.presentation)) {
    const match = /^([a-z][a-z0-9-]{0,63})\/([^/]+)$/u.exec(key);
    expect(match).not.toBeNull();
    const group = match?.[1] ?? '';
    const locale = match?.[2] ?? '';
    expect(uiLocales).toContain(locale);
    groups.set(group, [...(groups.get(group) ?? []), locale]);
  }
  for (const locales of groups.values()) expect([...locales].sort()).toEqual(uiLocales);
  expect(await compileCatalogue(sources)).toEqual(bundledRelease);
  expect(validateRelease(bundledRelease)).toEqual([]);
  expect(bundledDigest).toBe(releaseDigest(bundledRelease));
});

test('book work, edition and recipe are profiles of the catalogue', () => {
  const { types, properties } = bundledRelease;
  expect(bundledRelease.catalogue).toEqual({ id: 'https://rezics.com/catalogue/rezics', version: '1.0.10' });
  expect(Object.keys(types)).toEqual(expect.arrayContaining(['bf:Instance', 'schema:Book', 'schema:Recipe']));
  expect(types['schema:Book']).toMatchObject({
    mappings: ['wd:Q47461344'],
    properties: [
      'rezics:alternativeSetting',
      'rezics:alternativeVersion',
      'rezics:artbookCounterpart',
      'rezics:bangumiLegacyVersion',
      'rezics:bangumiRelatedTo',
      'rezics:collaborationWith',
      'rezics:crossMediaCounterpart',
      'rezics:editionCounterpart',
      'rezics:expansionCounterpart',
      'rezics:representativeEdition',
      'rezics:sameCharacters',
      'rezics:sameSetting',
      'rezics:sideStoryOf',
      'rezics:spinOffOf',
      'rezics:storyArc',
      'rezics:summaryOf',
      'schema:abstract',
      'schema:author',
      'schema:contributor',
      'schema:datePublished',
      'schema:genre',
      'schema:image',
      'schema:inLanguage',
      'schema:keywords',
      'schema:name',
      'schema:sameAs',
      'schema:url',
      'schema:wordCount',
      'wdt:P155',
      'wdt:P179',
      'wdt:P361',
      'wdt:P5732',
      'wdt:P648',
      'wdt:P7937',
    ],
  });
  expect(types['bf:Instance']).toMatchObject({
    iri: 'http://id.loc.gov/ontologies/bibframe/Instance',
    mappings: ['wd:Q3331189'],
    properties: [
      'rezics:alternativeSetting',
      'rezics:alternativeVersion',
      'rezics:artbookCounterpart',
      'rezics:bangumiLegacyVersion',
      'rezics:bangumiRelatedTo',
      'rezics:collaborationWith',
      'rezics:crossMediaCounterpart',
      'rezics:editionCounterpart',
      'rezics:expansionCounterpart',
      'rezics:sameCharacters',
      'rezics:sameSetting',
      'rezics:sideStoryOf',
      'rezics:spinOffOf',
      'rezics:storyArc',
      'rezics:summaryOf',
      'schema:author',
      'schema:contributor',
      'schema:creativeWorkStatus',
      'schema:datePublished',
      'schema:director',
      'schema:exampleOfWork',
      'schema:genre',
      'schema:illustrator',
      'schema:image',
      'schema:inLanguage',
      'schema:isbn',
      'schema:keywords',
      'schema:musicBy',
      'schema:name',
      'schema:numberOfPages',
      'schema:producer',
      'schema:productionCompany',
      'schema:publisher',
      'schema:sameAs',
      'schema:translator',
      'schema:url',
      'wdt:P155',
      'wdt:P178',
      'wdt:P179',
      'wdt:P361',
      'wdt:P58',
      'wdt:P648',
      'wdt:P725',
    ],
  });
  expect(types['schema:Recipe']!.properties).toEqual([
    'schema:abstract',
    'schema:author',
    'schema:cookTime',
    'schema:datePublished',
    'schema:image',
    'schema:keywords',
    'schema:name',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
    'schema:recipeYield',
    'schema:sameAs',
    'schema:suitableForDiet',
    'schema:url',
    'wdt:P186',
  ]);
  expect(properties['schema:author']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['schema:Organization', 'schema:Person'],
    qualifiers: [
      'schema:position',
      'schema:sameAs',
      'wdt:P1932',
      'wdt:P3180',
      'wdt:P3831',
      'wdt:P518',
      'wdt:P6298',
      'wdt:P648',
    ],
    mappings: ['wd:P50'],
  });
  expect(properties['schema:exampleOfWork']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: false,
    targets: ['schema:CreativeWork'],
    mappings: ['wd:P629'],
    qualifiers: ['schema:sameAs', 'wdt:P31', 'wdt:P648'],
  });
  expect(properties['schema:isbn']).toMatchObject({
    datatype: 'external-id',
    mappings: ['wd:P212'],
    value: { pattern: '^97[89]-?(?:[0-9]-?){9}[0-9]$' },
  });
  expect(properties['schema:numberOfPages']).toMatchObject({ datatype: 'quantity', units: ['1'], minimum: 1 });
  expect(properties['schema:cookTime']).toMatchObject({
    datatype: 'quantity',
    units: ['http://www.wikidata.org/entity/Q7727'],
    minimum: 0,
  });
  expect(properties['schema:recipeIngredient']).toMatchObject({ datatype: 'monolingualtext', multivalued: true });
  expect(properties['schema:datePublished']).toMatchObject({ datatype: 'time', mappings: ['wd:P577'] });
  expect(properties['schema:author']!.labels).toMatchObject({ en: 'author', ja: '著者', 'zh-Hant': '作者' });
});

test('a fixture vertical extends the bundled catalogue without replacing a released vertical', async () => {
  const sources = bundledSources();
  const fixture = `id: https://rezics.com/catalogue/fixture/extension
name: fixture_extension
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  ex: https://example.org/
default_range: string
imports:
  - linkml:types
  - core
classes:
  FixtureComposition:
    is_a: CreativeWork
    class_uri: ex:FixtureComposition
    slots:
      - composer
slots:
  composer:
    slot_uri: ex:composer
    range: Person
    multivalued: true
    annotations:
      datatype: wikibase-item
`;
  const root = `id: https://rezics.com/catalogue/fixture
name: fixture
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
imports:
  - linkml:types
  - rezics
  - fixture-extension
`;
  const labels = 'types:\n  ex:FixtureComposition: fixture composition\nproperties:\n  ex:composer: composer\n';
  const release = await compileCatalogue({
    root: 'fixture.yaml',
    schemas: { ...sources.schemas, 'fixture.yaml': root, 'fixture-extension.yaml': fixture },
    presentation: { ...sources.presentation, 'fixture-extension/en': labels },
  });
  expect(release.catalogue).toEqual({ id: 'https://rezics.com/catalogue/fixture', version: '1.0.0' });
  expect(Object.keys(release.types).sort()).toEqual(
    [...Object.keys(bundledRelease.types), 'ex:FixtureComposition'].sort(),
  );
  expect(release.types['ex:FixtureComposition']?.iri).toBe('https://example.org/FixtureComposition');
  expect(release.types['ex:FixtureComposition']?.bases).toEqual(['schema:CreativeWork', 'schema:Thing']);
  expect(release.types['ex:FixtureComposition']?.properties).toContain('ex:composer');
  expect(release.types['ex:FixtureComposition']?.properties).toContain('schema:name');
  expect(release.properties['ex:composer']?.targets).toEqual(['schema:Person']);
  expect(release.properties['ex:composer']?.multivalued).toBe(true);
  expect(release.properties['schema:isbn']).toEqual(bundledRelease.properties['schema:isbn']!);
});

test('Person biography and Organization history admit sourced descriptors', () => {
  const { types, properties } = bundledRelease;
  expect(types['schema:Person']?.properties).toEqual(
    expect.arrayContaining(['schema:abstract', 'wdt:P106', 'schema:knowsLanguage']),
  );
  expect(properties['wdt:P106']).toMatchObject({
    targets: ['skos:Concept'],
    relation: { group: 'classification', inverse: 'none' },
  });
  expect(properties['schema:knowsLanguage']).toMatchObject({ targets: ['skos:Concept'] });
  expect(properties['schema:hasOccupation']).toBeUndefined();
  expect(properties['schema:occupation']).toBeUndefined();
  expect(types['schema:Organization']?.properties).toEqual(
    expect.arrayContaining(['schema:abstract', 'wdt:P749', 'wdt:P1365', 'wdt:P1366']),
  );
  expect(properties['wdt:P749']).toMatchObject({
    targets: ['schema:Organization'],
    relation: { group: 'association', inverse: 'rezics:hasSubsidiary' },
  });
  expect(properties['wdt:P1365']).toMatchObject({
    targets: ['schema:Organization'],
    relation: { group: 'order', inverse: 'rezics:replacedBy' },
  });
  expect(properties['wdt:P1366']).toMatchObject({
    targets: ['schema:Organization'],
    relation: { group: 'order', inverse: 'rezics:replaces' },
  });
});

test('every bundled term carries labels in all eight UI locales', () => {
  for (const definition of [...Object.values(bundledRelease.types), ...Object.values(bundledRelease.properties)])
    expect(Object.keys(definition.labels).sort()).toEqual(uiLocales);
});

test('every presentation group has one file per UI locale', () => {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(bundledSources().presentation)) {
    const match = /^([a-z][a-z0-9-]{0,63})\/([^/]+)$/u.exec(key);
    expect(match).not.toBeNull();
    const group = match?.[1] ?? '';
    const locale = match?.[2] ?? '';
    expect(uiLocales).toContain(locale);
    groups.set(group, [...(groups.get(group) ?? []), locale]);
  }
  for (const locales of groups.values()) expect([...locales].sort()).toEqual(uiLocales);
});
