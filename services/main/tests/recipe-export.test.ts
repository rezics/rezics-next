import { expect, test } from 'bun:test';
import { exportRecipe, RECIPE_EXPORT_OCCURRENCE_LIMIT } from '../src/modules/recipe/export.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';
import { checkOccurrenceQualifier } from '../src/modules/structure/format.ts';
import { parseRecipeFile } from '../src/modules/recipe/file-intake.ts';
import { recipeSourceSupportCandidates } from '../src/modules/recipe/importer.ts';

test('pure recipe projection completes above 1 MiB while reporting synchronous import capacity', () => {
  const records = Array.from({ length: 256 }, (_, index) => ({ ...ingredient(index), role: 'step' as const,
    qualifier: { type: 'recipe-step' as const, instructionText: { value: '香'.repeat(4000), language: 'zh' },
      usesIngredient: [], media: [], scaling: 'linear' as const } }));
  expect(Buffer.byteLength(JSON.stringify(records.map(record => record.qualifier)))).toBeGreaterThan(1_048_576);
  expect(exportRecipe(records, structure).recipe.recipeInstructions).toHaveLength(records.length);
  expect(exportRecipe(records, structure).importability).toMatchObject({ status: 'not-importable', limit: 'bytes' });
});

test('owner-admitted units export unchanged and unsupported exchange units are never capacity errors', () => {
  for (const unit of ['https://qudt.org/vocab/unit/OZ', 'https://example.com/unit/cup',
    'https://rezics.com/id/00000000-0000-4000-8000-000000999999']) {
    const record = ingredient(0);
    const qualifier = { ...record.qualifier!, type: 'ingredient-line' as const, unit };
    checkOccurrenceQualifier(qualifier);
    record.qualifier = qualifier;
    const exported = exportRecipe([record], structure);
    expect(exported.recipe.recipeIngredient[0]).toHaveProperty('unitCode', unit);
    expect(exported.importability).toEqual(unit.endsWith('/OZ') ? { status: 'importable' }
      : { status: 'not-importable', code: 'recipe_unit_not_registered', unit });
  }
});

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

type IngredientRecord = OccurrenceRecord & {
  qualifier: Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>;
};

function ingredient(index: number): IngredientRecord {
  const suffix = (index + 2).toString(16).padStart(12, '0');
  return {
    occurrence: `https://rezics.com/id/00000000-0000-4000-8000-${suffix}`,
    state: 'active', parent: structure, role: 'ingredient', labels: [], introducedBy: structure,
    qualifier: { type: 'ingredient-line', originalText: { value: 'water', language: 'en' },
      optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' },
  };
}

test('recipe projection includes every occurrence past the old transport limit', () => {
  const records = Array.from({ length: RECIPE_EXPORT_OCCURRENCE_LIMIT }, (_, index) => ingredient(index));
  expect(exportRecipe(records, structure).recipe.recipeIngredient).toHaveLength(2 * RECIPE_EXPORT_OCCURRENCE_LIMIT);
  expect(exportRecipe([...records, ingredient(records.length)], structure).recipe.recipeIngredient)
    .toHaveLength(2 * (records.length + 1));
});

test('recipe export keeps original text separate from exact quantity and its lexical wording', () => {
  const record = ingredient(0);
  record.qualifier = { type: 'ingredient-line', originalText: { value: '200 g butter', language: 'en' },
    amount: { numerator: 200, denominator: 1 }, amountLexical: '200',
    textParts: { amount: { start: 0, end: 3 }, unit: { start: 4, end: 5 }, name: { start: 6, end: 12 } },
    unit: 'https://qudt.org/vocab/unit/GM', unitText: 'g', optional: true,
    scaling: 'linear', substituteFor: [], parseStatus: 'parsed' };
  expect(exportRecipe([record], structure).recipe.recipeIngredient).toEqual([{
    '@type': 'PropertyValue', text: '200 g butter', value: '200', amountLexical: '200',
    textParts: { amount: { start: 0, end: 3 }, unit: { start: 4, end: 5 }, name: { start: 6, end: 12 } },
    unitCode: 'https://qudt.org/vocab/unit/GM', unitText: 'g', optional: true,
    parseStatus: 'parsed', inLanguage: 'en',
  }, '200 g butter']);
});

test('Schema.org Recipe text readers get each ingredient in order and HowTo projection preserves instruction hierarchy', () => {
  // Primary vocabulary: https://schema.org/recipeIngredient (Text or PropertyValue)
  // and https://schema.org/recipeInstructions (HowToStep/HowToSection list).
  const ingredients = [ingredient(0), ingredient(1), ingredient(2)];
  ingredients[1]!.qualifier = { ...ingredients[1]!.qualifier,
    originalText: { value: 'Salt, q.b.', language: 'it' }, amountLexical: 'q.b.', parseStatus: 'partial' };
  const records: OccurrenceRecord[] = [...ingredients, {
    ...ingredient(3), role: 'group' as const, qualifier: undefined, labels: [{ value: 'Method', language: 'en' }],
  }, { ...ingredient(4), parent: ingredient(3).occurrence, role: 'step' as const,
    qualifier: { type: 'recipe-step' as const, instructionText: { value: 'Mix.', language: 'en' },
      usesIngredient: [], media: [], scaling: 'linear' as const } }];
  const { recipe } = exportRecipe(records, structure);
  expect(recipe['@context']).toBe('https://schema.org');
  expect(recipe['@type']).toBe('Recipe');
  const text = recipe.recipeIngredient.filter(item => typeof item === 'string');
  const carriers = recipe.recipeIngredient.filter(item => typeof item !== 'string');
  expect(text).toEqual(['water', 'Salt, q.b.', 'water']);
  expect(carriers.every(item => item['@type'] === 'PropertyValue')).toBe(true);
  expect(carriers.map(item => item.text)).toEqual(text);
  expect(recipe.recipeInstructions).toEqual([{ '@type': 'HowToSection', name: 'Method', inLanguage: 'en',
    itemListElement: [{ '@type': 'HowToStep', text: 'Mix.', inLanguage: 'en' }] }]);
  const { source, preview } = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json');
  expect(preview.ingredients.map(item => item.qualifier)).toEqual(ingredients.map(item => item.qualifier));
  expect(recipeSourceSupportCandidates(source, preview).filter(item => item.sourceField === 'recipeIngredient'))
    .toHaveLength(3);
  // A foreign mixed list is not deduplicated merely because its wording matches.
  const foreign = { ...recipe, recipeIngredient: ['water', { '@type': 'PropertyValue', name: 'water' }, 'water'] };
  expect(parseRecipeFile(Buffer.from(JSON.stringify(foreign)), 'application/ld+json').preview.ingredients).toHaveLength(3);
});
