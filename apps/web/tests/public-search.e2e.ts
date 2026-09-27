import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// A fresh QA stack has no published Works, so these journeys prove the URL
// state, the scope beside the query box and the honest empty states.

const form = (page: Page) => page.getByRole('search', { name: 'Search published works' });
const results = (page: Page) => page.getByRole('region', { name: 'Search results' });

test('search keeps phrase, scope and filters in the URL and states what it searched', async ({ page }) => {
  await page.goto('/search');
  await expect(results(page)).toContainText('Enter at least two characters to search.');
  await expect(form(page).getByRole('combobox', { name: 'Search in' })).toHaveValue('global');
  await form(page).getByRole('searchbox', { name: 'Search phrase' }).fill('  river  ');
  await form(page).getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=river$/);
  await expect(page.getByText('Results for “river” in Global')).toBeVisible();
  await expect(results(page)).toContainText('No works in Global match “river”');
  const completeness = page.getByTestId('search-completeness');
  await expect(completeness).toContainText(/Exactly 0 works match · searched [0-9]+ published texts? in Global/);
  await expect(completeness).toContainText(/index current as of change [0-9]+/);

  await page.getByRole('link', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=river&lang=en$/);
  await expect(completeness).toContainText('only English text');
  await expect(results(page).getByRole('link', { name: 'Search any language' }))
    .toHaveAttribute('href', '/search?q=river');
  await page.reload();
  await expect(form(page).getByRole('searchbox', { name: 'Search phrase' })).toHaveValue('river');
  await expect(page.getByRole('link', { name: 'English', exact: true })).toHaveAttribute('aria-current', 'true');
});

test('a Realm scope is named and never falls back to Global; Mine is not searchable', async ({ page }) => {
  const realm = randomUUID();
  await page.goto(`/search?q=river&scope=realm&realm=${realm}`);
  await expect(form(page).getByRole('combobox', { name: 'Search in' })).toHaveValue('realm');
  await expect(results(page)).toContainText('This Realm is not public or does not exist');
  await expect(results(page).getByRole('link', { name: 'Search Global' })).toHaveAttribute('href', '/search?q=river');

  await page.goto('/search?q=river&scope=mine');
  await expect(page.getByRole('heading', { name: 'Your ratings cannot be searched' })).toBeVisible();
  await page.goto('/search?q=river&lang=not a tag');
  await expect(page.getByRole('heading', { name: 'This search link is malformed' })).toBeVisible();
});

test('Enter that commits an IME composition does not submit', async ({ page }) => {
  await page.goto('/search?q=river');
  const box = form(page).getByRole('searchbox', { name: 'Search phrase' });
  await expect(box).toHaveValue('river');
  // Wait for hydration: the form navigates client-side only once React owns it.
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
  await expect(page).toHaveURL(/\/search\?q=river$/);
});

test('mobile search filters disclose without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search?q=river');
  await page.getByText('Filter results').click();
  await expect(page.getByRole('link', { name: 'Any language' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('link', { name: 'Japanese' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
