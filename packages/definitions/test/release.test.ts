import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import releaseSchema from '../schema/release.json';
import { bundledRelease } from '../src/bundled.ts';
import { DATA_TYPES, RELEASE_FORMAT, releaseDigest, validateRelease, valueSchema, type Release } from '../src/index.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const release = (): Release => ({
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://rezics.com/catalogue/test', version: '1.0.0' },
  generator: { name: '@neverblink/linkml', version: '0.17.1' },
  prefixes: { schema: 'http://schema.org/', wd: 'http://www.wikidata.org/entity/' },
  types: {
    'schema:MusicComposition': {
      iri: 'http://schema.org/MusicComposition',
      labels: { en: 'musical composition', ja: '楽曲' },
      mappings: ['wd:Q207628'],
      bases: [],
      properties: ['schema:composer', 'schema:duration', 'schema:url'],
      facets: [],
    },
    'schema:Person': {
      iri: 'http://schema.org/Person',
      labels: { en: 'person' },
      mappings: ['wd:Q5'],
      bases: [],
      properties: ['schema:url'],
      facets: [],
    },
  },
  properties: {
    'schema:composer': {
      iri: 'http://schema.org/composer',
      labels: { en: 'composer' },
      mappings: ['wd:P86'],
      datatype: 'wikibase-item',
      multivalued: true,
      targets: ['schema:Person'],
      qualifiers: ['schema:position'],
      value: { type: 'string', pattern: UUID },
    },
    'schema:duration': {
      iri: 'http://schema.org/duration',
      labels: { en: 'duration' },
      mappings: ['wd:P2047'],
      datatype: 'quantity',
      multivalued: false,
      units: ['http://www.wikidata.org/entity/Q11574'],
      minimum: 1,
      maximum: 86400,
      qualifiers: [],
      value: valueSchema('quantity', { units: ['http://www.wikidata.org/entity/Q11574'], integer: true }),
    },
    'schema:position': {
      iri: 'http://schema.org/position',
      labels: { en: 'position' },
      mappings: ['wd:P1545'],
      datatype: 'string',
      multivalued: false,
      qualifiers: [],
      value: { type: 'string', minLength: 1, maxLength: 1500, pattern: '^[1-9][0-9]{0,2}$' },
    },
    'schema:url': {
      iri: 'http://schema.org/url',
      labels: { en: 'URL' },
      mappings: ['wd:P856'],
      datatype: 'url',
      multivalued: false,
      qualifiers: [],
      value: { type: 'string', maxLength: 1500, pattern: '^https?://[^\\s]+$' },
    },
  },
});
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function edit(change: (draft: any) => void): unknown {
  const draft = release() as any;
  change(draft);
  return draft;
}
const pointers = (value: unknown) => validateRelease(value).map(({ pointer, code }) => `${code} ${pointer}`);

test('a well-formed release is valid and its digest is the SHA-256 of its RFC 8785 form', () => {
  expect(RELEASE_FORMAT).toBe('https://rezics.com/definitions/release/1');
  expect(DATA_TYPES).toEqual([
    'wikibase-item',
    'string',
    'external-id',
    'url',
    'monolingualtext',
    'quantity',
    'time',
    'document',
    'media',
  ]);
  expect(validateRelease(release())).toEqual([]);
  const digest = releaseDigest(release());
  expect(digest).toBe(`sha256:${sha256(canonicalize(release())!)}`);
  const reordered = Object.fromEntries(Object.entries(release()).reverse()) as Release;
  expect(releaseDigest(reordered)).toBe(digest);
  expect(releaseDigest(edit((draft) => (draft.types['schema:Person'].labels.ja = '人物')) as Release)).not.toBe(digest);
});

test('the release schema is JSON Schema 2020-12 and refuses unknown members and data types', () => {
  expect(releaseSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(pointers(edit((draft) => (draft.extra = 1)))).toEqual(['invalid /extra']);
  expect(pointers(edit((draft) => (draft.format = 'https://rezics.com/definitions/release/2')))).toEqual([
    'invalid /format',
  ]);
  expect(pointers(edit((draft) => (draft.properties['schema:url'].datatype = 'geo-shape')))).toContain(
    'invalid /properties/schema:url/datatype',
  );
  expect(pointers(edit((draft) => delete draft.types['schema:Person'].labels.en))).toEqual([
    'invalid /types/schema:Person/labels/en',
  ]);
  for (const garbage of [null, 7, 'release', [], { format: RELEASE_FORMAT }])
    expect(validateRelease(garbage).length).toBeGreaterThan(0);
});

test('references inside a release resolve and every CURIE expands through its prefixes', () => {
  expect(pointers(edit((draft) => (draft.properties['schema:composer'].targets = ['schema:Band'])))).toEqual([
    'invalid /properties/schema:composer/targets/0',
  ]);
  expect(pointers(edit((draft) => (draft.properties['schema:composer'].qualifiers = ['schema:role'])))).toEqual([
    'invalid /properties/schema:composer/qualifiers/0',
  ]);
  expect(
    pointers(
      edit((draft) => (draft.types['schema:MusicComposition'].properties = ['schema:composer', 'schema:lyricist'])),
    ),
  ).toEqual(['invalid /types/schema:MusicComposition/properties/1']);
  expect(pointers(edit((draft) => (draft.types['schema:Person'].mappings = ['bf:Agent'])))).toEqual([
    'invalid /types/schema:Person/mappings/0',
  ]);
  expect(pointers(edit((draft) => (draft.types['schema:Person'].iri = 'http://schema.org/Human')))).toEqual([
    'invalid /types/schema:Person/iri',
  ]);
});

test('each data type has exactly its own members and its fixed value schema', () => {
  expect(pointers(edit((draft) => (draft.properties['schema:url'].targets = ['schema:Person'])))).toEqual([
    'invalid /properties/schema:url/targets',
  ]);
  expect(pointers(edit((draft) => delete draft.properties['schema:composer'].targets))).toEqual([
    'invalid /properties/schema:composer/targets',
  ]);
  expect(pointers(edit((draft) => delete draft.properties['schema:duration'].units))).toContain(
    'invalid /properties/schema:duration/units',
  );
  expect(pointers(edit((draft) => (draft.properties['schema:position'].minimum = 1)))).toEqual([
    'invalid /properties/schema:position/minimum',
  ]);
  expect(pointers(edit((draft) => (draft.properties['schema:composer'].value = { type: 'string' })))).toEqual([
    'invalid /properties/schema:composer/value',
  ]);
  expect(pointers(edit((draft) => (draft.properties['schema:url'].value.pattern = '^.*$')))).toEqual([
    'invalid /properties/schema:url/value',
  ]);
  expect(valueSchema('time')).toEqual({
    type: 'object',
    required: ['time', 'precision', 'calendarmodel'],
    additionalProperties: false,
    properties: {
      time: { type: 'string', pattern: '^[+-][0-9]{4,}-[0-9]{2}-[0-9]{2}T00:00:00Z$' },
      precision: { enum: [9, 10, 11] },
      calendarmodel: { const: 'http://www.wikidata.org/entity/Q1985727' },
    },
  });
  expect(valueSchema('monolingualtext', { pattern: '^\\S' }).properties.text).toEqual({
    type: 'string',
    minLength: 1,
    maxLength: 1500,
    pattern: '^\\S',
  });
  expect(() => valueSchema('url', { pattern: '^x' })).toThrow();
});

test('patterns must be safe and releases are bounded', () => {
  expect(pointers(edit((draft) => (draft.properties['schema:position'].value.pattern = '^(a+)+$')))).toEqual([
    'unsafe_pattern /properties/schema:position/value/pattern',
  ]);
  expect(pointers(edit((draft) => (draft.properties['schema:position'].value.pattern = '([')))).toEqual([
    'unsafe_pattern /properties/schema:position/value/pattern',
  ]);
  const crowded = edit((draft) => {
    for (let index = 0; index < 1025; index++)
      draft.types[`schema:T${index}`] = {
        iri: `http://schema.org/T${index}`,
        labels: { en: 't' },
        mappings: [],
        bases: [],
        properties: [],
        facets: [],
      };
  });
  expect(pointers(crowded)).toEqual(['limit /types']);
});

test('the bundled catalogue admits exact file hashes, byte size and directed file associations', () => {
  const { types, properties } = bundledRelease;
  expect(bundledRelease.catalogue.version).toBe('1.0.5');
  expect(types['schema:Quotation']).toMatchObject({
    iri: 'http://schema.org/Quotation',
    bases: ['schema:Thing'],
    mappings: ['wd:Q815341'],
    properties: expect.arrayContaining([
      'schema:text',
      'schema:inLanguage',
      'schema:spokenByCharacter',
      'schema:about',
      'schema:creator',
      'schema:actor',
    ]),
  });
  expect(properties['schema:text']).toMatchObject({
    datatype: 'document',
    multivalued: false,
    value: { required: ['language', 'document'] },
  });
  expect(properties['schema:spokenByCharacter']).toMatchObject({
    datatype: 'wikibase-item',
    qualifiers: ['rezics:spoilerLevel'],
    targets: ['wd:Q95074'],
  });
  expect(properties['schema:creator']?.targets).toEqual(['schema:Organization', 'schema:Person']);
  expect(properties['schema:actor']?.targets).toEqual(['schema:Person']);
  for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    expect(types['schema:Quotation']?.labels[locale]).toBeTruthy();
    for (const property of ['schema:text', 'schema:spokenByCharacter', 'schema:about', 'schema:creator', 'schema:actor'])
      expect(properties[property]?.labels[locale]).toBeTruthy();
  }
  expect(types['schema:MediaObject']?.properties).toEqual(
    expect.arrayContaining([
      'wdt:P4092',
      'wdt:P3575',
      'rezics:codec',
      'rezics:fileQuality',
      'schema:inLanguage',
      'rezics:releaseGroup',
      'schema:encodesCreativeWork',
    ]),
  );
  expect(types['rezics:AnimeRelease']?.properties).toContain('schema:associatedMedia');
  expect(types['rezics:ReleaseGroup']?.bases).toContain('schema:Organization');
  expect(properties['wdt:P4092']).toMatchObject({ datatype: 'string', qualifiers: ['rezics:hashAlgorithm'] });
  expect(properties['wdt:P3575']).toMatchObject({
    datatype: 'quantity',
    units: ['http://www.wikidata.org/entity/Q8799'],
  });
  expect(properties['rezics:releaseGroup']?.relation?.inverse).toBe('rezics:groupFiles');
  expect(properties['schema:encodesCreativeWork']?.relation?.inverse).toBe('rezics:encodedByFile');
  expect(properties['schema:associatedMedia']?.relation?.inverse).toBe('rezics:includedInRelease');
  for (const type of ['rezics:CatalogueFile', 'wd:Q82753', 'wd:Q55327']) expect(types[type]).toBeUndefined();
  for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    for (const property of [
      'wdt:P4092',
      'wdt:P3575',
      'rezics:hashAlgorithm',
      'rezics:codec',
      'rezics:fileQuality',
      'rezics:releaseGroup',
    ]) {
      expect(properties[property]?.labels[locale]).toBeTruthy();
      expect(properties[property]?.descriptions?.[locale]).toBeTruthy();
    }
    expect(types['schema:MediaObject']?.labels[locale]).toBeTruthy();
    expect(types['schema:MediaObject']?.descriptions?.[locale]).toBeTruthy();
    expect(types['rezics:ReleaseGroup']?.labels[locale]).toBeTruthy();
    expect(types['rezics:ReleaseGroup']?.descriptions?.[locale]).toBeTruthy();
  }
});
