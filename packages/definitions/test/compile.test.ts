import { expect, test } from 'bun:test';
import { admitImportedDocument, CatalogueError, compileCatalogue } from '../src/compile.ts';
import {
  compareReleases,
  reconcileActivation,
  releaseDigest,
  validateRelease,
  valueSchema,
} from '../src/index.ts';

const prefixes = `prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
`;
const core = `id: https://rezics.com/catalogue/test/core
name: core
version: 1.0.0
${prefixes}default_range: string
imports:
  - linkml:types
classes:
  Thing:
    abstract: true
    slots:
      - url
  Person:
    is_a: Thing
    class_uri: schema:Person
    exact_mappings:
      - wd:Q5
slots:
  url:
    slot_uri: schema:url
    range: uri
    exact_mappings:
      - wd:P856
    annotations:
      datatype: url
`;
const music = `id: https://rezics.com/catalogue/test/music
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
      - iswc
      - duration
      - firstPerformance
      - subtitle
slots:
  composer:
    slot_uri: schema:composer
    range: Person
    multivalued: true
    exact_mappings:
      - wd:P86
    annotations:
      datatype: wikibase-item
      qualifiers: position
  position:
    slot_uri: schema:position
    pattern: '^[1-9][0-9]{0,2}$'
    exact_mappings:
      - wd:P1545
    annotations:
      datatype: string
  iswc:
    slot_uri: schema:iswcCode
    pattern: '^T-[0-9]{3}\\.[0-9]{3}\\.[0-9]{3}-[0-9]$'
    exact_mappings:
      - wd:P1827
    annotations:
      datatype: external-id
  duration:
    slot_uri: schema:duration
    range: integer
    minimum_value: 1
    maximum_value: 86400
    exact_mappings:
      - wd:P2047
    annotations:
      datatype: quantity
      units: wd:Q11574
  firstPerformance:
    slot_uri: schema:firstPerformance
    range: date
    exact_mappings:
      - wd:P1191
    annotations:
      datatype: time
  subtitle:
    slot_uri: schema:alternativeHeadline
    multivalued: true
    exact_mappings:
      - wd:P1680
    annotations:
      datatype: monolingualtext
`;
const root = `id: https://rezics.com/catalogue/test
name: fixture
version: 3.0.0
${prefixes}imports:
  - linkml:types
  - core
  - music
`;
const en = `types:
  schema:Person: person
  schema:MusicComposition: musical composition
properties:
  schema:url: URL
  schema:composer: composer
  schema:position: position
  schema:iswcCode: ISWC
  schema:duration: duration
  schema:firstPerformance: first performance
  schema:alternativeHeadline: subtitle
`;
const ja = `types:
  schema:Person: 人物
properties:
  schema:composer: 作曲者
`;
const SECOND = 'http://www.wikidata.org/entity/Q11574';
const ISWC = '^T-[0-9]{3}\\.[0-9]{3}\\.[0-9]{3}-[0-9]$';
type Sources = { music?: string; core?: string; en?: string };
const input = (sources: Sources = {}) => ({
  root: 'fixture.yaml',
  schemas: { 'fixture.yaml': root, 'core.yaml': sources.core ?? core, 'music.yaml': sources.music ?? music },
  presentation: { en: sources.en ?? en, ja },
});
async function violations(sources: Sources): Promise<string[]> {
  const error = await compileCatalogue(input(sources)).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CatalogueError);
  return (error as CatalogueError).violations.map(({ file, pointer, code }) => `${file} ${pointer} ${code}`);
}
const replace = (text: string, from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, () => to);
};

test("a catalogue compiles to a release through LinkML's derived schema", async () => {
  const release = await compileCatalogue(input());
  const term = (key: string, labels: Record<string, string>, mappings: string[]) => ({
    iri: `http://schema.org/${key.slice('schema:'.length)}`,
    labels,
    mappings,
  });
  expect(release).toEqual({
    format: 'https://rezics.com/definitions/release/1',
    catalogue: { id: 'https://rezics.com/catalogue/test', version: '3.0.0' },
    generator: { name: '@neverblink/linkml', version: expect.any(String) },
    prefixes: { schema: 'http://schema.org/', wd: 'http://www.wikidata.org/entity/' },
    types: {
      'schema:MusicComposition': {
        ...term('schema:MusicComposition', { en: 'musical composition' }, ['wd:Q207628']),
        bases: [],
        facets: [],
        properties: [
          'schema:alternativeHeadline',
          'schema:composer',
          'schema:duration',
          'schema:firstPerformance',
          'schema:iswcCode',
          'schema:url',
        ],
      },
      'schema:Person': {
        ...term('schema:Person', { en: 'person', ja: '人物' }, ['wd:Q5']),
        bases: [],
        facets: [],
        properties: ['schema:url'],
      },
    },
    properties: {
      'schema:alternativeHeadline': {
        ...term('schema:alternativeHeadline', { en: 'subtitle' }, ['wd:P1680']),
        datatype: 'monolingualtext',
        multivalued: true,
        qualifiers: [],
        value: valueSchema('monolingualtext'),
      },
      'schema:composer': {
        ...term('schema:composer', { en: 'composer', ja: '作曲者' }, ['wd:P86']),
        datatype: 'wikibase-item',
        multivalued: true,
        targets: ['schema:Person'],
        qualifiers: ['schema:position'],
        value: valueSchema('wikibase-item'),
      },
      'schema:duration': {
        ...term('schema:duration', { en: 'duration' }, ['wd:P2047']),
        datatype: 'quantity',
        multivalued: false,
        units: [SECOND],
        minimum: 1,
        maximum: 86400,
        qualifiers: [],
        value: valueSchema('quantity', { units: [SECOND], integer: true }),
      },
      'schema:firstPerformance': {
        ...term('schema:firstPerformance', { en: 'first performance' }, ['wd:P1191']),
        datatype: 'time',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('time'),
      },
      'schema:iswcCode': {
        ...term('schema:iswcCode', { en: 'ISWC' }, ['wd:P1827']),
        datatype: 'external-id',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('external-id', { pattern: ISWC }),
      },
      'schema:position': {
        ...term('schema:position', { en: 'position' }, ['wd:P1545']),
        datatype: 'string',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('string', { pattern: '^[1-9][0-9]{0,2}$' }),
      },
      'schema:url': {
        ...term('schema:url', { en: 'URL' }, ['wd:P856']),
        datatype: 'url',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('url'),
      },
    },
  });
});

test('compilation is deterministic and its release is valid', async () => {
  const first = await compileCatalogue(input());
  expect(validateRelease(first)).toEqual([]);
  const reordered = input();
  reordered.schemas = Object.fromEntries(Object.entries(reordered.schemas).reverse()) as typeof reordered.schemas;
  expect(releaseDigest(await compileCatalogue(reordered))).toBe(releaseDigest(first));
  const relabelled = await compileCatalogue(input({ en: replace(en, 'schema:url: URL', 'schema:url: web address') }));
  expect(releaseDigest(relabelled)).not.toBe(releaseDigest(first));
});

test('features outside the restricted profile are refused', async () => {
  let changed = replace(music, '  Composition:\n', '  Composition:\n    rules:\n      - description: never run\n');
  changed = replace(changed, '    minimum_value: 1\n', '    minimum_value: 1\n    equals_expression: "{x}"\n');
  changed = replace(changed, '  iswc:\n', '  iswc:\n    required: true\n');
  changed += 'enums:\n  Mode:\n    permissible_values:\n      major: {}\n';
  expect(await violations({ music: changed })).toEqual([
    'music.yaml /classes/Composition/rules unsupported',
    'music.yaml /enums unsupported',
    'music.yaml /slots/duration/equals_expression unsupported',
    'music.yaml /slots/iswc/required unsupported',
  ]);
  expect(
    await violations({
      music: replace(music, '      datatype: external-id\n', '      datatype: external-id\n      facet: "true"\n'),
    }),
  ).toEqual(['music.yaml /slots/iswc/annotations/facet unsupported']);
});

test('a slot must agree with its data type, mappings, qualifiers and labels', async () => {
  expect(
    await violations({ music: replace(music, 'datatype: external-id', 'datatype: quantity\n      units: "1"') }),
  ).toEqual(['music.yaml /slots/iswc/annotations/datatype invalid']);
  expect(await violations({ music: replace(music, '      - wd:P1827\n', '      - wd:Q1827\n') })).toEqual([
    'music.yaml /slots/iswc/exact_mappings invalid',
  ]);
  expect(await violations({ music: replace(music, 'qualifiers: position', 'qualifiers: role') })).toEqual([
    'music.yaml /slots/composer/annotations/qualifiers invalid',
  ]);
  expect(await violations({ music: replace(music, '    class_uri: schema:MusicComposition\n', '') })).toEqual([
    'music.yaml /classes/Composition invalid',
  ]);
  expect(await violations({ en: replace(en, '  schema:iswcCode: ISWC\n', '') })).toEqual([
    'presentation/en /properties/schema:iswcCode missing_label',
  ]);
});

test('unsafe patterns, duplicate terms, LinkML errors and oversized files are refused', async () => {
  expect(await violations({ music: replace(music, "'^[1-9][0-9]{0,2}$'", "'^(a+)+$'") })).toEqual([
    'music.yaml /slots/position/pattern unsafe_pattern',
  ]);
  const duplicate = `${music}  link:\n    slot_uri: schema:url\n    range: uri\n    annotations:\n      datatype: url\n`;
  expect(await violations({ music: duplicate })).toEqual(['music.yaml /slots/link duplicate']);
  const unknownRange = await violations({ music: replace(music, '    range: Person\n', '    range: Band\n') });
  expect(unknownRange.length).toBeGreaterThan(0);
  expect(unknownRange.every((entry) => entry.endsWith(' linkml'))).toBe(true);
  expect(await violations({ music: `${music}#${'x'.repeat(256 * 1024)}\n` })).toEqual(['music.yaml  limit']);
});

test('imported sources compile to a release identity and name the repairable source field', async () => {
  const sources = {
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: 'urn:catalogue:import',
        name: 'import',
        version: '1',
        prefixes: { ex: 'https://example.org/' },
        classes: { Work: { class_uri: 'ex:Work' }, Extra: { class_uri: 'ex:Extra' } },
      }),
    },
    presentation: { en: JSON.stringify({ types: { 'ex:Work': 'work', 'ex:Extra': 'extra' }, properties: {} }) },
  };
  const compiled = await compileCatalogue(sources);
  const admitted = await admitImportedDocument(sources);
  expect(admitted.kind).toBe('sources');
  if (admitted.kind !== 'sources') throw new Error('expected compiled sources');
  expect(releaseDigest(admitted.release)).toBe(releaseDigest(compiled));
  expect(admitted.diagnostics).toEqual([]);
  const missing = await admitImportedDocument({
    ...sources,
    presentation: { en: JSON.stringify({ types: { 'ex:Work': 'work' }, properties: {} }) },
  });
  expect(missing.kind).toBe('invalid');
  expect(missing.diagnostics.some((diagnostic) => diagnostic.file === 'presentation/en')).toBe(true);
  expect(missing.diagnostics.some((diagnostic) => diagnostic.pointer.includes('ex:Extra'))).toBe(true);
  const unknown = await admitImportedDocument({ format: 'nope' });
  expect(unknown).toEqual({ kind: 'invalid', diagnostics: [{ pointer: '/document', code: 'invalid_type', file: null }] });
  const compared = compareReleases(compiled, {
    ...compiled,
    types: {
      ...compiled.types,
      'ex:Work': { ...compiled.types['ex:Work']!, labels: { en: 'renamed' } },
    },
  });
  expect(compared.changedTypes).toEqual([]);
  expect(reconcileActivation('sha256:aa', { digest: 'sha256:bb', head: 4 }, 5).stale).toBe(true);
});
