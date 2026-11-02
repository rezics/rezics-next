import { waitForPersonalRead } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

type Messages = Record<string, string>;
async function messages(locale: string): Promise<Messages> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;
}

// The website client's key, which only the Worker holds, and the issuer's signing key.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string };
const codes = new Map<string, Grant>();
let counter = 0;
const liveRefreshTokens = new Set<string>();

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Auth answers as a person who is already signed in, so the shell can read a real session from the request.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['personal_library', 'collections'] });
    const issuer = `${url.origin}/auth`;
    const authenticated = async (form: URLSearchParams) => {
      try {
        await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        return true;
      } catch {
        return false;
      }
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/authorize') {
      const params = url.searchParams;
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        challenge: params.get('code_challenge')!,
        nonce: params.get('nonce')!,
        redirectUri: params.get('redirect_uri')!,
      });
      const back = new URL(params.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state')!);
      return new Response(null, { status: 302, headers: { location: back.href } });
    }
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await authenticated(form))) return json({ error: 'invalid_client' }, 401);
      counter += 1;
      const tokens: Record<string, unknown> = {
        access_token: `access-${counter}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${counter}`,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        tokens.id_token = await new SignJWT({ nonce: grant.nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject('alice')
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      } else if (
        form.get('grant_type') !== 'refresh_token' ||
        !liveRefreshTokens.delete(form.get('refresh_token') ?? '')
      )
        return json({ error: 'invalid_grant' }, 400);
      liveRefreshTokens.add(tokens.refresh_token as string);
      return json(tokens);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
    if (url.pathname === '/auth/logout')
      return new Response(null, {
        status: 302,
        headers: { location: url.searchParams.get('post_logout_redirect_uri') ?? issuer },
      });
    return json({ error: 'not_found' }, 404);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

// The documented command, in its own process group so that Vite and workerd stop with it.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScriptEnabled !== false) {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await waitForPersonalRead(page, ['session']);
  }
  return page;
}

async function visit(page: Page, path: string, javaScriptEnabled = true): Promise<void> {
  const origin = await site();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (javaScriptEnabled) {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await waitForPersonalRead(page, ['session']);
  }
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

type Destination = { name: string; href: string };
type FoundLink = Destination & { current: string | null; icon: boolean };

function shellDestinations(own: Messages, locale: string, signed: boolean, desktop = true): Destination[] {
  const entry = (key: string, path: string) => ({ name: own[key]!, href: `/${locale}${path}` });
  return [
    entry('nav_home', ''),
    entry('nav_search', '/search'),
    entry('board_directory_heading', '/boards'),
    ...(signed
      ? [
          entry('nav_library', '/library'),
          ...(desktop ? [entry('nav_inbox', '/inbox')] : []),
          entry('moderation_reports_heading', '/moderation/catalogue'),
          entry('ctxw_title', '/my/contexts'),
          entry('zones_owner_title', '/my/zones'),
          entry('library_collection_new', '/collections/new'),
          entry('ctxw_create', '/my/contexts/new'),
          entry('zones_owner_create', '/my/zones/new'),
        ]
      : []),
  ];
}

async function navigationLinks(page: Page, name: string): Promise<FoundLink[]> {
  const navigation = page.getByRole('navigation', { name, exact: true });
  expect(await navigation.count()).toBe(1);
  return navigation.locator('a').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: new URL(anchor.getAttribute('href') ?? '', location.origin).pathname,
      current: anchor.getAttribute('aria-current'),
      icon: anchor.querySelector('svg') !== null,
    })),
  );
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

// On a phone the navigation lives in a sheet that the header button opens.
async function openSheet(page: Page, openName: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: openName, exact: true }).click();
  await page.getByRole('dialog').waitFor();
}

async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function expectDestinations(
  page: Page,
  navigationName: string,
  expected: Destination[],
  currentName: string | null,
  where: string,
  openName?: string,
): Promise<void> {
  const sheet = openName !== undefined && isPhone(page);
  if (sheet) await openSheet(page, openName);
  const found = await navigationLinks(page, navigationName);
  expect(
    found.map(({ name, href }) => ({ name, href })),
    where,
  ).toEqual(expected);
  expect(
    found.filter(({ href }) => !href.includes('/my/')).every((item) => item.icon),
    where,
  ).toBe(true);
  expect(
    found.map((item) => [item.name, item.current]),
    where,
  ).toEqual(expected.map((item) => [item.name, item.name === currentName ? 'page' : null]));
  if (sheet) await closeSheet(page);
}

function headerSearch(page: Page, label: string) {
  return page.locator('header').locator(`input[aria-label="${label}"]`);
}

let signedIn: Promise<NonNullable<BrowserContextOptions['storageState']>> | undefined;
function signedInState(): Promise<NonNullable<BrowserContextOptions['storageState']>> {
  signedIn ??= (async () => {
    const origin = await site();
    const en = await messages('en');
    const page = await open('/en');
    await page.getByRole('button', { name: en.account_menu!, exact: true }).click();
    await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(`${origin}/auth/callback`)),
      page.getByRole('link', { name: en.account_sign_in!, exact: true }).click(),
    ]);
    await page.waitForURL(`${origin}/en`);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === sessionCookie);
    expect(cookies).toHaveLength(1);
    await page.context().close();
    return { cookies, origins: [] };
  })();
  return signedIn;
}

test.serial(
  'the navigation offers public and signed-in journeys and marks the current destination',
  async () => {
    for (const locale of locales) {
      const own = await messages(locale);
      for (const key of ['nav_home', 'nav_search', 'nav_library'] as const)
        expect(own[key]?.trim(), `${locale} ${key}`).toBeTruthy();
      expect(own.nav_search, locale).not.toBe(own.nav_home);
      expect(own.nav_library, locale).not.toBe(own.nav_home);
      expect(own.nav_library, locale).not.toBe(own.nav_search);
    }

    const session = await signedInState();
    const en = await messages('en');
    const menuPage = await open('/en', { storageState: session });
    await menuPage.getByRole('button', { name: en.account_menu!, exact: true }).click();
    const menu = menuPage.getByRole('group', { name: en.account_menu!, exact: true });
    expect(await menu.getByRole('link', { name: en.library_nav_library!, exact: true }).getAttribute('href')).toBe(
      '/en/library',
    );
    expect(await menu.getByRole('link', { name: en.library_nav_collections!, exact: true }).getAttribute('href')).toBe(
      '/en/collections',
    );
    expect(await menu.getByRole('link', { name: en.library_nav_following!, exact: true }).getAttribute('href')).toBe(
      '/en/following',
    );
    await menuPage.context().close();

    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      const home = { name: own.nav_home!, href: `/${locale}` };
      const search = { name: own.nav_search!, href: `/${locale}/search` };
      const library = { name: own.nav_library!, href: `/${locale}/library` };
      for (const viewport of [desktop, phone])
        for (const signed of [false, true]) {
          const expected = shellDestinations(own, locale, signed, viewport === desktop);
          const where = `${locale} ${viewport.width}px ${signed ? 'signed in' : 'signed out'}`;
          const page = await open(`/${locale}`, {
            viewport,
            ...(signed ? { storageState: session } : {}),
          });
          await expectDestinations(
            page,
            own.shell_navigation!,
            expected,
            home.name,
            `${where} home`,
            own.shell_open_navigation!,
          );
          await visit(page, `/${locale}/search`);
          await expectDestinations(
            page,
            own.shell_navigation!,
            expected,
            search.name,
            `${where} search`,
            own.shell_open_navigation!,
          );
          await visit(page, `/${locale}/no-such-page`);
          await expectDestinations(
            page,
            own.shell_navigation!,
            expected,
            null,
            `${where} other`,
            own.shell_open_navigation!,
          );
          if (signed)
            for (const path of [`/${locale}/library`, `/${locale}/library/shelf`]) {
              await visit(page, path);
              await expectDestinations(
                page,
                own.shell_navigation!,
                expected,
                library.name,
                `${where} ${path}`,
                own.shell_open_navigation!,
              );
            }
          await page.context().close();
        }

      const collapsed = await open(`/${locale}`, { storageState: session });
      await collapsed.getByRole('button', { name: own.shell_collapse_navigation!, exact: true }).click();
      await collapsed.getByRole('button', { name: own.shell_expand_navigation!, exact: true }).waitFor();
      await expectDestinations(
        collapsed,
        own.shell_navigation!,
        shellDestinations(own, locale, true),
        home.name,
        `${locale} collapsed`,
      );
      await visit(collapsed, `/${locale}/library/shelf`);
      await expectDestinations(
        collapsed,
        own.shell_navigation!,
        shellDestinations(own, locale, true),
        library.name,
        `${locale} collapsed library`,
      );
      await collapsed.context().close();
    }
  },
  timeout,
);

test.serial(
  'the phone navigation sheet offers the same destinations',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      for (const signed of [false, true]) {
        const expected = shellDestinations(own, locale, signed, false);
        const storageState = signed ? session : undefined;
        const where = `${locale} ${signed ? 'signed in' : 'signed out'}`;
        const wide = await open(`/${locale}/no-such-page`, storageState ? { storageState } : {});
        const rail = (await navigationLinks(wide, own.shell_navigation!)).map(({ name, href }) => ({ name, href }));
        expect(rail, `${where} rail`).toEqual(shellDestinations(own, locale, signed));
        await wide.context().close();

        const narrow = await open(`/${locale}/no-such-page`, {
          viewport: phone,
          ...(storageState ? { storageState } : {}),
        });
        await openSheet(narrow, own.shell_open_navigation!);
        const sheet = await navigationLinks(narrow, own.shell_navigation!);
        expect(
          sheet.map(({ name, href }) => ({ name, href })),
          where,
        ).toEqual(expected);
        const box = await narrow.getByRole('dialog').boundingBox();
        expect(box, where).not.toBeNull();
        expect(box!.x, where).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, where).toBeLessThanOrEqual(phone.width);
        expect(box!.y + box!.height, where).toBeCloseTo(phone.height, 0);
        expect(box!.height, where).toBeLessThan(phone.height);
        await narrow.context().close();
      }
    }
  },
  timeout,
);

test.serial(
  'the header search is left out on the home and search pages and shown on every other page',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const label = (await messages(locale)).search_label!;
      expect(label.trim(), locale).toBeTruthy();
      for (const javaScriptEnabled of [true, false])
        for (const viewport of [desktop, phone]) {
          const where = `${locale} ${viewport.width}px ${javaScriptEnabled ? 'script' : 'first paint'}`;
          const page = await open(`/${locale}`, { javaScriptEnabled, viewport });
          expect(await headerSearch(page, label).count(), `${where} home`).toBe(0);
          await visit(page, `/${locale}/search`, javaScriptEnabled);
          expect(await headerSearch(page, label).count(), `${where} search`).toBe(0);
          expect(
            await page.getByRole('main').getByRole('textbox', { name: label, exact: true }).count(),
            `${where} search field`,
          ).toBe(1);
          await visit(page, `/${locale}/no-such-page`, javaScriptEnabled);
          const other = headerSearch(page, label);
          expect(await other.count(), `${where} other`).toBe(1);
          expect(await other.isVisible(), `${where} other`).toBe(viewport === desktop);
          if (viewport === desktop) {
            await visit(page, `/${locale}/subjects/${subjectId}`, javaScriptEnabled);
            const subject = headerSearch(page, label);
            expect(await subject.count(), `${where} subject`).toBe(1);
            expect(await subject.isVisible(), `${where} subject`).toBe(true);
          }
          await page.context().close();
        }
    }

    const en = (await messages('en')).search_label!;
    for (const javaScriptEnabled of [true, false]) {
      const where = `signed in ${javaScriptEnabled ? 'script' : 'first paint'}`;
      const page = await open('/en', { javaScriptEnabled, storageState: session });
      expect(await headerSearch(page, en).count(), `${where} home`).toBe(0);
      await visit(page, '/en/search', javaScriptEnabled);
      expect(await headerSearch(page, en).count(), `${where} search`).toBe(0);
      await visit(page, '/en/no-such-page', javaScriptEnabled);
      expect(await headerSearch(page, en).count(), `${where} other`).toBe(1);
      await page.context().close();
    }
  },
  timeout,
);

test.serial(
  'signed-in desktop navigation retains Library and Inbox',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      const page = await open(`/${locale}`, { viewport: desktop, storageState: session });
      const navigation = page.getByRole('navigation', { name: own.shell_navigation!, exact: true });
      const library = navigation.locator(`a[href="/${locale}/library"]`);
      const inbox = navigation.locator(`a[href="/${locale}/inbox"]`);
      await library.waitFor();
      expect(await library.textContent()).toBe(own.nav_library!);
      expect(await inbox.isVisible()).toBe(true);
      expect(await inbox.textContent()).toContain(own.nav_inbox!);
      for (const path of [`/${locale}/library/shelf`, `/${locale}/inbox`]) {
        await visit(page, path);
        const current = path.endsWith('/inbox') ? inbox : library;
        expect(await current.getAttribute('aria-current')).toBe('page');
        expect(await (path.endsWith('/inbox') ? library : inbox).getAttribute('aria-current')).toBeNull();
      }
      await page.getByRole('button', { name: own.shell_collapse_navigation!, exact: true }).click();
      expect(await library.isVisible()).toBe(true);
      expect(await inbox.isVisible()).toBe(true);
      await page.context().close();
    }
  },
  timeout,
);
