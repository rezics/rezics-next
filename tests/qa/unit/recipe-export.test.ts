import { expect, test } from 'bun:test';
import { exportRecipe } from '../../../services/main/src/modules/recipe/export.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';

const id = (suffix: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const structure = id(1);
const base = (occurrence: number, parent: string, role: OccurrenceRecord['role']): OccurrenceRecord => ({
  occurrence: id(occurrence), parent, role, state: 'active', segmentKey: 'a', orderKey: 'a',
  labels: [], introducedBy: id(99),
});

test('RECIPE03: exact Schema.org export preserves grouped step order and unparsed source residuals', () => {
  const group = { ...base(2, structure, 'group'), labels: [{ value: 'Finish', language: 'en' }],
    sourceKey: `${id(8)}#/recipeInstructions/0` };
  const first = { ...base(3, group.occurrence, 'step'), qualifier: {
    type: 'recipe-step' as const, instructionText: { value: 'Stir.', language: 'en' },
    usesIngredient: [], media: [], scaling: 'linear' as const } };
  const second = { ...base(4, group.occurrence, 'step'), qualifier: {
    type: 'recipe-step' as const, instructionText: { value: 'Serve.', language: 'en' },
    usesIngredient: [], media: [], scaling: 'linear' as const } };
  const ingredient = { ...base(5, structure, 'ingredient'), sourceKey: `${id(8)}#/recipeIngredient/0`,
    qualifier: { type: 'ingredient-line' as const,
      originalText: { value: 'a handful of herbs', language: 'en' },
      amountLexical: 'a handful of herbs', optional: false, scaling: 'linear' as const,
      substituteFor: [], parseStatus: 'unparsed' as const,
      residual: `sha256:${'a'.repeat(64)}` } };
  const result = exportRecipe([group, ingredient, first, second], structure);
  expect(result.recipe.recipeInstructions).toEqual([{ '@type': 'HowToSection',
    name: 'Finish', inLanguage: 'en', sourceKey: group.sourceKey,
    itemListElement: [{ '@type': 'HowToStep', text: 'Stir.', inLanguage: 'en' },
      { '@type': 'HowToStep', text: 'Serve.', inLanguage: 'en' }] }]);
  expect(result.recipe.recipeIngredient).toEqual(['a handful of herbs']);
  expect(result.residuals).toEqual([{ sourceKey: ingredient.sourceKey,
    text: 'a handful of herbs', parseStatus: 'unparsed', residual: ingredient.qualifier.residual }]);
  expect(result.sourceObservations).toEqual([id(8)]);
});

test('RECIPE03: export rejects work beyond its declared occurrence bound', () => {
  const record = base(6, structure, 'equipment');
  expect(() => exportRecipe(Array.from({ length: 4097 }, () => record), structure))
    .toThrow('4096 occurrences');
});
