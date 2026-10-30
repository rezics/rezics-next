import { afterAll, expect } from 'bun:test';
import type { Page } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';
import {
  createNativeSiteSubject,
  nativeNavigationNames,
  nativeSiteLocales,
  nativeSiteScreenshotPath,
  nativeSubjectLabels,
  prepareNativeSiteScreenshots,
  type NativeSiteLocale,
  type NativeSiteSubject,
} from './native-site-foundation-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

let stack: NativeWebStack;
let auth: NativeAuthStack;
let subject: NativeSiteSubject;
const lifecycle = new NativeTestLifecycle('native site foundation suite');

nativeBeforeAll(lifecycle, 360_000, async () => {
  stack = await startNativeWebStack();
  subject = await createNativeSiteSubject(stack);
  auth = await startAuthStack(stack);
});

afterAll(async () => {
  const errors: unknown[] = [];
  if (auth) {
    try {
      await auth.stop();
      await auth.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (stack) {
    try {
      await stack.stop();
      await stack.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Native site foundation cleanup failed');
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

async function ready(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

function localizedUrl(locale: NativeSiteLocale, query = ''): string {
  return `${stack.web}${subject.paths[locale]}${query}`;
}

nativeTest(
  'real Worker serves the subject and localized shell in all launch locales and preserves the requested localized sign-in destination',
  300_000,
  async () => {
    await prepareNativeSiteScreenshots();
    const anonymous = await auth.newContext('anonymous');
    const page = await anonymous.newPage();
    await page.emulateMedia({ colorScheme: 'light' });
    page.setDefaultTimeout(30_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (const locale of nativeSiteLocales) {
      await page.setViewportSize({ width: 1280, height: 860 });
      const response = await page.goto(localizedUrl(locale), { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `${locale} subject response`).toBe(200);
      expect(await page.locator('html').getAttribute('lang')).toBe(locale);
      expect(await page.locator('body').innerText()).toContain(nativeSubjectLabels[locale]);
      await ready(page);
      expect(await page.getByRole('main').count()).toBe(1);
      expect(await page.getByRole('banner').count()).toBe(1);
      expect(await page.getByRole('navigation', { name: nativeNavigationNames[locale] }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: nativeSiteScreenshotPath(locale, 1280, 'light'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: nativeSiteScreenshotPath(locale, 390, 'light'), fullPage: true });
    }
    expect(pageErrors).toEqual([]);

    await page.goto(localizedUrl('fr', '?source=localized-shell&view=overview'), { waitUntil: 'domcontentloaded' });
    await ready(page);
    const switcher = page.getByRole('button', { name: /langue/i });
    await switcher.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: 'Deutsch', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Deutsch', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.waitForURL(
      (url) => url.pathname === subject.paths.de && url.search === '?source=localized-shell&view=overview',
    );
    await ready(page);
    expect(await page.locator('body').innerText()).toContain(nativeSubjectLabels.de);
    expect(await page.locator('html').getAttribute('lang')).toBe('de');
    expect(new URL(page.url()).pathname).toBe(subject.paths.de);
    expect(new URL(page.url()).search).toBe('?source=localized-shell&view=overview');

    const returnTo = `${subject.paths.fr}?next=exact%20destination&view=overview`;
    await page.goto(`${stack.web}${returnTo}`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    const account = page.locator('[data-session-slot] button');
    await account.focus();
    await page.keyboard.press('Enter');
    const signIn = page.getByRole('link', { name: /se connecter/i });
    expect(await signIn.getAttribute('href')).toBe(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
    await page.keyboard.press('Escape');
    const journey = await auth.signIn('alice', { returnTo });
    expect(journey.url).toBe(`${stack.web}${returnTo}`);
    expect((await journey.response()).status()).toBe(200);
  },
  lifecycle,
);

nativeTest(
  'navigation, language, theme and account controls work by keyboard at phone and desktop sizes in both themes',
  300_000,
  async () => {
    const alice = await auth.signIn('alice');
    const page = alice.context.pages().at(-1)!;
    await page.goto(localizedUrl('de'), { waitUntil: 'domcontentloaded' });
    await ready(page);

    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 860 });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          document.cookie = `rezics_theme=${value}; Path=/; SameSite=Lax`;
        }, theme);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator('body').innerText()).toContain(nativeSubjectLabels.de);
        expect(await page.getByRole('main').count()).toBe(1);
        expect(await page.getByRole('banner').count()).toBe(1);

        await page.evaluate(() => {
          document.cookie = 'rezics_nav=expanded; Path=/; SameSite=Lax';
        });
        if (width < 768) {
          const navigation = page.getByRole('button', { name: 'Navigation öffnen', exact: true });
          await navigation.focus();
          await page.keyboard.press('Enter');
          expect(await page.getByRole('navigation', { name: nativeNavigationNames.de }).isVisible()).toBe(true);
          await page.keyboard.press('Escape');
          expect(await navigation.evaluate((element) => element === document.activeElement)).toBe(true);
        } else {
          const collapse = page.getByRole('button', { name: 'Navigation einklappen', exact: true });
          await collapse.focus();
          await page.keyboard.press('Enter');
          const expand = page.getByRole('button', { name: 'Navigation ausklappen', exact: true });
          expect(await expand.isVisible()).toBe(true);
          expect(await expand.evaluate((element) => element === document.activeElement)).toBe(true);
          await page.keyboard.press('Enter');
          expect(await page.getByRole('button', { name: 'Navigation einklappen', exact: true }).isVisible()).toBe(true);
        }

        const language = page.getByRole('button', { name: /sprache/i });
        await language.focus();
        await page.keyboard.press('Enter');
        expect(await page.getByRole('radio', { name: 'Français', exact: true }).isVisible()).toBe(true);
        await page.keyboard.press('Escape');
        expect(await language.evaluate((element) => element === document.activeElement)).toBe(true);

        const appearance = page.getByRole('button', { name: 'Darstellung', exact: true });
        await appearance.focus();
        await page.keyboard.press('Enter');
        expect(await page.getByRole('radio', { name: 'Dunkel', exact: true }).isVisible()).toBe(true);
        await page.keyboard.press('Escape');
        expect(await appearance.evaluate((element) => element === document.activeElement)).toBe(true);

        const account = page.locator('#account-menu-button');
        await account.focus();
        await page.keyboard.press('Enter');
        expect(await page.getByRole('link', { name: /einstellungen/i }).isVisible()).toBe(true);
        await page.keyboard.press('Escape');
        expect(await account.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.screenshot({ path: nativeSiteScreenshotPath('de', width, theme), fullPage: true });
      }
    }
  },
  lifecycle,
);

nativeTest(
  'localized page cache stays public without exposing personal facts and server-function reads share account admission',
  300_000,
  async () => {
    const alice = await auth.signIn('alice');
    const aliceSecond = await auth.signIn('alice', { context: await auth.newContext('alice') });
    const bob = await auth.signIn('bob');
    const aliceCookie = await alice.context.cookies(stack.web);
    const bobCookie = await bob.context.cookies(stack.web);

    const publicUrl = localizedUrl('en');
    const anonymousResponse = await auth.context('anonymous').request.get(publicUrl);
    const signedInResponse = await alice.context.request.get(publicUrl);
    const anonymousHtml = await anonymousResponse.text();
    const signedInHtml = await signedInResponse.text();
    expect(anonymousResponse.status()).toBe(200);
    expect(signedInResponse.status()).toBe(200);
    expect(anonymousResponse.headers()['cache-control']).toContain('public');
    expect(signedInResponse.headers()['cache-control']).toContain('public');
    expect(anonymousResponse.headers()['etag']).toBe(signedInResponse.headers()['etag']);
    expect(anonymousHtml).toContain(nativeSubjectLabels.en);
    expect(signedInHtml).toContain(nativeSubjectLabels.en);
    const aliceIdentity = await stack.authPersona('alice');
    const bobIdentity = await stack.authPersona('bob');
    for (const html of [anonymousHtml, signedInHtml]) {
      expect(html).not.toContain(aliceIdentity.email);
      expect(html).not.toContain(aliceIdentity.accountId);
      expect(html).not.toContain(bobIdentity.email);
      expect(html).not.toContain('Bearer ');
    }
    expect(aliceCookie.find(({ name }) => name === '__Host-rezics_session')?.value).toBeTruthy();
    expect(bobCookie.find(({ name }) => name === '__Host-rezics_session')?.value).toBeTruthy();

    const sessionCall = async (journey: typeof alice) =>
      (await journey.serverFunctionRequests()).find(
        ({ responseBody }) => responseBody.includes('csrfToken') && responseBody.includes('signed-in'),
      );
    const [aliceFunction, secondAliceFunction, bobFunction] = await Promise.all([
      sessionCall(alice),
      sessionCall(aliceSecond),
      sessionCall(bob),
    ]);
    expect(aliceFunction).toBeDefined();
    expect(secondAliceFunction).toBeDefined();
    expect(bobFunction).toBeDefined();

    const drainAccount = async (journey: typeof alice, call: NonNullable<typeof aliceFunction>) => {
      const page = journey.context.pages().at(-1)!;
      let last: { status: number; body: string; retryAfter: string | null } | undefined;
      for (let count = 0; count < 110; count += 1) {
        last = await page.evaluate(async ({ url, method, headers, body }) => {
          const response = await fetch(url, {
            method,
            headers,
            credentials: 'same-origin',
            ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
          });
          return {
            status: response.status,
            body: await response.text(),
            retryAfter: response.headers.get('retry-after'),
          };
        }, call);
        if (last.status === 429) return last;
        expect(last.status).toBe(200);
      }
      throw new Error('Signed-in account was not admitted through the native read limiter');
    };

    const denied = await drainAccount(alice, aliceFunction!);
    expect(denied.retryAfter).toBe('10');
    expect(denied.body).not.toContain(aliceCookie.find(({ name }) => name === '__Host-rezics_session')!.value);
    expect(denied.body).not.toContain('Bearer ');

    const secondPage = aliceSecond.context.pages().at(-1)!;
    const sameAccount = await secondPage.evaluate(async ({ url, method, headers, body }) => {
      const response = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      });
      return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
    }, secondAliceFunction!);
    expect(sameAccount.status).toBe(429);
    expect(sameAccount.retryAfter).toBe('10');

    const sameAccountSuggestions = await secondPage.evaluate(async () => {
      const response = await fetch('/api/search/suggestions?q=orbit&locale=en', { credentials: 'same-origin' });
      return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
    });
    expect(sameAccountSuggestions.status).toBe(429);
    expect(sameAccountSuggestions.retryAfter).toBe('10');

    const otherAccount = await bob.context
      .pages()
      .at(-1)!
      .evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'same-origin' });
        return { status: response.status, body: await response.text() };
      }, bobFunction!.url);
    expect(otherAccount.status).toBe(200);
    expect(otherAccount.body).toContain('signed-in');
  },
  lifecycle,
);

nativeTest(
  'real local Worker rate-limit bindings deny and recover at ten seconds and enforce the sixty-second window',
  300_000,
  async () => {
    const ip = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
    const read = async (address: string, cookie?: string) =>
      stack.request(localizedUrl('en'), undefined, {
        'CF-Connecting-IP': address,
        ...(cookie ? { cookie } : {}),
      });

    const shortIp = ip();
    const aliceCookie = (await auth.context('alice').cookies(stack.web))
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    const shortResponses = await Promise.all(
      Array.from({ length: 101 }, (_, index) => read(shortIp, index % 2 === 0 ? aliceCookie : undefined)),
    );
    expect(shortResponses.filter(({ status }) => status === 200)).toHaveLength(100);
    const shortDenied = shortResponses.find(({ status }) => status === 429);
    expect(shortDenied?.headers.get('retry-after')).toBe('10');
    const shortBody = await shortDenied!.text();
    await Promise.all(
      shortResponses.filter((response) => response !== shortDenied).map((response) => response.arrayBuffer()),
    );
    expect(shortBody).not.toContain(aliceCookie);
    expect(shortBody).not.toContain('Bearer ');
    await Bun.sleep(10_100);
    expect((await read(shortIp)).status).toBe(200);

    const longIp = ip();
    for (let window = 0; window < 3; window += 1) {
      const start = Date.now();
      const responses = await Promise.all(Array.from({ length: 100 }, () => read(longIp)));
      expect(responses.every(({ status }) => status === 200)).toBe(true);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      const remaining = 10_100 - (Date.now() - start);
      if (window < 2 && remaining > 0) await Bun.sleep(remaining);
    }
    await Bun.sleep(10_100);
    const longDenied = await read(longIp);
    expect(longDenied.status).toBe(429);
    expect(longDenied.headers.get('retry-after')).toBe('60');
    expect(await longDenied.text()).not.toContain(longIp);
  },
  lifecycle,
);
