import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// A fresh QA stack has no published Works, so these journeys prove the URL
// state, the scope beside the query box and the honest empty states.

const form = (page: Page) => page.getByRole('search', { name: 'Search published works' });
const results = (page: Page) => page.getByRole('region', { name: 'Search results' });

test('search keeps phrase, scope and filters in the URL, and an empty search offers ways out', async ({ page }) => {
  await page.goto('/en/search');
  await expect(results(page)).toContainText('Enter at least two characters to search.');
  await expect(form(page).getByRole('combobox', { name: 'Search in' })).toHaveValue('global');
  // Once React owns the form it normalizes the phrase; a press before hydration submits natively, so try again.
  await expect(async () => {
    await page.goto('/en/search');
    await form(page).getByRole('combobox', { name: 'Search phrase' }).fill('  river  ');
    await form(page).getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/search\?q=river$/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText('Results for “river”', { exact: true })).toBeVisible();
  await expect(results(page)).toContainText('Nothing matches “river”');
  await expect(results(page)).toContainText('Try another spelling or fewer words, or search for a title or an author.');
  // No wall of zeros: with nothing found, no language or kind is offered as a filter.
  await expect(page.getByRole('link', { name: /^English\b/ })).toHaveCount(0);
  await expect(page.getByTestId('search-completeness')).toHaveCount(0);

  // A filter the address applies stays visible so it can be removed.
  await page.goto('/en/search?q=river&lang=en');
  await expect(page.getByRole('link', { name: /^English\b/ }).first()).toHaveAttribute('aria-current', 'true');
  await expect(results(page).getByRole('link', { name: 'Search any language' }))
    .toHaveAttribute('href', '/en/search?q=river');
  await page.reload();
  await expect(form(page).getByRole('combobox', { name: 'Search phrase' })).toHaveValue('river');
});

test('a community scope is named and never falls back to everyone; Mine is not searchable', async ({ page }) => {
  const realm = randomUUID();
  await page.goto(`/en/search?q=river&scope=realm&realm=${realm}`);
  await expect(form(page).getByRole('combobox', { name: 'Search in' })).toHaveValue('realm');
  await expect(results(page)).toContainText('This community isn’t public or doesn’t exist');
  await expect(results(page).getByRole('link', { name: 'Search all of REZICS' })).toHaveAttribute('href', '/en/search?q=river');

  await page.goto('/en/search?q=river&scope=mine');
  await expect(page.getByRole('heading', { name: 'Your ratings cannot be searched' })).toBeVisible();
  await page.goto('/en/search?q=river&lang=not a tag');
  await expect(page.getByRole('heading', { name: 'This search link is malformed' })).toBeVisible();
});

test('Enter that commits an IME composition does not submit', async ({ page }) => {
  await page.goto('/en/search?q=river');
  const box = form(page).getByRole('combobox', { name: 'Search phrase' });
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
  await expect(page).toHaveURL(/\/en\/search\?q=river$/);
});

test('mobile search filters disclose without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/search?q=river&lang=ja');
  await page.getByText('Filter results').click();
  await expect(page.getByRole('link', { name: 'Japanese' }).last()).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('link', { name: 'Any language' }).last()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
