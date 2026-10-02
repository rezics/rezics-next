import { describe, test } from 'bun:test';
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signInAtAccounts } from './account-sign-in.ts';

// Opt in against the shared backend with one worktree web server; no isolated stack or seed writes.
const reviewUrl = process.env.REZICS_WEB_REVIEW_URL;
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
describe.skipIf(!reviewUrl || !authPath)('G-941 account menu against the shared stack', () => {
  test('desktop submenus and phone panels keep destinations, selection, back focus and close focus', async () => {
    const browser = await chromium.launch({ headless: true });
    const loginUrl = process.env.REZICS_WEB_REVIEW_LOGIN_URL ?? reviewUrl!;
    const context = await browser.newContext({
      baseURL: loginUrl,
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();
    try {
      const { member } = JSON.parse(readFileSync(authPath!, 'utf8')) as {
        member: { email: string; password: string };
      };
      // Loopback cookies are shared across ports. Sign in on the registered shared frontend, then
      // inspect this worktree's UI with that real session and the same backend.
      await page.goto(loginUrl);
      await signInAtAccounts(page, `${loginUrl}/en`, member);
      await page.goto(`${reviewUrl}/en`);
      const trigger = page.getByRole('button', { name: 'Account menu', exact: true });
      await expect(trigger).toHaveAttribute('data-hydrated', 'true', { timeout: 60_000 });
      await trigger.click();
      await expect(page.getByRole('menuitem', { name: 'Library', exact: true })).toHaveAttribute(
        'href',
        '/en/library',
      );
      await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      await trigger.click();
      await page.screenshot({ path: '.temp/g941-account-desktop.png' });
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 844 });
      await trigger.click();
      let dialog = page.getByRole('dialog', { name: 'Account menu', exact: true });
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await page.screenshot({ path: '.temp/g941-account-phone.png' });
      await dialog.getByRole('button', { name: 'Language', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Language', exact: true });
      await expect(dialog.getByRole('radio')).toHaveCount(8);
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
      await page.screenshot({ path: '.temp/g941-account-language.png' });
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Account menu', exact: true });
      await expect(dialog.getByRole('button', { name: 'Language', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
      await expect(dialog.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
        await dialog.getByText('Light', { exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/light/);
      await page.screenshot({ path: '.temp/g941-account-appearance.png' });
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Account menu', exact: true });
      await expect(
        dialog.getByRole('link', { name: 'Content preferences', exact: true }),
      ).toHaveAttribute('href', '/en/settings#reading');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(trigger).toBeFocused();
      await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
    } catch (error) {
      await page.screenshot({ path: '.temp/g941-menu-failure.png' });
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  }, 180_000);
});
