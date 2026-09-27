import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// Home in a real browser against a fresh QA stack. The stack's feed may be
// empty or full, so these check the frame and the rules that hold either way:
// the sort is always in view, filters live in the URL and survive the simple
// choices, an empty filtered view names its cause without widening itself,
// and a new person meets the interest picker instead of an empty Following.

function member(): { email: string; password: string } {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

const posts = (page: Page) => page.getByRole('region', { name: 'Posts' });

test('signed out, Home is All · Best with the sort in view and filters kept in the URL', async ({ page }) => {
  await page.goto('/en');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeAttached();
  await expect(page.getByRole('navigation', { name: 'Feed' })).toHaveCount(0);
  const sort = posts(page).getByRole('navigation', { name: 'Sort' });
  await expect(sort.getByRole('link', { name: 'Best' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Join REZICS' })).toHaveAttribute('href', /\/auth\/start\?next=%2Fen&create=1$/);

  await sort.getByRole('link', { name: 'Top' }).click();
  await expect(page).toHaveURL(/\/en\?sort=top$/);
  const period = posts(page).getByRole('navigation', { name: 'Period' });
  await expect(period.getByRole('link', { name: 'This week' })).toHaveAttribute('aria-current', 'page');

  // A filter is part of the address; changing the sort keeps it.
  await page.goto('/en?sort=top&t=month&lang=ja');
  await expect(posts(page).getByRole('button', { name: /1 filter on/ })).toBeVisible();
  await expect(posts(page).getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'New' }))
    .toHaveAttribute('href', '/en?sort=new&lang=ja');
  const empty = posts(page).getByRole('heading', { name: 'No posts match these filters' });
  if (await empty.isVisible()) {
    await expect(posts(page).getByText('Nothing in Japanese here yet.')).toBeVisible();
    await posts(page).getByRole('link', { name: 'Include every language' }).click();
    await expect(page).toHaveURL(/\/en\?sort=top&t=month$/);
  }
});

test('the Filters sheet loads the same view with the chosen languages', async ({ page }) => {
  await page.goto('/en?sort=new');
  const sheet = page.getByRole('dialog', { name: 'Filter your feed' });
  // A press that lands before hydration does nothing, so press until the sheet opens.
  await expect(async () => {
    if (await sheet.isVisible()) return;
    await posts(page).getByRole('button', { name: 'Filters' }).click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await sheet.getByRole('checkbox', { name: 'Korean' }).check();
  await sheet.getByRole('button', { name: 'Show posts' }).click();
  await expect(page).toHaveURL(/\/en\?sort=new&lang=ko$/);
});

test('Home fits a phone, with Notifications in the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/zh-Hans');
  const bar = page.getByRole('navigation', { name: '主导航' });
  await expect(bar.getByRole('link', { name: '通知' })).toHaveAttribute('href', '/zh-Hans/notifications');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('signed out, notifications ask for sign-in and return there', async ({ page }) => {
  await page.goto('/en/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to see your notifications' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' }).last())
    .toHaveAttribute('href', '/auth/start?next=%2Fen%2Fnotifications');
});

test('a new person meets the interest picker, can skip it, and finds it waiting as a card', async ({ page }) => {
  await signInAtAccounts(page, '/en', member());
  const picker = page.getByRole('region', { name: 'What do you come to REZICS for?' });
  if (await picker.isVisible()) {
    const books = picker.getByRole('button', { name: 'Books & web novels' });
    await expect(async () => {
      if (await books.getAttribute('aria-pressed') !== 'true') await books.click();
      await expect(books).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
    }).toPass();
    await picker.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('region', { name: 'Which languages do you read?' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('region', { name: 'Make Home yours' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Make Home yours' })).toBeVisible();
  }
  // Following or All is one tap away either way.
  await expect(posts(page).getByRole('navigation', { name: 'Feed' }).getByRole('link', { name: 'All' })).toBeVisible();

  await page.goto('/en/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: /^Notifications/ }))
    .toHaveAttribute('aria-current', 'page');
});
