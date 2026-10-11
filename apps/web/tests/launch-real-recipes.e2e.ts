import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LaunchRecipesCorpus } from '../../../scripts/load/launch-corpus.ts';
import { localizedPath } from '../i18n/locale.ts';
import { realmWorkHref, siteHref } from '../features/realm/route.ts';
import { signInAtAccounts } from './account-sign-in.ts';

interface PreparedRecipes {
  corpus: LaunchRecipesCorpus;
  restored: false;
}

interface Reader {
  member: { email: string; password: string };
}

let corpus: LaunchRecipesCorpus;
let reader: Reader;

test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through isolated browser QA');
  const retained = join(process.cwd(), '.temp/launch-corpus', `browser-recipes-${runId}.json`);
  const prepared = JSON.parse(readFileSync(retained, 'utf8')) as PreparedRecipes;
  expect(prepared.corpus.recipe).toBe('launch-real-recipes-v1');
  expect(prepared.corpus.records).toHaveLength(30);
  expect(prepared.restored).toBe(false);
  corpus = prepared.corpus;
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!privatePath) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must identify the isolated QA reader');
  reader = JSON.parse(readFileSync(privatePath, 'utf8')) as Reader;
});

const browsePath = () => siteHref('en', 'launch-recipes', ['browse']);
const workPath = (work: string) => localizedPath(realmWorkHref('launch-recipes', work), 'en');
const recipeLinks = (page: import('@playwright/test').Page) =>
  page.locator('main h3 a[href*="/z/launch-recipes/w/"]');

test('recipes / Browse every recipe page in its Zone', async ({ page }) => {
  test.setTimeout(300_000);
  await signInAtAccounts(page, browsePath(), reader.member);

  const titles = corpus.records.map(record => record.title).sort();
  const firstSearch = page.getByRole('searchbox', { name: 'Search Recipes' });
  await expect(firstSearch).toBeVisible();
  const browsePages = async () => {
    const visibleTitles: string[] = [];
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      await expect(recipeLinks(page).first()).toBeVisible({ timeout: 60_000 });
      const pageTitles = (await recipeLinks(page).allTextContents()).map(title => title.trim());
      visibleTitles.push(...pageTitles);
      const next = page.getByRole('link', { name: 'Next', exact: true });
      if (await next.count() === 0) break;
      const href = await next.getAttribute('href');
      if (!href) throw new Error('Zone browse Next link has no destination');
      const nextUrl = new URL(href, page.url()).href;
      await next.click();
      await expect(page).toHaveURL(nextUrl, { timeout: 60_000 });
      await expect(recipeLinks(page).first()).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => (await recipeLinks(page).first().textContent())?.trim())
        .not.toBe(pageTitles[0]);
    }
    return visibleTitles;
  };
  let browsedTitles: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    browsedTitles = await browsePages();
    if (new Set(browsedTitles).size === titles.length) break;
    if (attempt < 2) {
      await page.goto(browsePath());
      await page.waitForTimeout(2_000);
    }
  }
  expect(browsedTitles.sort()).toEqual(titles);
});

test('recipes / Search and open Puff Paste and Artusi in English UI', async ({ page }) => {
  test.setTimeout(300_000);
  await signInAtAccounts(page, browsePath(), reader.member);

  const puff = corpus.records.find(record => record.recipeId === 'puff-paste')!;
  const search = page.getByRole('searchbox', { name: 'Search Recipes' });
  await search.fill('Puff Paste');
  await search.press('Enter');
  const puffLink = page.getByRole('link', { name: puff.title, exact: true });
  await expect(puffLink).toBeVisible();
  const puffPath = new URL(workPath(puff.work), page.url()).pathname;
  await puffLink.click();
  await expect(page).toHaveURL(url => url.pathname.startsWith(puffPath), { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: puff.title, exact: true }))
    .toBeVisible({ timeout: 60_000 });
  const recipe = page.getByRole('region', { name: 'Recipe', exact: true });
  await expect(recipe).toBeVisible();
  await expect(recipe).toContainText('1 pound pastry flour');
  await expect(recipe).toContainText('Work two tablespoons of butter into flour');
  await expect(recipe).toContainText('dredging board slightly with flour when necessary');
  await expect(recipe).toContainText('one-half inch thick');
  await expect(recipe).toContainText('one-fourth inch thick');
  const method = recipe.getByRole('heading', { name: 'Method', exact: true }).locator('..');
  expect((await method.locator('ol > li > div > p:first-child').allTextContents()).map(line => line.trim()))
    .toEqual(puff.sourceMethods.map(line => line.trim()));

  const artusi = corpus.records.find(record => record.pinId === 'artusi')!;
  await page.goto(workPath(artusi.work));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: artusi.title, exact: true })).toBeVisible();
  const italianRecipe = page.getByRole('region', { name: 'Recipe', exact: true });
  await expect(italianRecipe).toContainText(artusi.sourceIngredients[0]!.trim());
  await expect(italianRecipe.getByText(artusi.sourceMethods[0]!.trim(), { exact: true })).toBeVisible();
});
