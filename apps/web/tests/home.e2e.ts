import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// Home in a real browser against a fresh QA stack. The stack's feed may be
// empty or full, so these check the frame and the rules that hold either way:
// the sort is always in view, filters live in the URL and survive the simple
// choices, an empty filtered view names its cause without widening itself,
// a new person is invited to set up Home instead of meeting an empty Following,
// saved views stay closed until granted, and then Home's current Filters
// become a pinned tab that can be taken off again.

function member(): { email: string; password: string } {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

const posts = (page: Page) => page.getByRole('region', { name: 'Posts' });

test('signed out, Home is All · Best with the sort menu in view and filters kept in the URL', async ({ page }) => {
  await page.goto('/en');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeAttached();
  await expect(page.getByRole('navigation', { name: 'Feed' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Join REZICS' })).toHaveAttribute('href', /\/auth\/start\?next=%2Fen&create=1$/);

  // One control line: the sort is a menu, as Reddit's `Best ▾`. A press before hydration does nothing.
  const top = page.getByRole('menuitemradio', { name: /^Top/ });
  await expect(async () => {
    if (await top.isVisible()) return;
    await posts(page).getByRole('button', { name: 'Sort: Best' }).click();
    await expect(top).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await top.click();
  await expect(page).toHaveURL(/\/en\?sort=top$/);
  await expect(posts(page).getByRole('button', { name: 'Period: This week' })).toBeVisible();

  // A filter is part of the address, shown as a chip that removes only itself; the sort keeps it.
  await page.goto('/en?sort=top&t=month&lang=ja');
  await expect(posts(page).getByRole('button', { name: /1 filter on/ })).toBeVisible();
  await expect(posts(page).getByRole('link', { name: 'Remove filter: Japanese' })).toHaveAttribute('href', '/en?sort=top&t=month');
  const empty = posts(page).getByRole('heading', { name: 'No posts match these filters' });
  if (await empty.isVisible()) {
    await expect(posts(page).getByText('Nothing in Japanese here yet.')).toBeVisible();
    await posts(page).getByRole('link', { name: 'Include every language' }).click();
    await expect(page).toHaveURL(/\/en\?sort=top&t=month$/);
  }
});

test('the Filters popover loads the same view with the chosen languages', async ({ page }) => {
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

test('G-431: a new person is invited to set up Home, can put it off, and pins the current filters as a tab', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAtAccounts(page, '/en', member());
  const invite = page.getByRole('region', { name: 'Make Home yours' });
  if (await invite.getByRole('button', { name: 'Not now' }).isVisible()) {
    await expect(invite.getByRole('link', { name: 'Choose topics' })).toHaveAttribute('href', '/en/welcome?next=%2Fen');
    await expect(async () => {
      if (await invite.getByRole('button', { name: 'Not now' }).isVisible()) {
        await invite.getByRole('button', { name: 'Not now' }).click();
      }
      await expect(invite).toContainText('Pin topics as tabs', { timeout: 1_000 });
    }).toPass();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Make Home yours' })).toContainText('Pin topics as tabs');
  }
  // Without saved views, Home is Following and All. The pin control and tab menus stay absent,
  // and a closed read does not become an error.
  const tabs = posts(page).getByRole('navigation', { name: 'Feed' });
  await expect(tabs.getByRole('link', { name: 'Following' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'All' })).toBeVisible();
  await expect(tabs.getByRole('button', { name: /^Pin a topic/ })).toHaveCount(0);
  await expect(tabs.getByRole('button', { name: /^Options for / })).toHaveCount(0);
  await expect(posts(page).getByText('Couldn’t change your tabs')).toHaveCount(0);
  await expect(posts(page).getByText('Couldn’t pin')).toHaveCount(0);
  await expect(posts(page).getByText('platform_closed')).toHaveCount(0);

  // An address kept for a pinned tab says the tab is gone and offers All.
  await page.goto(`/en?tab=${randomUUID()}`);
  await expect(posts(page).getByRole('heading', { name: 'This tab isn’t on your Home any more' })).toBeVisible();
  await expect(posts(page).getByRole('link', { name: 'Browse All' })).toBeVisible();

  const administrator = await platformAdministratorSession();
  await grantPlatformUse(administrator, administrator.principalId, 'saved-views');

  // The Filters Home shows now become a named tab after Following and All, with its own address.
  await page.goto('/en?tab=all&lang=ja');
  const pin = tabs.getByRole('button', { name: /^Pin a topic/ });
  const dialog = page.getByRole('dialog', { name: 'Pin to Home' });
  await expect(async () => {
    if (!await dialog.isVisible()) await pin.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const form = dialog.getByRole('form', { name: 'Save these filters as a tab' });
  const name = `Japanese ${Date.now().toString(36)}`;
  await form.getByRole('textbox', { name: 'Name' }).fill(name);
  await form.getByRole('button', { name: 'Save as tab' }).click();
  const tab = tabs.getByRole('link', { name });
  await expect(tab).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(page).toHaveURL(/\/en\?tab=[0-9a-f-]{36}/);
  // A pinned tab is its own filter: the sort stays, the Filters button does not.
  await expect(posts(page).getByRole('button', { name: /^Sort:/ })).toBeVisible();
  await expect(posts(page).getByRole('button', { name: /^Filters/ })).toHaveCount(0);

  await tabs.getByRole('button', { name: `Options for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Remove from Home' }).click();
  await expect(tabs.getByRole('link', { name })).toHaveCount(0, { timeout: 30_000 });
  await expect(tabs.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');

  await page.goto('/en/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: /^Notifications/ }))
    .toHaveAttribute('aria-current', 'page');
});
