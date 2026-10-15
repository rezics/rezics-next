import { expect, test } from 'bun:test';
import { ingredientName } from '../src/modules/recipe/display.ts';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { scaleIngredients } from '../src/modules/recipe/operations.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const factor = { numerator: 1n, denominator: 1n };

const occurrenceId = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`;

function record(index: number, qualifier: Extract<NonNullable<OccurrenceRecord['qualifier']>,
  { type: 'ingredient-line' }>): OccurrenceRecord {
  return { occurrence: occurrenceId(index), state: 'active', parent: structure, segmentKey: `ingredient-${index}`,
    orderKey: String.fromCharCode(97 + index), role: 'ingredient', labels: [], introducedBy: structure, qualifier };
}

test('imported quantity prefixes keep ingredient names through naming, display and export', () => {
  const cases = [
    { line: '⅔ cup sugar', lexical: '⅔', name: 'sugar' },
    { line: '1 1/2 cups flour', lexical: '1 1/2', name: 'flour' },
    { line: '2 to 3 tablespoons butter', lexical: '2 to 3', name: 'butter' },
    { line: 'salt to taste', lexical: undefined, name: undefined },
  ];
  const imported = importRecipe({ recipeIngredient: cases.map(item => item.line) }, 'recipe');
  expect(imported.ingredients).toHaveLength(cases.length);

  const records = imported.ingredients.map((item, index) => record(index, item.qualifier));
  const displayed = scaleIngredients(records, factor);
  const exported = exportRecipe(records, structure).recipe.recipeIngredient;
  const roundTrip = importRecipe({ recipeIngredient: exported }, 'round-trip').ingredients;

  cases.forEach((item, index) => {
    const qualifier = imported.ingredients[index]!.qualifier;
    expect(qualifier.amountLexical).toBe(item.lexical);
    expect(ingredientName(qualifier)).toBe(item.name);
    if (item.name !== undefined) expect(displayed[index]?.line.endsWith(item.name)).toBe(true);
    else expect(displayed[index]?.line).toBe(item.line);
    expect(exported[index]).toMatchObject({ text: item.line });
    expect(roundTrip[index]?.qualifier).toEqual(qualifier);

    if (qualifier.amount) {
      expect(exported[index]).toMatchObject({ amountLexical: item.lexical });
      expect(roundTrip[index]?.qualifier.amountLexical).toBe(item.lexical);
    } else {
      expect(exported[index]).not.toHaveProperty('value');
      expect(roundTrip[index]?.qualifier.amountLexical).toBe(item.lexical);
    }
  });
});

test('recorded name spans do not consume independent quantity wording', () => {
  const [imported] = importRecipe({ recipeIngredient: ['1½ cups flour'] }, 'recipe').ingredients;
  const qualifier = { ...imported!.qualifier, amountLexical: 'about half' };
  const legacy = record(0, qualifier);

  expect(ingredientName(qualifier)).toBe('flour');
  expect(ingredientName({ ...qualifier, textParts: undefined })).toBeUndefined();
  expect(scaleIngredients([legacy], factor)[0]?.line.endsWith(' flour')).toBe(true);
  const exported = exportRecipe([legacy], structure).recipe.recipeIngredient;
  expect(exported).toMatchObject([{ text: '1½ cups flour', value: '3/2',
    amountLexical: 'about half' }, '1½ cups flour']);
  expect(importRecipe({ recipeIngredient: exported }, 'round-trip').ingredients[0]?.qualifier)
    .toEqual(qualifier);
});
