import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease } from '../src/index.ts';

const uiLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const sharedTerms = new Set([
  'foaf:focus',
  'rezics:spoilerLevel',
  'schema:character',
  'schema:contributor',
  'schema:director',
  'schema:genre',
  'schema:illustrator',
  'schema:keywords',
  'schema:musicBy',
  'schema:producer',
  'schema:productionCompany',
  'skos:Concept',
  'skos:ConceptScheme',
  'skos:broader',
  'skos:inScheme',
  'wd:Q7725310',
  'wd:Q95074',
  'wdt:P178',
  'wdt:P179',
  'wdt:P1932',
  'wdt:P3831',
  'wdt:P453',
  'wdt:P58',
  'wdt:P725',
]);

test('the committed bundled release is the compilation of the bundled catalogue', async () => {
  const sources = bundledSources();
  expect(sources.root).toBe('rezics.yaml');
  expect(Object.keys(sources.schemas).sort()).toEqual([
    'anime.yaml',
    'book.yaml',
    'character.yaml',
    'classification.yaml',
    'core.yaml',
    'game.yaml',
    'manga.yaml',
    'recipe.yaml',
    'rezics.yaml',
    'series.yaml',
    'visual-novel.yaml',
    'works.yaml',
  ]);
  expect(Object.keys(sources.presentation).sort()).toEqual(
    [
      ...['anime', 'book', 'game', 'recipe', 'visual-novel', 'works'].flatMap((group) =>
        ['en', 'ja', 'zh-Hant'].map((tag) => `${group}/${tag}`),
      ),
      ...['character', 'classification', 'core', 'series'].flatMap((group) =>
        uiLocales.map((tag) => `${group}/${tag}`),
      ),
    ].sort(),
  );
  expect(await compileCatalogue(sources)).toEqual(bundledRelease);
  expect(validateRelease(bundledRelease)).toEqual([]);
  expect(bundledDigest).toBe(releaseDigest(bundledRelease));
});

test('book work, edition and recipe are profiles of the catalogue', () => {
  const { types, properties } = bundledRelease;
  expect(bundledRelease.catalogue).toEqual({ id: 'https://rezics.com/catalogue/rezics', version: '1.0.0' });
  expect(Object.keys(types).sort()).toEqual([
    'bf:Instance',
    'schema:Book',
    'schema:MusicAlbum',
    'schema:Organization',
    'schema:Person',
    'schema:Recipe',
    'schema:TVSeries',
    'schema:VideoGame',
    'skos:Concept',
    'skos:ConceptScheme',
    'wd:Q689445',
    'wd:Q7725310',
    'wd:Q95074',
  ]);
  expect(types['schema:Book']).toMatchObject({
    mappings: ['wd:Q47461344'],
    properties: [
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
      'wdt:P179',
      'wdt:P5732',
      'wdt:P648',
    ],
  });
  expect(types['bf:Instance']).toMatchObject({
    iri: 'http://id.loc.gov/ontologies/bibframe/Instance',
    mappings: ['wd:Q3331189'],
    properties: [
      'schema:author',
      'schema:contributor',
      'schema:datePublished',
      'schema:exampleOfWork',
      'schema:genre',
      'schema:image',
      'schema:inLanguage',
      'schema:isbn',
      'schema:keywords',
      'schema:name',
      'schema:numberOfPages',
      'schema:publisher',
      'schema:sameAs',
      'schema:translator',
      'schema:url',
      'wdt:P179',
      'wdt:P648',
    ],
  });
  expect(types['schema:Recipe']!.properties).toEqual([
    'schema:abstract',
    'schema:author',
    'schema:cookTime',
    'schema:datePublished',
    'schema:image',
    'schema:name',
    'schema:recipeIngredient',
    'schema:recipeYield',
    'schema:sameAs',
    'schema:url',
  ]);
  expect(properties['schema:author']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['schema:Organization', 'schema:Person'],
    qualifiers: ['schema:position', 'schema:sameAs', 'wdt:P1932', 'wdt:P3180', 'wdt:P3831', 'wdt:P6298', 'wdt:P648'],
    mappings: ['wd:P50'],
  });
  expect(properties['schema:exampleOfWork']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: false,
    targets: [
      'bf:Instance',
      'schema:Book',
      'schema:MusicAlbum',
      'schema:TVSeries',
      'schema:VideoGame',
      'wd:Q689445',
      'wd:Q7725310',
    ],
    mappings: ['wd:P629'],
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
  expect(properties['schema:author']!.labels).toEqual({ en: 'author', ja: '著者', 'zh-Hant': '作者' });
  for (const [key, definition] of [...Object.entries(types), ...Object.entries(properties)])
    expect(Object.keys(definition.labels).sort()).toEqual(sharedTerms.has(key) ? uiLocales : ['en', 'ja', 'zh-Hant']);
});

test('a fixture vertical over the bundled catalogue adds a type without code', async () => {
  const sources = bundledSources();
  const prefixes =
    'prefixes:\n  linkml: https://w3id.org/linkml/\n  schema: http://schema.org/\n  wd: http://www.wikidata.org/entity/\n';
  const music = `id: https://rezics.com/catalogue/fixture/music
name: music
version: 1.0.0
${prefixes}default_range: string
imports:
  - linkml:types
  - core
classes:
  Composition:
    is_a: Thing
    class_uri: schema:MusicComposition
    exact_mappings:
      - wd:Q207628
    slots:
      - composer
slots:
  composer:
    slot_uri: schema:composer
    range: Person
    multivalued: true
    exact_mappings:
      - wd:P86
    annotations:
      datatype: wikibase-item
`;
  const root = `id: https://rezics.com/catalogue/fixture
name: fixture
version: 1.0.0
${prefixes}imports:
  - linkml:types
  - rezics
  - music
`;
  const labels = 'types:\n  schema:MusicComposition: musical composition\nproperties:\n  schema:composer: composer\n';
  const release = await compileCatalogue({
    root: 'fixture.yaml',
    schemas: { ...sources.schemas, 'fixture.yaml': root, 'music.yaml': music },
    presentation: { ...sources.presentation, 'music/en': labels },
  });
  expect(release.catalogue).toEqual({ id: 'https://rezics.com/catalogue/fixture', version: '1.0.0' });
  expect(Object.keys(release.types).sort()).toEqual(
    [...Object.keys(bundledRelease.types), 'schema:MusicComposition'].sort(),
  );
  expect(release.properties['schema:composer']).toMatchObject({ targets: ['schema:Person'], multivalued: true });
  expect(release.properties['schema:isbn']).toEqual(bundledRelease.properties['schema:isbn']!);
});
