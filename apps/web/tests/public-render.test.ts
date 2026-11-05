import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { closeAccountMenu, openAccountMenu } from './support/account-menu';
import {
  closePublicRenderFixture,
  publicRenderPage as page,
  publicRenderSite as site,
  publicRenderState as state,
  signedInCookie,
} from './support/public-render-fixture.ts';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
afterAll(closePublicRenderFixture);

test('the root has no session, cookie or request header loader and consumers use useSession', async () => {
  const root = await Bun.file(join(app, 'src/routes/__root.tsx')).text();
  expect(root).not.toMatch(/\bloader\s*:/);
  expect(root).not.toContain('readSession');
  expect(root).not.toContain('getRequestHeader');
  expect(root).toContain('suppressHydrationWarning');
  for (const route of ['boards/$id', 'boards/$id_.new', 'collections/new', 'settings', 'threads/$id_.$slug']) {
    const source = await Bun.file(join(app, `src/routes/${route}.tsx`)).text();
    expect(source).not.toMatch(/useLoaderData\(\{ from: '__root__' \}\)/);
    expect(source).toContain('useSession()');
  }
});

test(
  'the nonce-bearing head script applies preferences before any external scripts run',
  async () => {
    const origin = await site();
    for (const theme of ['light', 'dark', 'system']) {
      const client = await page({ colorScheme: 'dark' });
      await client.context().addCookies([
        { name: 'rezics_theme', value: theme, url: origin },
        { name: 'rezics_nav', value: 'collapsed', url: origin },
      ]);
      await client.route('**/*', (route) =>
        route.request().resourceType() === 'script' ? route.abort() : route.continue(),
      );
      const response = await client.goto(`${origin}/en`, { waitUntil: 'networkidle' });
      const nonce = /'nonce-([^']+)'/.exec(response!.headers()['content-security-policy']!)![1]!;
      const result = await client.evaluate(() => ({
        theme: document.documentElement.className,
        nav: document.documentElement.dataset.nav,
        nonce: document.querySelector<HTMLScriptElement>('head script[data-preferences]')?.nonce,
        hydrated: document.documentElement.hasAttribute('data-hydrated'),
      }));
      expect(result).toEqual({ theme: theme === 'system' ? 'dark' : theme, nav: 'collapsed', nonce, hydrated: false });
      await client.context().close();
    }
  },
  timeout,
);

test(
  'hydration reads session and CSRF once, reserves the account slot and reuses it over three navigations',
  async () => {
    const origin = await site();
    const cookie = await signedInCookie(origin);
    for (const signedIn of [false, true]) {
      const client = await page();
      if (signedIn) await client.context().addCookies([cookie]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let cacheControl: string | undefined;
      let sessionResponseSeen = false;
      client.on('response', (response) => {
        // On the not-found page the first GET is sessionQuery; the signed-in menu then reads issuer config.
        if (!sessionResponseSeen && response.url().includes('/_serverFn/') && response.request().method() === 'GET') {
          sessionResponseSeen = true;
          cacheControl = response.headers()['cache-control'];
        }
      });
      await client.route('**/_serverFn/**', async (route) => {
        if (route.request().method() === 'GET') {
          await held;
        }
        await route.continue();
      });
      state.sessionReads = 0;
      state.sessionQueries = 0;
      await client.goto(`${origin}/en/no-such-page`);
      await client.locator('html[data-hydrated]').waitFor();
      const slot = client.locator('[data-session-slot]');
      const before = await slot.boundingBox();
      expect(before?.width).toBeGreaterThan(0);
      expect(await slot.locator('button, a').count()).toBe(0);
      release();
      await client.waitForLoadState('networkidle');
      if (signedIn) {
        await client.locator('#account-menu-button').waitFor();
        await openAccountMenu(client);
        expect(await client.locator('input[name="csrf_token"]').inputValue()).not.toBe('');
        await closeAccountMenu(client);
      } else {
        await slot.locator('a[href^="/auth/sign-in?return_to="]').waitFor();
      }
      expect(await slot.boundingBox()).toEqual(before);
      expect(cacheControl).toBe('private, no-store');
      for (let navigation = 0; navigation < 3; navigation += 1) {
        await client.locator('a[aria-label="REZICS"]').click();
        await client.waitForURL(`${origin}/en`);
        await client.getByRole('navigation').getByRole('link', { name: 'Search', exact: true }).click();
        await client.waitForURL(`${origin}/en/search`);
      }
      await client.waitForLoadState('networkidle');
      // Issuer configuration may have its own GET; only session-store reads are personal session reads.
      expect(state.sessionReads).toBe(signedIn ? 1 : 0);
      expect(state.sessionQueries).toBe(1);
      expect(await client.locator('meta[name="csrf-token"]').count()).toBe(0);
      await client.context().close();
    }
  },
  timeout,
);

test(
  'hydration preserves an explicit theme against the system preference and restores the saved rail',
  async () => {
    const origin = await site();
    for (const theme of ['light', 'dark'] as const) {
      const client = await page({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
      await client.context().addCookies([
        { name: 'rezics_theme', value: theme, url: origin },
        { name: 'rezics_nav', value: 'collapsed', url: origin },
      ]);
      await client.goto(`${origin}/en`, { waitUntil: 'networkidle' });
      await client.locator('html[data-hydrated]').waitFor();
      expect(await client.locator('html').getAttribute('class')).toBe(theme);
      expect(await client.locator('[data-slot="sidebar"][data-state="collapsed"]').count()).toBe(1);
      await client.context().close();
    }
  },
  timeout,
);

test(
  'without JavaScript the reserved shell slot offers Account to the server-checked settings page',
  async () => {
    const origin = await site();
    for (const signedIn of [false, true]) {
      const client = await page({ javaScriptEnabled: false });
      if (signedIn) await client.context().addCookies([await signedInCookie(origin)]);
      await client.goto(`${origin}/en`);
      const account = client.getByRole('link', { name: 'Account', exact: true });
      expect(await account.getAttribute('href')).toBe('/en/settings');
      expect(await client.locator('#account-menu-button').count()).toBe(0);
      await client.context().close();
    }
  },
  timeout,
);
