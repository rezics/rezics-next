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

test('content adoption falsifier: one third and both range endpoints scale exactly by three', () => {
  const [scaled] = scaleIngredients([line({ name: 'tomato', amount: { numerator: 1, denominator: 3 },
    amountUpper: { numerator: 2, denominator: 3 }, amountLexical: '⅓–⅔' })], { numerator: 3n, denominator: 1n });
  expect(scaled).toMatchObject({ amount: { numerator: 1n, denominator: 1n },
    amountUpper: { numerator: 2n, denominator: 1n }, sourceLexical: '⅓–⅔', scaled: true });
});

test('content adoption falsifier: scaling leaves step temperature and duration untouched', () => {
  const step: OccurrenceRecord = { ...line(), role: 'step', qualifier: { type: 'recipe-step',
    instructionText: { value: 'Bake at 180 C for 20 minutes.', language: 'en' },
    usesIngredient: [], media: [], scaling: 'linear' } };
  const records = [line(), step], original = structuredClone(records);
  expect(scaleIngredients(records, { numerator: 3n, denominator: 1n })).toHaveLength(1);
  expect(records).toEqual(original);
});

test('content adoption falsifier: exact nutrition sums, unit separation and coverage precedence', () => {
  const input = (coverage: 'complete' | 'partial' | 'unknown', numerator: bigint, denominator: bigint, unit = 'g') => ({
    coverage, values: [{ nutrient: 'protein', unit, amount: { numerator, denominator } }],
  });
  const complete = [input('complete', 1n, 3n), input('complete', 2n, 3n), input('complete', 7n, 1n, 'mg')];
  for (const basis of ['per-serving', 'whole-recipe'] as const) {
    expect(calculateNutrition(complete, basis)).toEqual({ basis, coverage: 'complete', nutrients: [
      { nutrient: 'protein', unit: 'g', amount: { numerator: 1n, denominator: 1n } },
      { nutrient: 'protein', unit: 'mg', amount: { numerator: 7n, denominator: 1n } },
    ] });
    expect(calculateNutrition([...complete, input('partial', 0n, 1n)], basis).coverage).toBe('partial');
    for (const extra of [[input('unknown', 0n, 1n), input('partial', 0n, 1n)],
      [input('partial', 0n, 1n), input('unknown', 0n, 1n)]]) {
      expect(calculateNutrition([...complete, ...extra], basis).coverage).toBe('unknown');
    }
    expect(calculateNutrition([], basis)).toEqual({ basis, coverage: 'unknown', nutrients: [] });
  }
});
