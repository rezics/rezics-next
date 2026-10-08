import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { recipeEditHref } from '../features/recipe-editor/route.ts';
import { studioHref } from '../features/studio/agent.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// A recipe longer than one reader window. The first view follows section headings until it is holding
// about a page of occurrences, then continues; a section that crosses that boundary stays one section.
// The editor loads the rest before it changes the structure.

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const sessionStudio = (path = '') => {
  const { actingSubject } = fixture<{ actingSubject: string }>('REZICS_WEB_AUTH_PUBLIC_PATH');
  return `/en${studioHref({ iri: actingSubject, handle: null }, path)}`;
};

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await overflows(page), `${name} ${label}`).toBe(false);
    const path = info.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`[recipe-long] ${label} ${viewport.width}px ${path}`);
  }
  await page.setViewportSize(desktop);
}

const idOf = (iri: string) => iri.slice(-36);
const settled = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 60_000 });

test.use({ actionTimeout: 15_000 });

test('a long recipe shows its first part, continues with its sections whole, and edits without dropping the rest', async ({ page }, info) => {
  test.setTimeout(600_000);
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  const { actingSubject } = fixture<{ actingSubject: string }>('REZICS_WEB_AUTH_PUBLIC_PATH');
  await signInAtAccounts(page, sessionStudio(), member);

  const posted = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/main${path}`, {
      headers: { 'idempotency-key': crypto.randomUUID() }, data,
    });
    const body = await response.text();
    expect(response.ok(), `${path} ${response.status()} ${body}`).toBe(true);
    return JSON.parse(body) as Record<string, unknown>;
  };
  const created = await posted('/v1/works', {
    profile: 'metadata-only-v1', title: `Long stew ${crypto.randomUUID().slice(0, 8)}`, language: 'en',
    semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject,
  });
  const work = String(created.work);
  const composed = await posted('/v1/compositions', {
    profile: 'recipe-composition', work, mainVersion: created.mainVersion, actingSubject,
  });
  const structure = String(composed.structure);
  let revision = String(composed.revision);
  const write = async (operations: object[]) => {
    const occurrences: string[] = [];
    for (let index = 0; index < operations.length; index += 16) {
      const result = await posted(`/v1/compositions/${idOf(structure)}/changes`, {
        profile: 'recipe-composition', expectedHead: revision, actingSubject,
        operations: operations.slice(index, index + 16),
      });
      revision = String(result.revision);
      occurrences.push(...(result.occurrences as string[]));
    }
    return occurrences;
  };
  const ingredient = (text: string, parent: string) => ({
    op: 'insert', parent, position: 'last', role: 'ingredient',
    qualifier: { type: 'ingredient-line', originalText: { value: text, language: 'en' }, amountLexical: '1',
      amount: { numerator: 1, denominator: 1 }, unitText: 'cup', optional: false, scaling: 'linear',
      substituteFor: [], parseStatus: 'parsed' },
  });
  const step = (text: string) => ({
    op: 'insert', parent: structure, position: 'last', role: 'step',
    qualifier: { type: 'recipe-step', instructionText: { value: text, language: 'en' }, usesIngredient: [],
      media: [], scaling: 'linear' },
  });
  const [dough] = await write([{ op: 'insert', parent: structure, position: 'last', role: 'group',
    label: { value: 'Dough', language: 'en' } }]);
  await write(Array.from({ length: 40 }, (_, index) => ingredient(`1 cup dough-${String(index + 1).padStart(2, '0')}`, dough!)));
  const [sauce] = await write([{ op: 'insert', parent: structure, position: 'last', role: 'group',
    label: { value: 'Sauce', language: 'en' } }]);
  await write(Array.from({ length: 40 }, (_, index) => ingredient(`1 cup sauce-${String(index + 1).padStart(2, '0')}`, sauce!)));
  await write(Array.from({ length: 40 }, (_, index) => step(`Step ${index + 1}`)));
  await posted(`/v1/recipes/${idOf(structure)}/measures`, {
    expectedHead: revision, actingSubject,
    yield: { value: { numerator: 4, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
    servings: { value: { numerator: 4, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
    nutrition: { basis: 'whole-recipe', inputs: [] },
  });

  const workPath = localizedPath(resourceHref('/w/', idOf(work)), 'en');
  const editorPath = localizedPath(recipeEditHref(idOf(work)), 'en');
  const recipeOf = () => page.getByRole('region', { name: 'Recipe', exact: true });
  // An own-work is not on the Work page until its notes are published. Publish them once the
  // editor has the whole recipe, which is what makes this page readable.
  await page.setViewportSize(desktop);
  await page.goto(editorPath);
  await expect(page.getByRole('group', { name: 'Section Sauce' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Notes' }).fill('Make it the day before.');
  await page.getByRole('textbox', { name: 'Notes' }).blur();
  await settled(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published. Everyone can read this recipe.')).toBeVisible();
  const open = async (width: number) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(async () => {
      await page.goto(workPath);
      await expect(recipeOf().getByRole('heading', { name: 'Dough', exact: true })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
  };
  const more = () => recipeOf().getByRole('button', { name: 'Show more of this recipe' });
  // The button's name changes while the next part loads, and busy is set after the click.
  // Wait until the recipe text has changed and that load has finished, or a fast click
  // looks done and the walk stops on the first part.
  const continueOnce = async () => {
    const region = recipeOf();
    const before = await region.innerText();
    await more().click();
    await expect.poll(async () => {
      const text = await region.innerText();
      const loading = await region.getByRole('button', { name: 'Loading more…' }).count();
      const busy = await page.locator('[aria-busy="true"]').count();
      return text !== before && loading === 0 && busy === 0;
    }, { timeout: 30_000 }).toBe(true);
  };
  const continueAll = async () => {
    for (let guard = 0; guard < 8; guard += 1) {
      if (await more().count() === 0) return;
      await continueOnce();
    }
    expect(await more().count(), 'the recipe still had a continuation').toBe(0);
  };

  await open(1280);
  const opened = recipeOf();
  await expect(opened.getByText('1 cup dough-01')).toBeVisible();
  await expect(opened.getByText('1 cup dough-40')).toBeVisible();
  await expect(opened.getByText('1 cup sauce-01')).toBeVisible();
  await expect(opened.getByText('1 cup sauce-40')).toBeVisible();
  await expect(opened.getByRole('heading', { name: 'Dough', exact: true })).toHaveCount(1);
  await expect(opened.getByRole('heading', { name: 'Sauce', exact: true })).toHaveCount(1);
  // One filled page holds both sections and the first steps; the recipe continues past it.
  await expect(opened).not.toContainText('Step 40');
  await expect(more()).toBeVisible();
  await shoot(page, 'recipe-long-first', info);
  await continueAll();
  const recipe = recipeOf();
  await expect(recipe.getByRole('heading', { name: 'Dough', exact: true })).toHaveCount(1);
  await expect(recipe.getByRole('heading', { name: 'Sauce', exact: true })).toHaveCount(1);
  await expect(recipe.getByText('1 cup dough-01')).toBeVisible();
  await expect(recipe.getByText('1 cup dough-40')).toBeVisible();
  await expect(recipe.getByText('1 cup sauce-01')).toBeVisible();
  await expect(recipe.getByText('1 cup sauce-40')).toBeVisible();
  const method = recipe.getByRole('heading', { name: 'Method', exact: true }).locator('xpath=..');
  await expect(method.getByRole('listitem')).toHaveCount(40);
  await expect(method.getByRole('listitem').first()).toContainText('Step 1');
  await expect(method.getByRole('listitem').nth(39)).toContainText('Step 40');
  await expect(method.getByRole('listitem').nth(39).locator('span').first()).toHaveText('40');
  await shoot(page, 'recipe-long-continued', info);

  await recipe.getByRole('spinbutton', { name: 'Servings' }).fill('8');
  await recipe.getByRole('button', { name: 'Scale', exact: true }).click();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(recipe.getByRole('heading', { name: 'Dough', exact: true })).toHaveCount(1);
  await expect(recipe.getByRole('heading', { name: 'Sauce', exact: true })).toHaveCount(1);
  const doughLines = recipe.getByRole('heading', { name: 'Dough', exact: true }).locator('xpath=following-sibling::ul[1]').getByRole('listitem');
  const sauceLines = recipe.getByRole('heading', { name: 'Sauce', exact: true }).locator('xpath=following-sibling::ul[1]').getByRole('listitem');
  // Scaling replaces the window. The written amount stays beside the scaled line, so the proof is
  // one line per ingredient, at the new count, with the method still unread.
  await expect(doughLines).toHaveCount(40);
  await expect(sauceLines).toHaveCount(40);
  await expect(doughLines.first()).toContainText('2 cups dough-01');
  await expect(sauceLines.last()).toContainText('2 cups sauce-40');
  await expect(recipe).not.toContainText('Step 40');
  await expect(more()).toBeVisible();
  await shoot(page, 'recipe-long-scaled', info);
  await continueOnce();
  await expect(doughLines).toHaveCount(40);
  await expect(doughLines.first()).toContainText('2 cups dough-01');
  await expect(recipe.getByRole('heading', { name: 'Dough', exact: true })).toHaveCount(1);
  await expect(recipe.getByRole('heading', { name: 'Sauce', exact: true })).toHaveCount(1);
  await expect(method.getByRole('listitem')).toHaveCount(40);
  await expect(method.getByRole('listitem').nth(39)).toContainText('Step 40');
  await expect(more()).toHaveCount(0);

  await open(390);
  await expect(recipeOf().getByText('1 cup dough-01')).toBeVisible();
  await expect(recipeOf()).not.toContainText('Step 1');
  await expect(more()).toBeVisible();
  await continueAll();
  await expect(recipeOf().getByRole('heading', { name: 'Dough', exact: true })).toHaveCount(1);
  await expect(recipeOf().getByRole('heading', { name: 'Sauce', exact: true })).toHaveCount(1);
  await expect(recipeOf().getByText('1 cup sauce-40')).toBeVisible();
  await expect(recipeOf().getByRole('heading', { name: 'Method', exact: true }).locator('xpath=..').getByRole('listitem')).toHaveCount(40);
  await shoot(page, 'recipe-long-phone', info);

  await page.setViewportSize(desktop);
  await page.goto(editorPath);
  const line = (text: string) => page.locator('[data-line]').filter({ hasText: text });
  await expect(page.getByRole('group', { name: 'Section Sauce' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(line('1 cup dough-40')).toBeVisible();
  await expect(line('1 cup sauce-40')).toBeVisible();
  await expect(page.locator('[data-step]')).toHaveCount(40);
  await settled(page);
  const sauceGroup = page.getByRole('group', { name: 'Section Sauce' });
  await sauceGroup.getByRole('textbox', { name: 'Section name' }).fill('Gravy');
  await sauceGroup.getByRole('textbox', { name: 'Section name' }).blur();
  await settled(page);
  await page.reload();
  await expect(page.getByRole('group', { name: 'Section Gravy' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(line('1 cup dough-01')).toBeVisible();
  await expect(line('1 cup dough-40')).toBeVisible();
  await expect(line('1 cup sauce-01')).toBeVisible();
  await expect(line('1 cup sauce-40')).toBeVisible();
  await expect(page.locator('[data-step]')).toHaveCount(40);
  await expect(page.locator('[data-step]').filter({ hasText: 'Step 40' })).toBeVisible();
  await shoot(page, 'recipe-long-editor', info);
});
