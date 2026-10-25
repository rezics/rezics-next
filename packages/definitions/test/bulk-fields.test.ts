import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '../src/bundled.ts';
import { checkBatchWrite, type Rights, type Source } from '../src/bulk.ts';
import { DATA_TYPES, valueSchema } from '../src/index.ts';

const source = (field_group: Source['field_group'], overrides: Partial<Source> = {}): Source => ({
  source: 'bangumi',
  external_id: '253',
  record_revision: 'unversioned',
  digest: 'd'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group,
  ...overrides,
});
const url = (content: string) => ({ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content } }] });
const subject = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const media = '019a1b2c-3d4e-7f00-8a00-3ed1a0000062';
const rights: Rights = {
  license: 'CC-BY-SA-3.0',
  obligations: ['cc:Attribution', 'cc:ShareAlike'],
  attribution: 'Bangumi contributors',
};
const summary = (
  value: unknown = {
    type: 'value',
    content: { language: 'ja', document: fromPlainText('吾輩は猫である。名前はまだ無い。') },
  },
  extra: Record<string, unknown> = { rights },
) => ({
  op: 'propose',
  key: 'summary',
  source: source('summary'),
  subject,
  statement: { property: { id: 'schema:abstract' }, value, references: [url('https://bgm.tv/subject/253')] },
  ...extra,
});
const withDocument = (document: unknown) => summary({ type: 'value', content: { language: 'ja', document } });
const cover = (content: unknown = media, extra: Record<string, unknown> = {}) => ({
  op: 'propose',
  key: 'cover',
  source: source('cover'),
  subject,
  statement: {
    property: { id: 'schema:image' },
    value: { type: 'value', content },
    references: [url('https://bgm.tv/subject/253')],
  },
  ...extra,
});
const unresolved = {
  op: 'propose',
  key: 'author',
  source: source('facts', { source: 'openlibrary', external_id: 'OL45804W' }),
  subject,
  statement: {
    property: { id: 'schema:author' },
    value: { type: 'somevalue' },
    qualifiers: [{ property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL26320A' } }],
    references: [url('https://openlibrary.org/works/OL45804W')],
  },
};
const check = (...commands: unknown[]) => checkBatchWrite({ commands });

test('summary, cover and unresolved references each have one portable shape', () => {
  expect(check(summary(), cover(), unresolved)).toEqual([]);
  expect(check(summary(undefined, { rights: { ...rights, license: 'LicenseRef-unknown', obligations: [] } }))).toEqual(
    [],
  );
});

test('each field group refuses the shapes of the others', () => {
  const { rights: _rights, ...unlicensed } = summary();
  const cases: [unknown, string, string][] = [
    [unlicensed, '/commands/0/rights', 'required'],
    [{ ...unresolved, rights }, '/commands/0/rights', 'unsupported'],
    [cover(media, { rights }), '/commands/0/rights', 'unsupported'],
    [summary({ type: 'value', content: 'A cat narrates.' }), '/commands/0/statement/value/content', 'invalid_type'],
    [summary({ type: 'somevalue' }), '/commands/0/statement/value/type', 'unsupported'],
    [withDocument('A cat narrates.'), '/commands/0/statement/value/content/document', 'invalid_format'],
    [withDocument({ version: 'rezics-document-v1' }), '/commands/0/statement/value/content/document', 'invalid_format'],
    [withDocument(fromPlainText('猫'.repeat(11_000))), '/commands/0/statement/value/content/document', 'out_of_range'],
    [cover('cover.jpg'), '/commands/0/statement/value/content', 'invalid_format'],
    [cover(42), '/commands/0/statement/value/content', 'invalid_type'],
    [
      {
        op: 'create',
        key: 'create',
        source: source('summary'),
        subject: { type: 'schema:TVSeries', labels: { ja: '猫' } },
      },
      '/commands/0/source/field_group',
      'unsupported',
    ],
    [
      summary(undefined, { rights: { ...rights, license: 'CC BY-SA 3.0' } }),
      '/commands/0/rights/license',
      'invalid_format',
    ],
    [
      summary(undefined, { rights: { ...rights, obligations: ['cc:Pay'] } }),
      '/commands/0/rights/obligations/0',
      'unsupported',
    ],
    [summary(undefined, { rights: { ...rights, attribution: '' } }), '/commands/0/rights/attribution', 'out_of_range'],
  ];
  for (const [command, pointer, code] of cases)
    expect({ command, errors: check(command) }).toEqual({ command, errors: [{ pointer, code }] });
});

test('the catalogue defines the launch types, summaries, covers and source identifiers', () => {
  expect(DATA_TYPES).toContain('document');
  expect(DATA_TYPES).toContain('media');
  expect(valueSchema('media')).toMatchObject({ type: 'string' });
  const { types, properties } = bundledRelease;
  expect(properties['schema:abstract']).toMatchObject({ datatype: 'document', multivalued: true });
  expect(properties['schema:image']).toMatchObject({ datatype: 'media', multivalued: true });
  for (const [id, mapping, pattern] of [
    ['wdt:P648', 'wd:P648', '^OL[1-9][0-9]*[AMW]$'],
    ['wdt:P5732', 'wd:P5732', '^[1-9][0-9]*$'],
    ['wdt:P6298', 'wd:P6298', '^[1-9][0-9]*$'],
    ['wdt:P3180', 'wd:P3180', '^[vrpcs][1-9][0-9]*$'],
  ] as const)
    expect(properties[id]).toMatchObject({
      iri: `http://www.wikidata.org/prop/direct/${id.slice(4)}`,
      mappings: [mapping],
      datatype: 'external-id',
      value: { pattern },
    });
  for (const [id, mapping] of [
    ['schema:TVSeries', 'wd:Q5398426'],
    ['schema:MusicAlbum', 'wd:Q482994'],
    ['schema:VideoGame', 'wd:Q7889'],
  ] as const) {
    expect(types[id]?.mappings).toEqual([mapping]);
    expect(types[id]?.properties).toEqual(
      expect.arrayContaining(['schema:abstract', 'schema:image', 'schema:datePublished', 'wdt:P5732']),
    );
  }
  expect(types['wd:Q689445']).toMatchObject({ iri: 'http://www.wikidata.org/entity/Q689445' });
  expect(types['wd:Q689445']?.properties).toEqual(expect.arrayContaining(['schema:abstract', 'wdt:P3180']));
  expect(types['wd:Q689445']?.properties).not.toContain('wdt:P5732');
  expect(types['schema:Book']?.properties).toEqual(
    expect.arrayContaining(['schema:abstract', 'schema:image', 'wdt:P648', 'wdt:P5732']),
  );
  expect(types['bf:Instance']?.properties).toContain('wdt:P648');
  expect(types['schema:Person']?.properties).toEqual(expect.arrayContaining(['wdt:P648', 'wdt:P6298', 'wdt:P3180']));
  expect(properties['schema:author']?.qualifiers).toEqual(
    expect.arrayContaining(['schema:position', 'wdt:P648', 'wdt:P6298', 'wdt:P3180']),
  );
  for (const id of ['schema:abstract', 'schema:image', 'wdt:P648', 'schema:TVSeries'])
    expect(Object.keys((properties[id] ?? types[id])!.labels).sort()).toEqual(['en', 'ja', 'zh-Hant']);
});
