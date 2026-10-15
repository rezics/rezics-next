import { expect, test } from 'bun:test';
import type { MainClient } from '../studio/types.ts';
import { actingSubject, id, structure } from './fixtures.ts';
import { mainRecipeExportApi, RecipeExportError, recipeExportFilename, type RecipeExport } from './export-api.ts';
import { englishMessages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const revision = id(901);
const exported: RecipeExport = { profile: 'recipe-schema-org-export-v1', structure, revision,
  recipe: { '@context': 'https://schema.org', '@type': 'Recipe', recipeIngredient: ['2 apples'], recipeInstructions: [] } };

function client(reply: { data: unknown; error: { status: number; value?: unknown } | null }) {
  const calls: { id: string; query: unknown }[] = [];
  const main = { v1: { recipes: (_: { id: string }) => ({ export: { get: async ({ query }: { query: unknown }) => {
    calls.push({ id: _.id, query }); return reply;
  } } }) } } as unknown as MainClient;
  return { main: () => main, calls };
}

test('the Schema.org export is pinned to the editor revision and names that returned revision', async () => {
  const fake = client({ data: exported, error: null });
  const actual = await mainRecipeExportApi(fake.main).exportRevision({ structure, revision, actingSubject });
  expect(actual).toEqual(exported);
  expect(fake.calls).toEqual([{ id: structure.slice(-36), query: { actingSubject, revision, format: 'schema-org' } }]);
  expect(recipeExportFilename(actual.revision)).toBe(`recipe-revision-${revision.slice(-36)}.schema-org.json`);
});

test('the typed occurrence-limit refusal keeps Main’s message for the cook', async () => {
  const fake = client({ data: null, error: { status: 413, value: {
    type: 'https://rezics.com/problems/recipe_export_too_large', status: 413,
    code: 'recipe_export_too_large', title: 'Recipe export exceeds 4,096 occurrences',
  } } });
  let refusal: unknown;
  try {
    await mainRecipeExportApi(fake.main).exportRevision({ structure, revision, actingSubject });
  } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(RecipeExportError);
  expect(refusal).toMatchObject({ failure: 'too-large', message: 'Recipe export exceeds 4,096 occurrences' });
});

test('a denied export read is identified without exposing a generic failure', async () => {
  const fake = client({ data: null, error: { status: 403, value: { code: 'authority_denied', title: 'Read denied' } } });
  let refusal: unknown;
  try {
    await mainRecipeExportApi(fake.main).exportRevision({ structure, revision, actingSubject });
  } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(RecipeExportError);
  expect(refusal).toMatchObject({ failure: 'denied' });
});

test('exchange controls have authored messages in all eight editor locales', () => {
  const catalogs = { en: englishMessages, de, es, fr, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
  for (const catalog of Object.values(catalogs)) {
    expect(catalog.exportAction).toBeTruthy();
    expect(catalog.exporting).toBeTruthy();
    expect(catalog.exportedRevision).toBeTruthy();
    expect(catalog.exportDenied).toBeTruthy();
    expect(catalog.exportTooLargeFallback).toBeTruthy();
    expect(catalog.exportUnavailable).toBeTruthy();
  }
});
