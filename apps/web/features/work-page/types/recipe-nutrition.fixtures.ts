import { summary } from '../../work-levels/fixtures.ts';
import type { Names } from '../../work-levels/types.ts';
import type { RecipeWorkPage } from '../types.ts';

const id = (tail: string) => `https://rezics.com/id/00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
export const nutritionWork = id('1');
export const nutritionEvidence = 'https://example.com/recipe/nutrition';
export const nutrientNames: Names = new Map([
  [id('10'), summary(id('10'), 'Energy', 'en', 'resource')],
  [id('11'), summary(id('11'), 'Protein', 'en', 'resource')],
  [id('12'), summary(id('12'), 'Fibre', 'en', 'resource')],
]);

/** Native contract-shaped component state, not a captured corpus or original C30 result. */
export function nutritionPage(servings = 2): RecipeWorkPage {
  const ingredients = [
    { occurrence: id('3'), originalText: '2 carrots', line: `${servings} carrots`,
      amount: { numerator: servings, denominator: 1 }, scaled: servings !== 2 },
    { occurrence: id('4'), originalText: '1 parsnip', line: servings === 2 ? '1 parsnip' : `${servings / 2} parsnips`,
      amount: { numerator: servings, denominator: 2 }, scaled: servings !== 2 },
    { occurrence: id('5'), originalText: '1 turnip', line: servings === 2 ? '1 turnip' : `${servings / 2} turnips`,
      amount: { numerator: servings, denominator: 2 }, scaled: servings !== 2 },
  ];
  return {
    profile: 'recipe-work-page-v1', structure: nutritionWork, revision: id('2'), instructions: [],
    ingredients,
    occurrences: [...ingredients.map((ingredient, index): RecipeWorkPage['occurrences'][number] => ({ occurrence: ingredient.occurrence,
      parent: nutritionWork, role: 'ingredient', state: 'active', labels: [], introducedBy: id('2'),
      qualifier: { type: 'ingredient-line', originalText: { value: ingredient.originalText, language: 'en' },
        amount: ingredient.amount, optional: false, scaling: 'linear', parseStatus: 'parsed',
        // Deliberately reverse the target order. Rendering must retain author order.
        substituteFor: index === 2 ? [id('4'), id('3')] : [] } })),
      { occurrence: id('6'), parent: nutritionWork, role: 'step', state: 'active', labels: [], introducedBy: id('2'),
        qualifier: { type: 'recipe-step', instructionText: { value: 'Slice the vegetables, then simmer until tender.', language: 'en' },
          usesIngredient: [], media: [], scaling: 'linear' } }],
    measures: [
      { kind: 'servings', value: { numerator: 2, denominator: 1 }, basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' },
      { kind: 'nutrient', nutrient: id('10'), value: { numerator: 421, denominator: 2 }, unitText: 'kcal',
        basis: 'per-serving', coverage: 'complete', provenance: 'source-stated', evidence: nutritionEvidence },
      { kind: 'nutrient', nutrient: id('11'), value: { numerator: 15 * servings, denominator: 2 }, unitText: 'g',
        basis: 'whole-recipe', coverage: 'partial', provenance: 'declared', evidence: nutritionEvidence },
      { kind: 'nutrient', nutrient: id('12'), value: { numerator: 0, denominator: 1 }, unitText: 'g',
        basis: 'per-serving', coverage: 'unknown', provenance: 'computed' },
    ],
    cost: { pages: 1, pagesRead: 1, occurrences: ingredients.length + 1 },
  };
}
