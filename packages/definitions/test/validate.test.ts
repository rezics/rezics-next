import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '../src/bundled.ts';
import { checkBatchWrite } from '../src/bulk.ts';
import { checkStatementInput, checkSubjectInput } from '../src/validate.ts';

const target = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const reference = { parts: [snak('schema:url', 'https://example.org/record/1')] };
const statement = (id: string, content: unknown) => ({ ...snak(id, content), references: [reference] });
const book = (statements: Record<string, unknown>) => ({ type: 'schema:Book', labels: { en: 'Book' }, statements });

test('portable checks return nested item targets and preserve capped diagnostic order', () => {
  const input = book({
    'schema:author': [
      {
        ...statement('schema:author', target),
        references: [{ parts: [snak('schema:publisher', target)] }],
      },
    ],
  });
  expect(checkSubjectInput(input, bundledRelease)).toEqual({
    violations: [],
    targets: [
      {
        pointer: '/statements/schema:author/0/value/content',
        id: target,
        targets: ['schema:Organization', 'schema:Person'],
      },
      {
        pointer: '/statements/schema:author/0/references/0/parts/0/value/content',
        id: target,
        targets: ['schema:Organization'],
      },
    ],
  });
  const invalid = { ...input, labels: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`bad${i}`, 'x'])) };
  expect(checkSubjectInput(invalid, bundledRelease).violations).toEqual(
    Array.from({ length: 16 }, (_, i) => ({ pointer: `/labels/bad${i}`, code: 'invalid_format' })),
  );
  expect(checkStatementInput(statement('schema:author', target), bundledRelease).targets[0]?.pointer).toBe(
    '/statement/value/content',
  );
});

test('structural value limits precede schema, bounds and calendar checks, including nested snaks', () => {
  for (const [content, member] of [
    [{ amount: 'x'.repeat(128), unit: 'bad', extra: true }, 'amount'],
    [{ lowerBound: '1'.repeat(128), unit: 'bad' }, 'lowerBound'],
    [{ upperBound: '1'.repeat(128), unit: 'bad' }, 'upperBound'],
    [{ time: '+12345678901234567-99-99T00:00:00Z', precision: 0 }, 'time'],
  ] as const) {
    const input = statement('schema:author', target);
    input.references = [{ parts: [snak('schema:datePublished', content)] }];
    expect(checkStatementInput(input, bundledRelease).violations).toEqual([
      { pointer: `/statement/references/0/parts/0/value/content/${member}`, code: 'out_of_range' },
    ]);
  }
  const time = {
    time: '+1234567890123456-02-29T00:00:00Z',
    precision: 11,
    calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
  };
  expect(checkStatementInput(statement('schema:datePublished', time), bundledRelease).violations).toEqual([]);
});

test('value validator caches belong to each supplied release', () => {
  const input = statement('schema:inLanguage', 'ja');
  const other = structuredClone(bundledRelease);
  other.properties['schema:inLanguage']!.value = { type: 'string', const: 'en' };
  expect(checkStatementInput(input, bundledRelease).violations).toEqual([]);
  expect(checkStatementInput(input, other).violations).toEqual([
    { pointer: '/statement/value/content', code: 'invalid_format' },
  ]);
  expect(checkStatementInput(input, bundledRelease).violations).toEqual([]);
});

test('release field groups accept portable content and reject incompatible properties', () => {
  const source = {
    source: 'example',
    external_id: '1',
    record_revision: '1',
    digest: 'b'.repeat(64),
    converter_revision: 'example@1',
    field_group: 'facts',
  };
  const command = { op: 'propose', key: 'k', source, subject: target, statement: statement('schema:inLanguage', 'ja') };
  const summary = {
    ...command,
    source: { ...source, field_group: 'summary' },
    rights: { license: 'CC0-1.0', obligations: [], attribution: 'Example' },
    statement: statement('schema:abstract', { language: 'en', document: fromPlainText('Summary') }),
  };
  const cover = {
    ...command,
    source: { ...source, field_group: 'cover' },
    statement: statement('schema:image', target),
  };
  for (const input of [command, summary, cover])
    expect(checkBatchWrite({ commands: [input] }, bundledRelease)).toEqual([]);
  for (const input of [
    { ...summary, statement: command.statement },
    { ...cover, statement: command.statement },
    { ...command, statement: summary.statement },
    { ...command, statement: cover.statement },
  ])
    expect(checkBatchWrite({ commands: [input] }, bundledRelease)).toContainEqual({
      pointer: '/commands/0/statement/property/id',
      code: 'unsupported',
    });
  expect(
    checkBatchWrite({ commands: [{ ...command, statement: statement('__proto__', 'x') }] }, bundledRelease),
  ).toEqual([{ pointer: '/commands/0/statement/property/id', code: 'unsupported' }]);
});
