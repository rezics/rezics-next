import { expect, type Page } from '@playwright/test';

/** Complete the browser redirect on the public Accounts origin. */
export async function signInAtAccounts(page: Page, next: string,
  member: { email: string; password: string }): Promise<void> {
  await page.goto(`/auth/start?next=${encodeURIComponent(next)}`);
  const accountOrigin = new URL(process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004').origin;
  await page.waitForURL(url => url.origin === accountOrigin && url.pathname === '/sign-in');
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill(member.password);
  await page.getByRole('button', { name: 'Next' }).click();
  // OAuth crosses Accounts and the Worker; use the same loaded-host allowance as hydration.
  await expect(page).toHaveURL(next, { timeout: 60_000 });
}
