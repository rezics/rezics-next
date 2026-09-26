import { expect, test } from 'bun:test';
import { importRecipe } from '../../../services/main/src/modules/recipe/importer.ts';

test('RECIPE03: duplicate ingredient occurrences and grouped multilingual instructions retain order', () => {
  const result = importRecipe({ recipeIngredient: ['1/2 cup milk', '1/2 cup milk'],
    recipeInstructions: [{ '@type': 'HowToSection', name: 'Prepare', inLanguage: 'fr', itemListElement: [
      { '@type': 'HowToStep', text: 'Warm the milk.' },
      { '@type': 'HowToStep', text: 'Fold gently.', inLanguage: 'en' },
    ] }], unknownProviderField: { retained: true } }, 'https://rezics.com/id/00000000-0000-4000-8000-000000000001');
  expect(result.ingredients).toHaveLength(2);
  expect(new Set(result.ingredients.map(item => item.sourceKey)).size).toBe(2);
  expect(result.ingredients[0]?.qualifier.amount).toEqual({ numerator: 1, denominator: 2 });
  expect(result.ingredients[0]?.qualifier.unitText).toBe('cup');
  expect(result.sections).toEqual([{ sourceKey: expect.stringContaining('#/recipeInstructions/0'),
    label: 'Prepare', language: 'fr' }]);
  expect(result.steps.map(step => [step.text, step.language, step.section])).toEqual([
    ['Warm the milk.', 'fr', 0], ['Fold gently.', 'en', 0],
  ]);
  expect(result.residual).toMatch(/^[0-9a-f]{64}$/);
});

test('RECIPE03: structured PropertyValue quantities retain exact values and unresolved unit codes', () => {
  const result = importRecipe({ inLanguage: 'es', recipeIngredient: [
    { '@type': 'PropertyValue', value: '3/4', name: 'azúcar', unitCode: 'G21' },
    { '@type': 'PropertyValue', value: 1.25, name: 'leche', unitText: 'cups' },
  ] }, 'observation');
  expect(result.ingredients.map(item => item.qualifier)).toMatchObject([
    { originalText: { language: 'es' }, amountLexical: '3/4',
      amount: { numerator: 3, denominator: 4 }, unitText: 'G21' },
    { originalText: { language: 'es' }, amountLexical: '1.25',
      amount: { numerator: 5, denominator: 4 }, unitText: 'cups' },
  ]);
});

test('RECIPE03: free text instructions and unknown quantities remain source text', () => {
  const result = importRecipe({ recipeIngredient: ['a handful of herbs'],
    recipeInstructions: 'Taste and adjust as needed.' }, 'source-observation');
  expect(result.ingredients[0]?.qualifier).toMatchObject({ amountLexical: 'a handful of herbs',
    parseStatus: 'unparsed', originalText: { value: 'a handful of herbs', language: 'en' } });
  expect(result.steps[0]).toMatchObject({ text: 'Taste and adjust as needed.',
    sourceKey: 'source-observation#/recipeInstructions/0' });
});
