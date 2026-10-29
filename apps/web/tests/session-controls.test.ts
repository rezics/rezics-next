import { waitForPersonalRead } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };

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
const liveRefreshTokens = new Set<string>();
const signInRefreshTokens: string[] = [];
const idTokens: string[] = [];
const revoked: string[] = [];
const endSessions: URLSearchParams[] = [];
let authRequests = 0;
let stalled = false;
let expiresIn = 3600;
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Auth as it serves the website client. The person is already signed in there, so authorization answers at once.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    authRequests += 1;
    // While stalled, Auth accepts connections and never answers.
    if (stalled) return new Promise<Response>(() => {});
    const url = new URL(request.url);
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
        expires_in: expiresIn,
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
        idTokens.push(tokens.id_token as string);
        signInRefreshTokens.push(tokens.refresh_token as string);
      } else if (
        form.get('grant_type') !== 'refresh_token' ||
        !liveRefreshTokens.delete(form.get('refresh_token') ?? '')
      )
        return json({ error: 'invalid_grant' }, 400);
      liveRefreshTokens.add(tokens.refresh_token as string);
      return json(tokens);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await authenticated(form))) return json({ error: 'invalid_client' }, 401);
      revoked.push(form.get('token') ?? '');
      liveRefreshTokens.delete(form.get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/auth/logout') {
      endSessions.push(url.searchParams);
      return new Response(null, {
        status: 302,
        headers: { location: url.searchParams.get('post_logout_redirect_uri') ?? issuer },
      });
    }
    return json({ error: 'not_found' }, 404);
  },
});

// Kernel reads are independent of Auth's request counter and stalls.
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => json({ error: 'not_found' }, 404),
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

// The documented command, pointed at the fakes through the environment it reads in development.
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
        KERNEL_ORIGIN: kernel.url.origin,
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
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
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

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const signInLink = (page: Page, own: Messages) => page.getByRole('link', { name: own.account_sign_in!, exact: true });
const accountMenuButton = (page: Page, own: Messages) =>
  page.getByRole('button', { name: own.account_menu!, exact: true });
async function openAccountMenu(page: Page, own: Messages) {
  const menu = page.getByRole('group', { name: own.account_menu!, exact: true });
  if (!(await menu.isVisible())) await accountMenuButton(page, own).click();
  await menu.waitFor({ state: 'visible' });
}
async function signOutButton(page: Page, own: Messages) {
  await accountMenuButton(page, own).waitFor();
  if (own.account_menu) {
    if (await accountMenuButton(page, own).count()) await openAccountMenu(page, own);
  }
  return page.getByRole('button', { name: own.account_sign_out!, exact: true });
}
const homeLink = (page: Page, own: Messages) =>
  page
    .getByRole('navigation', { name: own.shell_navigation!, exact: true })
    .getByRole('link', { name: own.nav_home!, exact: true });

// Follows the page's sign-in link through Auth and back to the page it was opened from.
async function signIn(page: Page, own: Messages, javaScriptEnabled = true) {
  const origin = await site();
  const from = page.url();
  await openAccountMenu(page, own);
  await Promise.all([
    page.waitForResponse((response) => response.url().startsWith(`${origin}/auth/callback`)),
    signInLink(page, own).click(),
  ]);
  await page.waitForURL(from);
  await page.waitForLoadState('networkidle');
  if (javaScriptEnabled) {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await accountMenuButton(page, own).waitFor();
  }
}

async function eventually(read: () => Promise<string | null>, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await Bun.sleep(100);
    value = await read();
  }
  expect(value).toBe(expected);
}

test(
  'a signed-out page offers sign-in that returns to the page it was opened from',
  async () => {
    for (const locale of locales) {
      const own = await messages(locale);
      for (const key of ['account_sign_in', 'account_sign_out'])
        expect(own[key]?.trim(), `${locale} ${key}`).toBeTruthy();
    }
    const origin = await site();
    const de = await messages('de');
    const page = await open('/de/no-such-page?from=test');
    await openAccountMenu(page, de);
    const returnTo = async () => {
      const target = new URL((await signInLink(page, de).getAttribute('href'))!, origin);
      expect(`${target.origin}${target.pathname}`).toBe(`${origin}/auth/sign-in`);
      return target.searchParams.get('return_to');
    };
    expect(await signInLink(page, de).count()).toBe(1);
    expect(await (await signOutButton(page, de)).count()).toBe(0);
    expect(await returnTo()).toBe('/de/no-such-page?from=test');
    // After a client-side navigation the link returns to the new page.
    await homeLink(page, de).click();
    await page.waitForURL(`${origin}/de`);
    await eventually(returnTo, '/de');
    await page.context().close();

    const ja = await messages('ja');
    const small = await open('/ja', { javaScriptEnabled: false, viewport: phone });
    expect(await signInLink(small, ja).count()).toBe(0);
    expect(await small.getByRole('link', { name: ja.account_menu!, exact: true }).getAttribute('href')).toBe(
      '/ja/settings',
    );
    await small.context().close();
  },
  timeout,
);

test(
  'signing in returns to the same page signed in, and signing out revokes the session and ends it at Auth',
  async () => {
    const origin = await site();
    const ja = await messages('ja');
    const page = await open('/ja/no-such-page', { locale: 'ja' });
    await signIn(page, ja);
    const refreshToken = signInRefreshTokens.at(-1)!;
    const idToken = idTokens.at(-1)!;
    expect(new URL(page.url()).pathname).toBe('/ja/no-such-page');
    expect(await (await signOutButton(page, ja)).count()).toBe(1);
    expect(await signInLink(page, ja).count()).toBe(0);
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === sessionCookie);
    expect(session).toBeDefined();
    expect(cookies.some((cookie) => cookie.name === loginCookie)).toBe(false);
    // Each document hydrates its private session after rendering the public shell.
    await page.goto(`${origin}/ja`, { waitUntil: 'networkidle' });
    expect(await (await signOutButton(page, ja)).count()).toBe(1);

    await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(`${fake.url.origin}/auth/logout`)),
      (await signOutButton(page, ja)).click(),
    ]);
    await page.waitForURL(`${origin}/ja`);
    await page.waitForLoadState('networkidle');
    await openAccountMenu(page, ja);
    await signInLink(page, ja).waitFor();
    expect(revoked).toContain(refreshToken);
    const ended = endSessions.at(-1)!;
    expect(ended.get('post_logout_redirect_uri')).toBe(`${origin}/`);
    expect(ended.get('id_token_hint')).toBe(idToken);
    expect(await signInLink(page, ja).count()).toBe(1);
    expect(await (await signOutButton(page, ja)).count()).toBe(0);
    expect((await page.context().cookies()).some((cookie) => cookie.name === sessionCookie)).toBe(false);

    // The ended session's id, sent again, reads as signed out.
    await page.context().addCookies([session!]);
    await page.goto(`${origin}/ja`, { waitUntil: 'networkidle' });
    await openAccountMenu(page, ja);
    await signInLink(page, ja).waitFor();
    expect(await signInLink(page, ja).count()).toBe(1);
    expect(await (await signOutButton(page, ja)).count()).toBe(0);
    await page.context().close();
  },
  timeout,
);

test(
  'the hydrated header keeps sign-out and security settings in an account menu; script-free pages link to Account',
  async () => {
    for (const locale of locales) {
      const own = await messages(locale);
      for (const key of ['account_menu', 'account_security_settings'])
        expect(own[key]?.trim(), `${locale} ${key}`).toBeTruthy();
    }

    const origin = await site();
    const en = await messages('en');
    for (const javaScriptEnabled of [true, false]) {
      const page = await open('/en', { javaScriptEnabled });
      if (!javaScriptEnabled) {
        expect(await page.getByRole('link', { name: en.account_menu!, exact: true }).getAttribute('href')).toBe(
          '/en/settings',
        );
        expect(await accountMenuButton(page, en).count()).toBe(0);
        await page.context().close();
        continue;
      }
      await signIn(page, en);

      const account = accountMenuButton(page, en);
      expect(await account.count()).toBe(1);
      const menu = page.getByRole('group', { name: en.account_menu!, exact: true });
      expect(await menu.isVisible()).toBe(false);
      await account.click();
      expect(await menu.isVisible()).toBe(true);
      expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);

      const securitySettings = menu.getByRole('link', {
        name: en.account_security_settings!,
        exact: true,
      });
      expect(await securitySettings.getAttribute('href')).toBe(`${fake.url.origin}/security`);
      const signOut = menu.getByRole('button', { name: en.account_sign_out!, exact: true });
      expect(await signOut.count()).toBe(1);
      expect(await signOut.evaluate((element) => element.closest('form')?.getAttribute('method'))).toBe('post');
      expect(await signOut.evaluate((element) => element.closest('form')?.getAttribute('action'))).toBe(
        '/auth/sign-out',
      );

      await page.keyboard.press('Escape');
      expect(await menu.isVisible()).toBe(false);
      expect(await account.evaluate((element) => element === document.activeElement)).toBe(true);

      await account.click();
      expect(await menu.isVisible()).toBe(true);
      await page.locator('body').click({ position: { x: 10, y: 500 } });
      expect(await menu.isVisible()).toBe(false);

      await page.context().close();
    }
  },
  timeout,
);

test(
  'pages read the signed-in state without contacting Auth or refreshing tokens',
  async () => {
    const origin = await site();
    const en = await messages('en');
    const page = await open('/en');
    expiresIn = 1;
    try {
      await signIn(page, en);
    } finally {
      expiresIn = 3600;
    }
    // The access token has expired, so a refresh would be due if a page asked for a credential.
    await Bun.sleep(1_500);
    const before = authRequests;
    stalled = true;
    try {
      await page.goto(`${origin}/en/no-such-page`, { waitUntil: 'networkidle', timeout: 20_000 });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      expect(await (await signOutButton(page, en)).count()).toBe(1);
      await homeLink(page, en).click();
      await page.waitForURL(`${origin}/en`, { timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 20_000 });
      expect(await (await signOutButton(page, en)).count()).toBe(1);
      expect(authRequests).toBe(before);
    } finally {
      stalled = false;
    }
    await page.context().close();
  },
  timeout,
);

test(
  'the session controls have no accessibility violations signed in or out, in either theme at phone and desktop widths',
  async () => {
    const origin = await site();
    const en = await messages('en');
    const page = await open('/en');
    await signIn(page, en);
    const session = (await page.context().cookies()).filter((cookie) => cookie.name === sessionCookie);
    expect(session.length).toBe(1);
    await page.context().close();

    const found: string[] = [];
    for (const signedIn of [false, true])
      for (const theme of ['light', 'dark'])
        for (const viewport of [phone, desktop]) {
          const view = await open('/en', {
            viewport,
            storageState: {
              cookies: [
                ...(signedIn ? session : []),
                {
                  name: 'rezics_theme',
                  value: theme,
                  domain: new URL(origin).hostname,
                  path: '/',
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: 'Lax',
                },
              ],
              origins: [],
            },
          });
          const label = `${signedIn ? 'signed in' : 'signed out'} ${theme} ${viewport.width}px`;
          if (!signedIn) await openAccountMenu(view, en);
          expect(await (signedIn ? await signOutButton(view, en) : signInLink(view, en)).count(), label).toBe(1);
          const result = await new AxeBuilder({ page: view })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          for (const violation of result.violations)
            found.push(`${label}: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
          await view.context().close();
        }
    expect(found).toEqual([]);
  },
  timeout,
);
