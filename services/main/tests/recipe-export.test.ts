import { expect, test } from 'bun:test';
import { exportRecipe, RecipeExportLimit, RECIPE_EXPORT_OCCURRENCE_LIMIT } from '../src/modules/recipe/export.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

function ingredient(index: number): OccurrenceRecord {
  const suffix = (index + 2).toString(16).padStart(12, '0');
  return {
    occurrence: `https://rezics.com/id/00000000-0000-4000-8000-${suffix}`,
    state: 'active', parent: structure, role: 'ingredient', labels: [], introducedBy: structure,
    qualifier: { type: 'ingredient-line', originalText: { value: 'water', language: 'en' },
      optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' },
  };
}

test('recipe export includes 4,096 occurrences and rejects the next one', () => {
  const records = Array.from({ length: RECIPE_EXPORT_OCCURRENCE_LIMIT }, (_, index) => ingredient(index));
  expect(exportRecipe(records, structure).recipe.recipeIngredient).toHaveLength(RECIPE_EXPORT_OCCURRENCE_LIMIT);
  expect(() => exportRecipe([...records, ingredient(records.length)], structure)).toThrow(RecipeExportLimit);
});

test('recipe export keeps original text separate from exact quantity and its lexical wording', () => {
  const record = ingredient(0);
  record.qualifier = { type: 'ingredient-line', originalText: { value: '200 g butter', language: 'en' },
    amount: { numerator: 200, denominator: 1 }, amountLexical: '200 g butter',
    unit: 'https://qudt.org/vocab/unit/GM', unitText: 'g', optional: true,
    scaling: 'linear', substituteFor: [], parseStatus: 'parsed' };
  expect(exportRecipe([record], structure).recipe.recipeIngredient).toEqual([{
    '@type': 'PropertyValue', text: '200 g butter', value: '200', amountLexical: '200 g butter',
    unitCode: 'https://qudt.org/vocab/unit/GM', unitText: 'g', optional: true,
    parseStatus: 'parsed', inLanguage: 'en',
  }]);
});
