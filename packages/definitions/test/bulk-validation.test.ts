import { expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { checkBatchWrite, type Rights, type Source } from '../src/bulk.ts';

const source: Source = {
  source: 'bangumi',
  external_id: '253',
  record_revision: 'unversioned',
  digest: 'd'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group: 'summary',
};
const rights: Rights = { license: 'CC-BY-SA-3.0', obligations: [], attribution: 'Bangumi contributors' };
const command = (document: unknown = fromPlainText('猫')) => ({
  op: 'propose',
  key: 'summary',
  source,
  subject: '019a1b2c-3d4e-7f00-8a00-5b0000000061',
  rights,
  statement: {
    property: { id: 'schema:abstract' },
    value: { type: 'value', content: { language: 'ja', document } },
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/253' } }] },
    ],
  },
});
const check = (input: unknown) => checkBatchWrite({ commands: [input] });

test('summary size counts canonical UTF-8 bytes, including the snapshot envelope', () => {
  const overhead = Buffer.byteLength(serializeDocument(fromPlainText('x'))) - 1;
  expect(check(command(fromPlainText('x'.repeat(32_768 - overhead))))).toEqual([]);
  expect(check(command(fromPlainText('x'.repeat(32_769 - overhead))))).toEqual([
    { pointer: '/commands/0/statement/value/content/document', code: 'out_of_range' },
  ]);
  expect(check(command(fromPlainText('猫'.repeat(11_000))))).toEqual([
    { pointer: '/commands/0/statement/value/content/document', code: 'out_of_range' },
  ]);
});

test('only valid Text and Blocks snapshots are portable document fields', () => {
  expect(check(command(fromPlainText('猫', 'blocks')))).toEqual([]);
  for (const document of [
    null,
    [],
    serializeDocument(fromPlainText('猫')),
    { ...fromPlainText('猫'), extra: true },
    { version: 'rezics-document-v1', profile: 'text', doc: { type: 'doc', content: [{ type: 'unknown' }] } },
  ])
    expect(check(command(document))).toEqual([
      { pointer: '/commands/0/statement/value/content/document', code: 'invalid_format' },
    ]);
  for (const language of ['japanese', '', 'ja\n']) {
    const input = command();
    input.statement.value.content.language = language;
    expect(check(input)).toEqual([{ pointer: '/commands/0/statement/value/content/language', code: 'invalid_format' }]);
  }
});

test('rights enforce licence identifiers, distinct CC requirements and attribution limits', () => {
  for (const license of ['LicenseRef-unknown', 'LicenseRef-local.1', 'CC0-1.0'])
    expect(check({ ...command(), rights: { ...rights, license } })).toEqual([]);
  for (const license of [
    'made-up-license',
    'LicenseRef-',
    'MIT OR Apache-2.0',
    'MIT\n',
    'LicenseRef-' + 'a'.repeat(71),
  ])
    expect(check({ ...command(), rights: { ...rights, license } })).toEqual([
      { pointer: '/commands/0/rights/license', code: 'invalid_format' },
    ]);
  expect(check({ ...command(), rights: { ...rights, obligations: ['cc:Attribution', 'cc:Attribution'] } })).toEqual([
    { pointer: '/commands/0/rights/obligations/1', code: 'invalid_format' },
  ]);
  expect(
    check({
      ...command(),
      rights: { ...rights, obligations: ['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'] },
    }),
  ).toEqual([]);
  expect(check({ ...command(), rights: { ...rights, obligations: Array(5).fill('cc:Notice') } })).toEqual([
    { pointer: '/commands/0/rights/obligations', code: 'out_of_range' },
  ]);
  expect(check({ ...command(), rights: { ...rights, attribution: '猫'.repeat(501) } })).toEqual([
    { pointer: '/commands/0/rights/attribution', code: 'out_of_range' },
  ]);
  expect(check({ ...command(), rights: { ...rights, attribution: '🐈'.repeat(500) } })).toEqual([]);
});

test('covers and summaries cannot be created, and rights stay on summaries', () => {
  expect(
    check({
      op: 'create',
      key: 'create',
      source: { ...source, field_group: 'facts' },
      subject: { type: 'schema:Book', labels: { ja: '猫' } },
      rights: null,
    }),
  ).toEqual([{ pointer: '/commands/0/rights', code: 'unsupported' }]);
  expect(check({ ...command(), source: { ...source, field_group: 'facts' }, rights: { license: 42 } })).toEqual([
    { pointer: '/commands/0/rights', code: 'unsupported' },
  ]);
  expect(check({ ...command(), statement: { ...command().statement, value: { type: 'novalue' } } })).toEqual([
    { pointer: '/commands/0/statement/value/type', code: 'unsupported' },
  ]);
  const { rights: _, ...cover } = command();
  expect(
    check({
      ...cover,
      source: { ...source, field_group: 'cover' },
      statement: { ...cover.statement, value: { type: 'value', content: `${cover.subject}\n` } },
    }),
  ).toEqual([{ pointer: '/commands/0/statement/value/content', code: 'invalid_format' }]);
});

test('unknown fields named after Object.prototype members are refused', () => {
  const input = JSON.parse(JSON.stringify(command()));
  input.statement.value.content = JSON.parse('{"language":"ja","document":{},"__proto__":{},"constructor":1}');
  expect(check(input)).toEqual(
    expect.arrayContaining([
      { pointer: '/commands/0/statement/value/content/__proto__', code: 'unknown_field' },
      { pointer: '/commands/0/statement/value/content/constructor', code: 'unknown_field' },
    ]),
  );
});
