import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { parseDocument } from '@rezics/document';
import { authoredDocumentBody } from '../../content/src/document-body.ts';
import { normalizeCollectionRecipe, readRecipeCollection, RECIPE_COLLECTION_LIMITS,
  type RecipeCollectionFormat } from '../src/modules/recipe/collection-file.ts';
import { RecipeFileInvalid } from '../src/modules/recipe/file-intake.ts';

const paprika = readFileSync(new URL('../../../tests/fixtures/recipes/move-in.paprikarecipe.json', import.meta.url));
const mela = readFileSync(new URL('../../../tests/fixtures/recipes/move-in.melarecipe', import.meta.url));
const exports: Array<[RecipeCollectionFormat, Uint8Array]> = [
  ['paprikarecipes', zipSync({ 'recipe.paprikarecipe': gzipSync(paprika) })],
  ['melarecipes', zipSync({ 'recipe.melarecipe': mela })], ['melarecipe', mela],
  ['melarecipes', Buffer.from(JSON.stringify([JSON.parse(mela.toString())]))],
];

for (const [format, bytes] of exports) test(`${format} preserves exact facts, multilingual text and source-only personal data`, () => {
  const entries = readRecipeCollection(bytes, format);
  expect(entries).toHaveLength(1);
  const first = normalizeCollectionRecipe(entries[0]!, format);
  const repeated = normalizeCollectionRecipe(readRecipeCollection(bytes, format)[0]!, format);
  expect(repeated).toEqual(first);
  expect(first.language).toBe('und');
  expect(first.title).toBe('奶奶的豆汤 — soupe');
  const lines = first.parsed.ingredients.map(item => item.qualifier);
  expect(lines.map(line => line.originalText.value)).toEqual([
    '1–2 cups beans', '½ cup crème', '2 tomatoes', '200 克 牛奶', 'salt to taste', '7up soda', '  1 1/2 cups 小麦粉  ',
  ]);
  expect(lines[0]).toMatchObject({ amount: { numerator: 1, denominator: 1 }, amountUpper: { numerator: 2, denominator: 1 } });
  expect(lines[1]).toMatchObject({ amount: { numerator: 1, denominator: 2 } });
  expect(lines[2]).toMatchObject({ amount: { numerator: 2, denominator: 1 } });
  expect(lines[2]!.unit).toBeUndefined();
  expect(lines[2]!.unitText).toBeUndefined();
  expect(lines[3]).toMatchObject({ amount: { numerator: 200, denominator: 1 }, unitText: '克' });
  expect(lines[4]!.amount).toBeUndefined();
  expect(lines[5]!.amount).toBeUndefined();
  expect(lines[6]).toMatchObject({ amount: { numerator: 3, denominator: 2 } });
  expect(first.categories).toEqual(['Family', '汤']);
  expect(first.rating).toBe(format === 'paprikarecipes' ? 4 : 4.5);
  expect(first.retainedOnly).toContain('future_field');
  expect(first.photos).toHaveLength(1);
  expect(parseDocument(first.document)).toEqual(first.document);
  const body = authoredDocumentBody({ document: first.document });
  expect(body.body).toContain('炖煮至软。');
  expect(body.body).toContain("PRIVATE: Grandma's note — 少许盐。");
  expect(first.document.doc.content?.[0]).toMatchObject({ type: 'extensionBlock', attrs: {
    definition: 'https://rezics.com/definition/procedure-v1', payload: { items: [
      { type: 'HowToStep', id: 'step-0' }, { type: 'HowToStep', id: 'step-1' }, { type: 'HowToStep', id: 'step-2' },
    ] } } });
});

test('an invalid member is an explicit per-file refusal beside a valid recipe', () => {
  const entries = readRecipeCollection(zipSync({ 'valid.paprikarecipe': gzipSync(paprika),
    'bad.paprikarecipe': Buffer.from('not gzip'), 'other.txt': Buffer.from('unsupported') }), 'paprikarecipes');
  expect(entries).toHaveLength(3);
  expect(entries.filter(entry => entry.error).map(entry => entry.error).sort())
    .toEqual(['invalid-or-oversized-gzip', 'unsupported-archive-entry']);
  expect(normalizeCollectionRecipe(entries.find(entry => entry.name === 'valid.paprikarecipe')!, 'paprikarecipes').title)
    .toBe('奶奶的豆汤 — soupe');
});

test('both compression layers, invalid JSON and archive paths are bounded before normalization', () => {
  const expanded = Buffer.alloc(RECIPE_COLLECTION_LIMITS.recipeBytes + 1, 32);
  const refused = readRecipeCollection(zipSync({ 'bomb.paprikarecipe': gzipSync(expanded) }), 'paprikarecipes');
  expect(refused[0]!.error).toBe('invalid-or-oversized-gzip');
  expect(() => readRecipeCollection(zipSync({ '../escape.melarecipe': mela }), 'melarecipes')).toThrow(RecipeFileInvalid);
  expect(() => readRecipeCollection(Buffer.alloc(RECIPE_COLLECTION_LIMITS.bytes + 1), 'melarecipes')).toThrow(RecipeFileInvalid);
  expect(() => normalizeCollectionRecipe({ name: 'bad', bytes: Buffer.from('{') }, 'melarecipe')).toThrow(RecipeFileInvalid);
  expect(() => normalizeCollectionRecipe({ name: 'bad', value: { title: 'T', ingredients: 42 } }, 'melarecipe')).toThrow(RecipeFileInvalid);
  const malicious = JSON.parse(mela.toString()); malicious.instructions = 'Text with https://example.org retained inertly.';
  expect(JSON.stringify(normalizeCollectionRecipe({ name: 'links', value: malicious }, 'melarecipe').document))
    .toContain('https://example.org');
});
