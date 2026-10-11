import { expect, test } from 'bun:test';
import { MAX_RECIPE_FILE_BYTES, parseRecipeFile, readRecipeFileBytes,
  RecipeFileInvalid, RecipeFileTooLarge } from '../src/modules/recipe/file-intake.ts';

const asBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const recipe = { '@type': 'Recipe', recipeIngredient: ['1 1/2 cups cream'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Cool gently.' }] };

test('file intake accepts one Schema.org Recipe and only projects importable fields', () => {
  const parsed = parseRecipeFile(asBytes({ ...recipe, '@context': 'https://schema.org',
    name: 'Crème brûlée', image: 'a handwritten recipe card' }), 'application/ld+json');
  expect(parsed.source).toEqual({ recipeIngredient: recipe.recipeIngredient,
    recipeInstructions: recipe.recipeInstructions });
  expect(parsed.preview.ingredients[0]?.qualifier.amount).toEqual({ numerator: 3, denominator: 2 });
  expect(parseRecipeFile(asBytes(recipe), 'application/json; charset=utf-8').preview.steps).toHaveLength(1);
});

test('file intake rejects invalid types, HTML, script content, remote URLs and JSON-LD graph features', () => {
  const invalidFiles: Array<[unknown, string]> = [
    [recipe, 'text/html'],
    [{ ...recipe, name: '<script>alert(1)</script>' }, 'application/json'],
    [{ ...recipe, recipeInstructions: ['Open https://example.com before cooking'] }, 'application/json'],
    [{ ...recipe, description: 'More at cookbook.example.com' }, 'application/json'],
    [{ ...recipe, recipeInstructions: ['Use data:text/html,<script>no</script>'] }, 'application/json'],
    [{ ...recipe, '@graph': [recipe] }, 'application/ld+json'],
    [{ ...recipe, '@context': 'https://attacker.example/context.jsonld' }, 'application/ld+json'],
    [{ ...recipe, recipeInstructions: [{ '@type': 'Recipe', recipeIngredient: ['salt'] }] }, 'application/json'],
    [{ '@type': 'Recipe', scripts: ['alert(1)'], recipeIngredient: ['salt'] }, 'application/json'],
    [{ '@type': 'Recipe', recipeIngredient: ['salt'], recipeInstructions: ['<b>serve</b>'] }, 'application/json'],
    [{ '@type': 'Recipe', recipeIngredient: [], recipeInstructions: [] }, 'application/json'],
  ];
  for (const [document, mediaType] of invalidFiles) {
    expect(() => parseRecipeFile(asBytes(document), mediaType)).toThrow(RecipeFileInvalid);
  }
  expect(() => parseRecipeFile(Buffer.from('{'), 'application/json')).toThrow(RecipeFileInvalid);
  expect(() => parseRecipeFile(asBytes(recipe), 'application/xml')).toThrow(RecipeFileInvalid);
  expect(() => parseRecipeFile(asBytes({ ...recipe, '@context': { '@vocab': 'https://schema.org' } }),
    'application/ld+json')).toThrow(RecipeFileInvalid);
});

test('file intake accepts exactly 256 KiB and rejects the next byte before parsing', async () => {
  const prefix = '{"@type":"Recipe","recipeIngredient":["1 cup flour"],"name":"';
  const suffix = '"}';
  const exact = Buffer.from(`${prefix}${'x'.repeat(MAX_RECIPE_FILE_BYTES - Buffer.byteLength(prefix)
    - Buffer.byteLength(suffix))}${suffix}`);
  expect(exact.byteLength).toBe(MAX_RECIPE_FILE_BYTES);
  expect(parseRecipeFile(exact, 'application/json').preview.ingredients).toHaveLength(1);

  const tooLarge = Buffer.concat([exact, Buffer.from(' ')]);
  expect(() => parseRecipeFile(tooLarge, 'application/json')).toThrow(RecipeFileTooLarge);
  const request = new Request('http://main.local/upload', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: new Blob([tooLarge]) });
  await expect(readRecipeFileBytes(request)).rejects.toBeInstanceOf(RecipeFileTooLarge);
});
