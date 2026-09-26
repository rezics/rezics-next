import { expect, test } from 'bun:test';
import { calculateNutrition, scaleIngredients } from '../../../services/main/src/modules/recipe/operations.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';

const line = (overrides: Partial<Extract<NonNullable<OccurrenceRecord['qualifier']>,
  { type: 'ingredient-line' }>> = {}): OccurrenceRecord => ({
  occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', state: 'active',
  parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', segmentKey: 'a',
  orderKey: 'a', role: 'ingredient', labels: [],
  introducedBy: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  qualifier: { type: 'ingredient-line', originalText: { value: '1 1/2 cups flour', language: 'en' },
    amountLexical: '1 1/2 cups', amount: { numerator: 3, denominator: 2 }, unitText: 'cups',
    optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial', ...overrides },
});

test('RECIPE02: exact fraction scaling retains ambiguous unit text and source lexical', () => {
  const [scaled] = scaleIngredients([line()], { numerator: 2n, denominator: 3n });
  expect(scaled).toMatchObject({ originalText: '1 1/2 cups flour', sourceLexical: '1 1/2 cups',
    unitText: 'cups', amount: { numerator: 1n, denominator: 1n }, scaled: true });
});

test('RECIPE02: non-linear and unparsed quantities keep their lexical text without conversion', () => {
  const result = scaleIngredients([line({ scaling: 'non-linear' }),
    line({ parseStatus: 'unparsed' })], { numerator: 3n, denominator: 2n });
  expect(result.map(row => [row.scaled, row.reason, row.amount])).toEqual([
    [false, 'non-linear', { numerator: 3n, denominator: 2n }],
    [false, 'unparsed', { numerator: 3n, denominator: 2n }],
  ]);
  expect(result.every(row => row.sourceLexical === '1 1/2 cups')).toBe(true);
});

test('RECIPE02: exact range endpoints scale independently without converting a cup', () => {
  const [result] = scaleIngredients([line({ amountUpper: { numerator: 9, denominator: 4 } })],
    { numerator: 2n, denominator: 3n });
  expect(result).toMatchObject({ unitText: 'cups', sourceLexical: '1 1/2 cups',
    amount: { numerator: 1n, denominator: 1n },
    amountUpper: { numerator: 3n, denominator: 2n } });
});

test('RECIPE05: nutrient totals use exact rationals and carry partial coverage and basis', () => {
  const result = calculateNutrition([
    { coverage: 'complete', values: [{ nutrient: 'protein', unit: 'g',
      amount: { numerator: 1n, denominator: 3n } }] },
    { coverage: 'partial', values: [{ nutrient: 'protein', unit: 'g',
      amount: { numerator: 1n, denominator: 6n } }] },
  ], 'per-serving');
  expect(result).toEqual({ basis: 'per-serving', coverage: 'partial', nutrients: [{
    nutrient: 'protein', unit: 'g', amount: { numerator: 1n, denominator: 2n },
  }] });
});

test('RECIPE05: absent evidence stays unknown and unlike units remain separate', () => {
  expect(calculateNutrition([], 'whole-recipe')).toEqual({ basis: 'whole-recipe',
    coverage: 'unknown', nutrients: [] });
  const result = calculateNutrition([{ coverage: 'complete', values: [
    { nutrient: 'energy', unit: 'kcal', amount: { numerator: 100n, denominator: 1n } },
    { nutrient: 'energy', unit: 'kJ', amount: { numerator: 418n, denominator: 1n } },
  ] }], 'whole-recipe');
  expect(result.nutrients).toHaveLength(2);
  expect(result.nutrients.map(item => item.unit)).toEqual(['kcal', 'kJ']);
});
