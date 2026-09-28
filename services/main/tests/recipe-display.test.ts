import { expect, test } from 'bun:test';
import { scaleIngredients } from '../src/modules/recipe/operations.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const line = (originalText: string, numerator: number, denominator: number, unitText: string,
  overrides: Partial<Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>> = {},
): OccurrenceRecord => ({
  occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', state: 'active',
  parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', segmentKey: 'a',
  orderKey: 'a', role: 'ingredient', labels: [],
  introducedBy: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  qualifier: { type: 'ingredient-line', originalText: { value: originalText, language: 'en' },
    amountLexical: originalText.split(' ').slice(0, originalText.startsWith('1 ') ? 2 : 1).join(' '),
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

test('a count marked not-scalable still scales and pluralizes', () => {
  const [scaled] = scaleIngredients([line('1 egg', 1, 1, 'egg', { scaling: 'not-scalable' })],
    { numerator: 2n, denominator: 1n });
  expect(scaled).toMatchObject({ line: '2 eggs', hint: '1 egg', scaled: true, amount: { numerator: 2n, denominator: 1n } });
  expect(scaled?.reason).toBeUndefined();
  expect(scaled?.alternateLine).toBeUndefined();
});

test('salt and leavening scale through a doubling and hold beyond it', () => {
  const doubled = scaleIngredients([line('1/4 teaspoon salt', 1, 4, 'teaspoon')], { numerator: 2n, denominator: 1n })[0];
  expect(doubled).toMatchObject({ line: '½ teaspoon salt', scaled: true, amount: { numerator: 1n, denominator: 2n } });
  expect(doubled?.judgment).toBeUndefined();
  const quadrupled = scaleIngredients([line('1/4 teaspoon salt', 1, 4, 'teaspoon')],
    { numerator: 4n, denominator: 1n })[0];
  expect(quadrupled).toMatchObject({ line: '¼ teaspoon salt', scaled: false, judgment: 'seasoning',
    amount: { numerator: 1n, denominator: 4n } });
  expect(quadrupled?.hint).toBeUndefined();
  const powder = scaleIngredients([line('2 teaspoons baking powder', 2, 1, 'teaspoons')],
    { numerator: 4n, denominator: 1n })[0];
  expect(powder).toMatchObject({ line: '2 teaspoons baking powder', judgment: 'leavening', scaled: false });
});

test('grams offer ounces and an unknown unit stays as written', () => {
  const [grams] = scaleIngredients([line('100 g chocolate', 100, 1, 'g')], { numerator: 1n, denominator: 1n });
  expect(grams).toMatchObject({ line: '100 g chocolate', alternateLine: '3 ⅝ ounces chocolate', alternateSystem: 'us' });
  const [splash] = scaleIngredients([line('1 splash vanilla', 1, 1, 'splash')], { numerator: 2n, denominator: 1n });
  expect(splash?.line).toBe('2 splash vanilla');
  expect(splash?.alternateLine).toBeUndefined();
});
