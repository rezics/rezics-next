import { expect, test } from '@playwright/test';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// Against the seeded demo: Jane Austen (Pride and Prejudice, rated, read by
// Daniel) and Arthur Conan Doyle (two unrated Sherlock Holmes Works).
const austen = '/en/authors/open-library/OL21594A';
const daniel = people.find(person => person.id === 'daniel')!;

test('an Open Library author page names the author, their years, totals, Works and record', async ({ page }) => {
  const response = await page.goto(austen);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Jane Austen' })).toBeVisible();
  await expect(page.getByText('1775–1817')).toBeVisible();
  const totals = page.getByLabel('On REZICS');
  await expect(totals.getByText('average rating')).toBeVisible();
  await expect(totals.getByText(/^readers?$/)).toBeVisible();
  const works = page.getByRole('region', { name: 'Works by Jane Austen' });
  await works.getByRole('link', { name: 'Pride and Prejudice' }).click();
  await expect(page).toHaveURL(/\/en\/w\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Details' }).getByText('December 16, 1775')).toBeVisible();
  await expect(page.getByRole('link', { name: /Wikidata/ })).toHaveAttribute('href', 'https://www.wikidata.org/wiki/Q36322');
  await expect(page.getByRole('link', { name: 'View the record' }))
    .toHaveAttribute('href', 'https://openlibrary.org/authors/OL21594A');
  const jsonLd = JSON.parse(await page.locator('script[type="application/ld+json"]').first().textContent() ?? '{}');
  expect(jsonLd.mainEntity).toMatchObject({ '@type': 'Person', name: 'Jane Austen', birthDate: '1775-12-16' });
  await expect(page).toHaveTitle(/Jane Austen/);
});

test('an author without ratings, in Chinese, and addresses that name no REZICS author', async ({ page }) => {
  await page.goto('/zh-Hans/authors/open-library/OL161167A');
  await expect(page.getByRole('heading', { level: 1, name: 'Arthur Conan Doyle' })).toBeVisible();
  await expect(page.getByText('1859年—1930年')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Arthur Conan Doyle的作品' }).getByRole('heading', { level: 3 }))
    .toHaveCount(2);
  await expect(page.getByLabel('在 REZICS').getByText('平均评分')).toHaveCount(0);
  for (const path of ['/en/authors/open-library/OL1A', '/en/authors/open-library/not-an-author']) {
    expect((await page.goto(path))?.status()).toBe(404);
  }
});

test('signed in as Daniel, a Work shelved from the author page stays on his shelf', async ({ page }) => {
  await signInAtAccounts(page, austen, daniel);
  // Shelf buttons act once the page has hydrated; the account menu marks when it has.
  const hydrated = () => expect(page.getByRole('button', { name: 'Account menu' }))
    .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await hydrated();
  const works = page.getByRole('region', { name: 'Works by Jane Austen' });
  const shelf = works.getByRole('button', { name: 'Want to read — Shelve “Pride and Prejudice”' });
  // The seed may already have shelved it; start from no shelf either way.
  const existing = works.getByRole('button', { name: /— Shelve “Pride and Prejudice”$/ });
  if (await existing.isVisible()) {
    await existing.click();
    await page.getByRole('menuitem', { name: 'Remove from my shelves' }).click();
  }
  await works.getByRole('button', { name: 'Want to read' }).first().click();
  await expect(shelf).toBeVisible();
  // Read back from Main: the page seeds each Work's shelf state for the signed-in reader.
  await page.reload();
  await hydrated();
  await expect(shelf).toBeVisible();
  await shelf.click();
  await page.getByRole('menuitem', { name: 'Remove from my shelves' }).click();
  await expect(works.getByRole('button', { name: 'Want to read' }).first()).toBeVisible();
});
