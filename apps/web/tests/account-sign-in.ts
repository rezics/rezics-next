import { expect, type Page } from '@playwright/test';
import { i18n, matchUiLocaleTag } from '../../accounts/i18n/locale.ts';

/** Complete the browser redirect on the public Accounts origin. */
export async function signInAtAccounts(
  page: Page,
  next: string,
  member: { email: string; password: string },
  onboard = false,
): Promise<void> {
  const target = next.split(/[?#]/)[0] ?? next;
  // A canonical Work address keeps the id and appends -{title}. That is the same destination.
  const finished = (url: URL) =>
    url.pathname === target || url.pathname.startsWith(`${target}-`)
    || (onboard && url.pathname === '/en/onboarding');
  // Dispose an auth/start document reached by an expired-session navigation
  // before its mount effect can compete with this sign-in.
  await page.goto('about:blank');
  await page.goto(`/auth/start?next=${encodeURIComponent(next)}`, { waitUntil: 'commit' });
  const accountOrigin = new URL(process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004').origin;
  const accounts = new URL(accountOrigin);
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  await page.waitForURL(
    (url) =>
      finished(url) ||
      url.pathname.endsWith('/identity/failed') ||
      (url.pathname === '/sign-in' &&
        (url.origin === accountOrigin ||
          (loopback.has(url.hostname) &&
            loopback.has(accounts.hostname) &&
            url.protocol === accounts.protocol &&
            url.port === accounts.port))),
    { waitUntil: 'commit' },
  );
  if (new URL(page.url()).pathname.endsWith('/identity/failed'))
    throw new Error('Account sign-in failed');
  if (finished(new URL(page.url()))) return;
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  const locale = matchUiLocaleTag(await page.locator('html').getAttribute('lang') ?? undefined) ?? 'en';
  const { t: auth } = await i18n.getTranslation('auth', [locale]);
  const email = page.getByRole('textbox', { name: auth.emailLabel, exact: true });
  await email.fill('');
  // Native key events keep the controlled form's value aligned during the
  // Accounts app's first hydration, as typing in its component stories does.
  await email.pressSequentially(member.email);
  await expect(email).toHaveValue(member.email);
  await page.getByRole('button', { name: auth.next, exact: true }).click();
  await page.getByLabel(auth.passwordLabel, { exact: true }).fill(member.password);
  await page.getByRole('button', { name: auth.next, exact: true }).click();
  // Synthetic demo accounts may predate the current local policy revisions.
  const accept = page.getByRole('button', { name: auth.acceptButton, exact: true });
  await Promise.race([
    // The redirect commits the authenticated cookies; feature journeys wait
    // for their own UI readiness instead of unrelated document resources.
    page.waitForURL(finished, { timeout: 60_000, waitUntil: 'commit' }),
    accept.waitFor({ state: 'visible', timeout: 60_000 }),
  ]);
  if (await accept.isVisible()) {
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await accept.click();
  }
  // Playwright's predicate URL matcher also waits for document load. Assert
  // the committed redirect directly; later feature checks own UI readiness.
  await expect.poll(() => finished(new URL(page.url())), { timeout: 60_000 }).toBe(true);
}
