import { expect, type Page } from '@playwright/test';

/** Complete the browser redirect on the public Accounts origin. */
export async function signInAtAccounts(
  page: Page,
  next: string,
  member: { email: string; password: string },
): Promise<void> {
  // Dispose an auth/start document reached by an expired-session navigation
  // before its mount effect can compete with this sign-in.
  await page.goto('about:blank');
  await page.goto(`/auth/start?next=${encodeURIComponent(next)}`, { waitUntil: 'commit' });
  const accountOrigin = new URL(process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004').origin;
  const accounts = new URL(accountOrigin);
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  await page.waitForURL(
    (url) =>
      url.pathname === next ||
      url.pathname.endsWith('/identity/failed') ||
      (url.pathname === '/sign-in' &&
        (url.origin === accountOrigin ||
          (loopback.has(url.hostname) &&
            loopback.has(accounts.hostname) &&
            url.protocol === accounts.protocol &&
            url.port === accounts.port))),
  );
  if (new URL(page.url()).pathname.endsWith('/identity/failed'))
    throw new Error('Account sign-in failed');
  if (new URL(page.url()).pathname === next) return;
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  await email.fill('');
  // Native key events keep the controlled form's value aligned during the
  // Accounts app's first hydration, as typing in its component stories does.
  await email.pressSequentially(member.email);
  await expect(email).toHaveValue(member.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill(member.password);
  await page.getByRole('button', { name: 'Next' }).click();
  // Synthetic demo accounts may predate the current local policy revisions.
  const accept = page.getByRole('button', { name: 'Accept and continue', exact: true });
  await Promise.race([
    page.waitForURL(next, { timeout: 60_000 }),
    accept.waitFor({ state: 'visible', timeout: 60_000 }),
  ]);
  if (await accept.isVisible()) {
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await accept.click();
  }
  // OAuth crosses Accounts and the Worker; use the same loaded-host allowance as hydration.
  await expect(page).toHaveURL(next, { timeout: 60_000 });
}
