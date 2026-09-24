import { expect, test } from '@playwright/test';

test('public search reaches Main and declares an empty result at a source position', async ({ page }) => {
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search works' }).fill('river');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=river$/);
  await expect(page.getByRole('region', { name: 'Search results' }))
    .toContainText('No works matched this search.');
  await expect(page.getByRole('region', { name: 'Search results' }))
    .toContainText('Complete at sequence 0');
  await page.getByRole('radio', { name: 'English' }).check();
  await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
  await page.getByRole('combobox', { name: 'View results from a perspective' }).selectOption('realm');
  await expect(page.getByText('Enter a full Realm ID to search this perspective.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Search results' }))
    .not.toContainText('Enter at least two characters');
});

test('mobile search filters disclose without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/search?q=river');
  await page.getByText('Filter results').click();
  await expect(page.getByRole('radio', { name: 'Any language' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Japanese' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
