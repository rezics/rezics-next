import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// Discover is the search surface. A fresh QA stack has no published Works, so
// these journeys prove the address, the phrase in the header, and the honest
// empty and refusal states.

const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Search everything' });

test('search keeps the phrase and a language filter, and an empty phrase search says so', async ({ page }) => {
  await page.goto('/en/discover');
  await expect(searchbox(page)).toHaveValue('');
  await expect(async () => {
    await page.goto('/en/discover');
    await searchbox(page).fill('river');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/discover\?q=river$/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(searchbox(page)).toHaveValue('river');
  // An empty catalogue says so; a catalogue that did not answer says that instead of inventing matches.
  await expect(page.locator('main')).toContainText(/No matches\.|Couldn’t load this list\./);
  await expect(page.getByRole('link', { name: /^English\b/ })).toHaveCount(0);

  await page.goto('/en/discover?q=river&lang=en');
  const kept = new URL(page.url()).searchParams;
  expect(kept.get('q')).toBe('river');
  expect(kept.get('lang')).toBe('en');
  await page.reload();
  await expect(searchbox(page)).toHaveValue('river');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('en');
});

test('a retired search address opens Discover with the phrase kept', async ({ page }) => {
  await page.goto('/en/search?q=river');
  await expect(page).toHaveURL(/\/en\/discover\?q=river$/);
  await expect(searchbox(page)).toHaveValue('river');
});

test('a community scope stays on that community, and Mine or a bad language is not a search', async ({ page }) => {
  const realm = randomUUID();
  await page.goto(`/en/discover?q=river&scope=realm&realm=${realm}`);
  const scoped = new URL(page.url()).searchParams;
  expect(scoped.get('q')).toBe('river');
  expect(scoped.get('scope')).toBe('realm');
  expect(scoped.get('realm')).toBe(realm);
  // Chapter text and the resource list each report a community the catalogue cannot load.
  await expect(page.locator('main').getByRole('alert').filter({ hasText: 'Couldn’t load this list.' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true }).first()).toBeVisible();

  await page.goto('/en/discover?q=river&scope=mine');
  await expect(page.locator('main').getByRole('alert')).toHaveText('This link doesn’t lead anywhere');
  await expect(page.getByRole('link', { name: 'Browse everything', exact: true })).toHaveAttribute('href', '/en/discover');

  await page.goto('/en/discover?q=river&lang=not a tag');
  await expect(page.locator('main').getByRole('alert')).toHaveText('This link doesn’t lead anywhere');
});

test('Enter that commits an IME composition does not submit', async ({ page }) => {
  await page.goto('/en/discover?q=river');
  const box = searchbox(page);
  await expect(box).toHaveValue('river');
  await expect(async () => {
    const prevented = await box.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const committing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true,
        isComposing: true });
      input.dispatchEvent(committing);
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return committing.defaultPrevented;
    });
    expect(prevented).toBe(true);
  }).toPass();
  await expect(page).toHaveURL(/\/en\/discover\?q=river$/);
});

test('a phone-width search with a language filter does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/discover?q=river&lang=ja');
  await expect(searchbox(page)).toHaveValue('river');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('ja');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
