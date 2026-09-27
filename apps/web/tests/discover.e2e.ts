import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// A fresh QA stack has no active discovery generation, so every shelf must say
// so for its scope rather than show an empty or stale list.

test('discover names its scope on every shelf and states an unbuilt list honestly', async ({ page }) => {
  await page.goto('/discover');
  await expect(page.getByRole('heading', { level: 1, name: 'Discover works' })).toBeVisible();
  const scopes = page.getByRole('navigation', { name: 'Scope' });
  await expect(scopes.getByRole('link', { name: 'Global' })).toHaveAttribute('aria-current', 'page');
  for (const shelf of ['Recently updated', 'Books', 'Documents', 'Recipes']) {
    const region = page.getByRole('region', { name: `${shelf} · Global` });
    await expect(region).toBeVisible();
    await expect(region).toContainText(/Not built for Global yet|works?/);
  }

  await page.getByRole('navigation', { name: 'Work type' }).getByRole('link', { name: 'Recipes' }).click();
  await expect(page).toHaveURL(/\/discover\?type=recipe$/);
  await expect(page.getByRole('region', { name: 'Recipes · Global' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Books · Global' })).toHaveCount(0);

  await scopes.getByRole('link', { name: 'Mine' }).click();
  await expect(page).toHaveURL(/\/discover\?scope=mine&type=recipe$/);
  await expect(page.getByRole('heading', { name: 'Choose a rating question' })).toBeVisible();
});

test('Mine asks a signed-out reader to sign in; bad links and unknown Realms are named', async ({ page }) => {
  const context = randomUUID();
  await page.goto(`/discover?scope=mine&context=${context}`);
  await expect(page.getByRole('region', { name: 'Recently updated · Rated by you' }))
    .toContainText('Sign in to see works you rated');
  await expect(page.getByRole('link', { name: 'Sign in' }).first())
    .toHaveAttribute('href', `/sign-in?next=${encodeURIComponent(`/discover?scope=mine&context=${context}`)}`);

  await page.goto(`/discover?scope=realm&realm=${randomUUID()}`);
  await expect(page.getByRole('heading', { name: 'This Realm is not public or does not exist' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse Global' })).toHaveAttribute('href', '/discover');

  await page.goto('/discover?type=podcast');
  await expect(page.getByRole('heading', { name: 'This discover link is malformed' })).toBeVisible();
});

test('discover fits a phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/discover');
  await expect(page.getByRole('region', { name: 'Recently updated · Global' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});
