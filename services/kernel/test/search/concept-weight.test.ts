import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { normalizeSourceStatement } from '../../src/semantic/scope-leaf-selection.ts';

const concept = '018f0000-0000-7000-8000-00a000000011';
const weight = (amount: string) => ({
  property: 'rezics:sourceTagWeight',
  value: { type: 'value', content: { amount, unit: '1' } },
});
const spoiler = (amount: string) => ({
  property: 'rezics:spoilerLevel',
  value: { type: 'value', content: { amount, unit: '1' } },
});
const metric = { property: 'rezics:sourceTagWeightMetric', value: { type: 'value', content: 'vndbTagsRating' } };
const statement = (amount: string, level?: string) =>
  normalizeSourceStatement(
    'schema:genre',
    {
      value: { type: 'value', content: concept },
      qualifiers: [weight(amount), metric, ...(level === undefined ? [] : [spoiler(level)])],
    },
    bundledRelease.properties,
  )!;
const qualifiers = [
  { property: 'rezics:sourceTagWeight', range: { gte: 2, lte: 3, unit: '1' } },
  { property: 'rezics:sourceTagWeightMetric', in: ['vndbTagsRating'] },
  { property: 'rezics:spoilerLevel', in: ['0'] },
];

test('native weight evidence preserves imported decimal precision and never borrows another assertion’s spoiler', () => {
  const strong = statement('+2.59999990463257', '+2');
  expect(strong.qualifiers).toContainEqual({
    property: 'rezics:sourceTagWeight',
    value: '+2.59999990463257',
    facet: { kind: 'quantity', amount: 2.59999990463257, unit: '1' },
  });
  const clause = { facet: 'statement' as const, property: 'schema:genre', values: [concept], qualifiers };
  expect(holdsCurrentStatements([strong, statement('+1.1', '+0')], clause)).toBe(false);
  expect(holdsCurrentStatements([statement('+2.59999990463257', '+0')], clause)).toBe(true);
  expect(holdsCurrentStatements([statement('+2.59999990463257')], clause)).toBe(false);
});

test('a weight range retains index candidates in both polarities for current native evaluation', () => {
  const leaf = { statement: { property: 'schema:genre', in: [concept], qualifiers } };
  for (const filter of [leaf, { not: leaf }]) {
    const compiled = compileFilter(filter, { prefix: 'weight' });
    expect(compiled.query).toEqual({ match_all: { _name: 'weight0' } });
    expect(compiled.leaves[0]).toMatchObject({ property: 'schema:genre', qualifiers });
  }
});
