import { expect, test } from 'bun:test';
import { scaleIngredients } from '../src/modules/recipe/operations.ts';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const line = (originalText: string, numerator: number, denominator: number, unitText: string,
  overrides: Partial<Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>> = {},
): OccurrenceRecord => ({
  occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', state: 'active',
  parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', segmentKey: 'a',
  orderKey: 'a', role: 'ingredient', labels: [],
  introducedBy: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  qualifier: { ...importRecipe({ recipeIngredient: [originalText] }, 'display-source').ingredients[0]!.qualifier,
    amount: { numerator, denominator }, unitText, optional: false, scaling: 'linear', substituteFor: [],
    parseStatus: 'parsed', ...overrides },
});

test('a scaled cup line names the ingredient, pluralizes, and offers milliliters', () => {
  const [scaled] = scaleIngredients([line('1 1/2 cups flour', 3, 2, 'cups')], { numerator: 2n, denominator: 1n });
  expect(scaled).toMatchObject({
    amount: { numerator: 3n, denominator: 1n }, scaled: true,
    line: '3 cups flour', alternateLine: '720 ml flour', alternateSystem: 'metric',
    hint: '1 1/2 cups flour',
  });
});

test('a singular cup pluralizes in the kitchen line', () => {
  const [scaled] = scaleIngredients([line('1 cup buttermilk', 1, 1, 'cup')], { numerator: 2n, denominator: 1n });
  expect(scaled?.line).toBe('2 cups buttermilk');
  expect(scaled?.alternateLine).toBe('480 ml buttermilk');
});

test('thirds, halves and quarters use kitchen fractions', () => {
  expect(scaleIngredients([line('1 cup flour', 1, 1, 'cup')], { numerator: 2n, denominator: 3n })[0]?.line)
    .toBe('⅔ cup flour');
  expect(scaleIngredients([line('1 cup flour', 1, 1, 'cup')], { numerator: 1n, denominator: 2n })[0]?.line)
    .toBe('½ cup flour');
  expect(scaleIngredients([line('1 cup flour', 1, 1, 'cup')], { numerator: 3n, denominator: 4n })[0]?.line)
    .toBe('¾ cup flour');
  expect(scaleIngredients([line('1 1/2 cups flour', 3, 2, 'cups')], { numerator: 3n, denominator: 2n })[0]?.line)
    .toBe('2 ¼ cups flour');
});

test('a recognized count cannot override an authored not-scalable quantity', () => {
  const [scaled] = scaleIngredients([line('1 egg', 1, 1, 'egg', { scaling: 'not-scalable' })],
    { numerator: 2n, denominator: 1n });
  expect(scaled).toMatchObject({ line: '1 egg', originalText: '1 egg', scaled: false,
    amount: { numerator: 1n, denominator: 1n }, reason: 'not-scalable' });
  expect(scaled?.hint).toBeUndefined();
  expect(scaled?.alternateLine).toBeUndefined();
});

test('kitchen advice does not override exact authored linear amounts', () => {
  const doubled = scaleIngredients([line('1/4 teaspoon salt', 1, 4, 'teaspoon')], { numerator: 2n, denominator: 1n })[0];
  expect(doubled).toMatchObject({ line: '½ teaspoon salt', scaled: true, amount: { numerator: 1n, denominator: 2n } });
  expect(doubled?.judgment).toBeUndefined();
  const quadrupled = scaleIngredients([line('1/4 teaspoon salt', 1, 4, 'teaspoon')],
    { numerator: 4n, denominator: 1n })[0];
  expect(quadrupled).toMatchObject({ line: '1 teaspoon salt', scaled: true, judgment: 'seasoning',
    amount: { numerator: 1n, denominator: 1n }, originalText: '1/4 teaspoon salt', hint: '1/4 teaspoon salt' });
  const powder = scaleIngredients([line('2 teaspoons baking powder', 2, 1, 'teaspoons')],
    { numerator: 4n, denominator: 1n })[0];
  expect(powder).toMatchObject({ line: '8 teaspoons baking powder', judgment: 'leavening', scaled: true,
    amount: { numerator: 8n, denominator: 1n }, hint: '2 teaspoons baking powder' });
});

test('numeric ranges retain the exact source policy without changing repeated ingredient identities', () => {
  for (const scaling of ['linear', 'non-linear', 'not-scalable'] as const) {
    for (const parseStatus of ['parsed', 'partial', 'unparsed'] as const) {
      const first = line('1/3–2/3 egg', 1, 3, 'egg', { scaling, parseStatus,
        amountUpper: { numerator: 2, denominator: 3 } });
      const second = { ...structuredClone(first), occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004' };
      const original = structuredClone([first, second]);
      const scaled = scaleIngredients([first, second], { numerator: 3n, denominator: 4n });
      const applies = scaling === 'linear' && parseStatus !== 'unparsed';
      expect(scaled.map(item => item.occurrence)).toEqual([first.occurrence, second.occurrence]);
      for (const item of scaled) {
        expect(item.amount).toEqual(applies ? { numerator: 1n, denominator: 4n } : { numerator: 1n, denominator: 3n });
        expect(item.amountUpper).toEqual(applies ? { numerator: 1n, denominator: 2n } : { numerator: 2n, denominator: 3n });
        expect(item.scaled).toBe(applies);
        expect(item.reason).toBe(parseStatus === 'unparsed' ? 'unparsed' : scaling === 'linear' ? undefined : scaling);
        expect(item.originalText).toBe('1/3–2/3 egg');
      }
      expect([first, second]).toEqual(original);
    }
  }
});

test('grams offer ounces and an unknown unit stays as written', () => {
  const [grams] = scaleIngredients([line('100 g chocolate', 100, 1, 'g')], { numerator: 1n, denominator: 1n });
  expect(grams).toMatchObject({ line: '100 g chocolate', alternateLine: '3 ⅝ ounces chocolate', alternateSystem: 'us' });
  const unknown = line('1 splash vanilla', 1, 1, 'splash');
  unknown.qualifier = importRecipe({ recipeIngredient: [{ name: 'vanilla', value: 1, unitText: 'splash' }] }, 'display-source')
    .ingredients[0]!.qualifier;
  const [splash] = scaleIngredients([unknown], { numerator: 2n, denominator: 1n });
  expect(splash?.line).toBe('2 splash vanilla');
  expect(splash?.alternateLine).toBeUndefined();
});
