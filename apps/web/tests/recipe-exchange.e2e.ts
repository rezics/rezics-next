import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { recipeEditHref } from '../features/recipe-editor/route.ts';
import { studioHref } from '../features/studio/agent.ts';
import { signInAtAccounts } from './account-sign-in.ts';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }
interface RecipeWork { work: string; structure: string; revision: string }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sessionStudio(actingSubject: string): string {
  return `/en${studioHref({ iri: actingSubject, handle: null })}`;
}

async function signIn(page: Page, actingSubject: string): Promise<void> {
  await signInAtAccounts(page, sessionStudio(actingSubject),
    fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member);
}

/** Create the Work and empty Composition through Main's public API, as the authoring journey does. */
async function createRecipeWork(page: Page, title: string, actingSubject: string): Promise<RecipeWork> {
  const workResponse = await page.request.post('/api/main/v1/works', {
    headers: { 'idempotency-key': `recipe-exchange-work:${crypto.randomUUID()}` },
    data: { profile: 'metadata-only-v1', title, language: 'fr',
      semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject },
  });
  expect(workResponse.status()).toBe(201);
  const work = await workResponse.json() as { work: string; mainVersion: string };

  const compositionResponse = await page.request.post('/api/main/v1/compositions', {
    headers: { 'idempotency-key': `recipe-exchange-composition:${crypto.randomUUID()}` },
    data: { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject },
  });
  expect(compositionResponse.status()).toBe(201);
  const composition = await compositionResponse.json() as { structure: string; revision: string };
  return { work: work.work, structure: composition.structure, revision: composition.revision };
}

const recipeName = 'Crème brûlée familiale';
const ingredientLines = [
  '1 1/2 tasse de crème épaisse',
  '1/3 tasse de sucre en poudre',
  '1 1/2 tasse de crème épaisse',
];
const importedSteps = [
  'Faire chauffer doucement la crème, puis la laisser refroidir.',
  'Répartir le sucre sur la crème.',
  'Caraméliser au chalumeau.',
];
const editedSteps = [
  'Chauffer doucement la crème, puis la laisser refroidir.',
  ...importedSteps.slice(1),
];

// Based on tests/qa/integration/recipe-file-import.fixture.json, with two sections, duplicate
// ingredient text, and a French recipe name/language. The fixture stays small and local to this journey.
const recipeFile = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: recipeName,
  inLanguage: 'fr',
  recipeIngredient: ingredientLines,
  recipeInstructions: [
    { '@type': 'HowToSection', name: 'Crème', itemListElement: [
      { '@type': 'HowToStep', text: importedSteps[0] },
    ] },
    { '@type': 'HowToSection', name: 'Caramel', itemListElement: [
      { '@type': 'HowToStep', text: importedSteps[1] },
      { '@type': 'HowToStep', text: importedSteps[2] },
    ] },
  ],
};

async function expectRecipeRepresentation(page: Page, steps: string[]): Promise<void> {
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(recipeName);
  const sections = page.locator('input[aria-label="Section name"]');
  await expect(sections.nth(0)).toHaveValue('Crème');
  await expect(sections.nth(1)).toHaveValue('Caramel');
  await expect(page.locator('[data-line] span')).toHaveText([
    '1 ½ tasse de crème épaisse', '⅓ tasse de sucre en poudre', '1 ½ tasse de crème épaisse',
  ]);
  expect(await page.locator('[data-step] textarea').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLTextAreaElement).value))).toEqual(steps);
  expect(await page.locator('[data-line] span').evaluateAll(nodes => nodes.map(node => node.getAttribute('lang'))))
    .toEqual(['fr', 'fr', 'fr']);
  expect(await page.locator('[data-step] textarea').evaluateAll(nodes => nodes.map(node => node.getAttribute('lang'))))
    .toEqual(['fr', 'fr', 'fr']);
}

async function openRecipeEditor(page: Page, work: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/en${recipeEditHref(work)}`);
    await expect(page.getByRole('heading', { name: 'About this recipe' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Download Schema.org JSON' }))
      .toHaveAttribute('data-hydrated', 'true', { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
}

test('a cook imports, edits, exports, and reimports a Schema.org recipe with its supported representation', async ({ page }) => {
  test.setTimeout(900_000);
  const actingSubject = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject;
  await signIn(page, actingSubject);
  const first = await createRecipeWork(page, recipeName, actingSubject);
  const second = await createRecipeWork(page, recipeName, actingSubject);

  await openRecipeEditor(page, first.work);
  await page.locator('input[type="file"][aria-label="Import Schema.org JSON"]').setInputFiles({
    name: 'creme-brulee.json', mimeType: 'application/ld+json', buffer: Buffer.from(JSON.stringify(recipeFile)),
  });
  await expect(page.getByRole('status').filter({ hasText: /^Imported into revision / })).toBeVisible({ timeout: 60_000 });
  await expectRecipeRepresentation(page, importedSteps);

  const firstStep = page.locator('[data-step] textarea').first();
  await firstStep.fill(editedSteps[0]!);
  await firstStep.blur();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expectRecipeRepresentation(page, editedSteps);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Schema.org JSON' }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(readFileSync(downloadPath!, 'utf8')) as {
    '@context': string; '@type': string; name: string; inLanguage: string;
    recipeIngredient: string[];
    recipeInstructions: Array<{ '@type': string; name: string; inLanguage: string;
      itemListElement: Array<{ '@type': string; text: string; inLanguage: string }> }>;
  };
  expect(download.suggestedFilename()).toMatch(/^recipe-revision-[0-9a-f-]{36}\.schema-org\.json$/);
  expect(exported).toMatchObject({ '@context': 'https://schema.org', '@type': 'Recipe', name: recipeName, inLanguage: 'fr' });
  expect(exported.recipeIngredient).toEqual(ingredientLines);
  expect(exported.recipeInstructions.map(section => ({
    type: section['@type'], name: section.name, language: section.inLanguage,
    steps: section.itemListElement.map(step => ({ type: step['@type'], text: step.text, language: step.inLanguage })),
  }))).toEqual([
    { type: 'HowToSection', name: 'Crème', language: 'fr',
      steps: [{ type: 'HowToStep', text: editedSteps[0], language: 'fr' }] },
    { type: 'HowToSection', name: 'Caramel', language: 'fr', steps: [
      { type: 'HowToStep', text: editedSteps[1], language: 'fr' },
      { type: 'HowToStep', text: editedSteps[2], language: 'fr' },
    ] },
  ]);
  expect(JSON.stringify(exported)).not.toContain('sourceKey');

  // The downloaded file itself, rather than the API response envelope, is the import input.
  await openRecipeEditor(page, second.work);
  await page.locator('input[type="file"][aria-label="Import Schema.org JSON"]').setInputFiles({
    name: download.suggestedFilename(), mimeType: 'application/ld+json', buffer: readFileSync(downloadPath!),
  });
  await expect(page.getByRole('status').filter({ hasText: /^Imported into revision / })).toBeVisible({ timeout: 60_000 });
  await expectRecipeRepresentation(page, editedSteps);
});

test('the API’s named 4,096-occurrence export refusal is shown to the cook', async ({ page }) => {
  test.setTimeout(300_000);
  const actingSubject = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject;
  await signIn(page, actingSubject);
  const recipe = await createRecipeWork(page, recipeName, actingSubject);
  await openRecipeEditor(page, recipe.work);

  // Use a typed API refusal fixture for the exact route the export adapter calls. This proves the
  // named response without writing 4,096 occurrences into a browser recipe.
  const revisions: string[] = [];
  await page.route(url => url.pathname === `/api/main/v1/recipes/${recipe.structure.slice(-36)}/exports/schema-org`,
    async route => {
      revisions.push(new URL(route.request().url()).searchParams.get('revision') ?? '');
      await route.fulfill({ status: 413, contentType: 'application/problem+json', body: JSON.stringify({
        type: 'https://rezics.com/problems/recipe_export_too_large', status: 413,
        code: 'recipe_export_too_large', title: 'Recipe export exceeds 4,096 occurrences',
      }) });
    });
  await page.getByRole('button', { name: 'Download Schema.org JSON' }).click();
  await expect(page.getByRole('alert')).toHaveText('Recipe export exceeds 4,096 occurrences');
  expect(revisions).toEqual([recipe.revision]);
});
