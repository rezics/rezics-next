import { expect, type Page } from '@playwright/test';
import { i18n, matchUiLocaleTag } from '../../accounts/i18n/locale.ts';
import { parseAddressSegment } from '../features/address/path.ts';
import { pathLocale, withoutLocale } from '../i18n/locale.ts';

const canonicalAddressRoute = /^\/(w|e|a|z|r|concepts)\/([^/]+)(\/.*)?$/;

export function signInDestinationMatches(url: URL, next: string, onboard = false): boolean {
  const target = next.split(/[?#]/)[0] ?? next;
  if (url.pathname === target || (onboard && url.pathname === '/en/onboarding')) return true;
  if (pathLocale(url.pathname) !== pathLocale(target)) return false;
  const actual = canonicalAddressRoute.exec(withoutLocale(url.pathname));
  const expected = canonicalAddressRoute.exec(withoutLocale(target));
  if (!actual || !expected || actual[1] !== expected[1] || actual[3] !== expected[3]) return false;
  try {
    // Main decorates the native identity before its subroute. Only that segment
    // may change; the locale, owner prefix and complete tail identify the destination.
    const actualAddress = parseAddressSegment(decodeURIComponent(actual[2]!));
    const expectedAddress = parseAddressSegment(decodeURIComponent(expected[2]!));
    return (
      actualAddress !== null &&
      actualAddress.kind !== 'alias' &&
      expectedAddress !== null &&
      expectedAddress.kind !== 'alias' &&
      actualAddress.id === expectedAddress.id
    );
  } catch {
    return false;
  }
}

/** Complete the browser redirect on the public Accounts origin. */
export async function signInAtAccounts(
  page: Page,
  next: string,
  member: { email: string; password: string },
  onboard = false,
): Promise<void> {
  const finished = (url: URL) => signInDestinationMatches(url, next, onboard);
  const destinationReady = async () => {
    // The callback can commit its destination while that document is still a
    // streaming route skeleton. Return after the destination has mounted.
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await page.locator('main > [role="status"][aria-busy="true"]').waitFor({ state: 'hidden', timeout: 60_000 });
  };
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
  if (finished(new URL(page.url()))) { await destinationReady(); return; }
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  const locale =
    matchUiLocaleTag((await page.locator('html').getAttribute('lang')) ?? undefined) ?? 'en';
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
  await destinationReady();
}
