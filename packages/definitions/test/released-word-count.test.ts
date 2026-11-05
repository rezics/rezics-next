import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { valueSchema } from '../src/index.ts';
import { checkStatementInput, checkSubjectInput } from '../src/validate.ts';

const references = [
  { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/words' } }] },
];
const statement = (content: unknown, property = 'schema:wordCount') => ({
  property: { id: property },
  value: { type: 'value', content },
  references,
});

test('released Book words use the exact integer schema and reject uncertainty rather than discarding it', () => {
  const words = bundledRelease.properties['schema:wordCount']!;
  expect(words).toMatchObject({ mappings: ['wd:P6570'], minimum: 0, units: ['1'] });
  expect(words.value).toEqual(valueSchema('quantity', { exact: true, integer: true, units: ['1'] }));
  expect(bundledRelease.types['schema:Book']!.facets).toContain('schema:wordCount');
  expect(bundledRelease.types['bf:Instance']!.properties).not.toContain('schema:wordCount');

  for (const amount of ['+0', '+1000000', '+1000001', '+9007199254740993'])
    expect(checkStatementInput(statement({ amount, unit: '1' }), bundledRelease).violations).toEqual([]);
  for (const bounds of [
    { lowerBound: '+1000001' },
    { upperBound: '+1000001' },
    { lowerBound: '+1000000', upperBound: '+1000002' },
  ]) {
    const input = statement({ amount: '+1000001', unit: '1', ...bounds });
    const before = structuredClone(input);
    const errors = Object.keys(bounds).map((bound) => ({
      pointer: `/statement/value/content/${bound}`,
      code: 'unknown_field' as const,
    }));
    expect(checkStatementInput(input, bundledRelease).violations).toEqual(errors);
    expect(
      checkSubjectInput(
        {
          type: 'schema:Book',
          labels: { en: 'Exact released word count' },
          statements: { 'schema:wordCount': [input] },
        },
        bundledRelease,
      ).violations,
    ).toEqual(
      errors.map((error) => ({
        ...error,
        pointer: error.pointer.replace('/statement', '/statements/schema:wordCount/0'),
      })),
    );
    expect(input).toEqual(before);
  }
  for (const type of ['somevalue', 'novalue'])
    expect(
      checkStatementInput({ property: { id: 'schema:wordCount' }, value: { type }, references }, bundledRelease)
        .violations,
    ).toEqual([]);
});

test('exact words leave released page and cooking quantity uncertainty semantics unchanged', () => {
  for (const [property, amount, unit] of [
    ['schema:numberOfPages', '+100', '1'],
    ['schema:cookTime', '+25', 'http://www.wikidata.org/entity/Q7727'],
  ] as const) {
    expect(bundledRelease.properties[property]!.value).toEqual(
      valueSchema('quantity', { integer: true, units: [unit] }),
    );
    expect(
      checkStatementInput(statement({ amount, unit, lowerBound: amount, upperBound: amount }, property), bundledRelease)
        .violations,
    ).toEqual([]);
  }
});
