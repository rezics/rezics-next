import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import space from '../src/kernel/recorded/space-address.json';
import board from '../src/kernel/recorded/board.json';
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
// Router timestamps and issuer claims share the server's fixed render clock.
const renderTime = Date.now();

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
let sessionReads = 0;
let credentialReads = 0;
let sessionQueries = 0;
let stalled = false;
let expiresIn = 3600;
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Auth as it serves the website client. The person is already signed in there, so authorization answers at once.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    if (new URL(request.url).pathname === '/session-read') {
      sessionReads += 1;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/credential-read') {
      credentialReads += 1;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/session-query') {
      sessionQueries += 1;
      return new Response(null, { status: 204 });
    }
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
          currentDate: new Date(renderTime),
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
          .setIssuedAt(Math.floor(renderTime / 1000))
          .setExpirationTime(Math.floor(renderTime / 1000) + 300)
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

const recorded = createStoryRecordedKernelFetch();
const kernel = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => recorded(request) });
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let started: Promise<string> | undefined;
let directory: string | undefined;
function site(): Promise<string> {
  return (started ??= (async () => {
    const root = resolve(app, '../..');
    await mkdir(join(root, '.temp'), { recursive: true });
    directory = await mkdtemp(join(root, '.temp/public-render-'));
    const config = join(directory, 'vite.config.ts');
    // Count real Durable Object RPCs without changing their answers or the application sources.
    await Bun.write(
      config,
      `
      import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};
      export default { ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))}, plugins: [...config.plugins, {
        name: 'count-session-rpcs', enforce: 'pre',
        transform(code, id) {
          // Hold time constant as well as kernel data: router hydration includes read timestamps.
          if (id.endsWith('/src/server.ts')) return \`const liveDate = Date;
            globalThis.Date = new Proxy(liveDate, {
              construct(target, args) { return Reflect.construct(target, args.length ? args : [${renderTime}]); },
              get(target, key) { return key === 'now' ? () => ${renderTime} : Reflect.get(target, key); }
            });\` + code;
          if (id.endsWith('/src/session/state.ts')) return code.replace('return readSessionIdentity(request, env);', 'await fetch(${JSON.stringify(`${fake.url.origin}/session-query`)}); return readSessionIdentity(request, env);');
          if (!id.endsWith('/src/session/store.ts')) return;
          return code
            .replace('async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> {', '$& await fetch(${JSON.stringify(`${fake.url.origin}/session-read`)});')
            .replace('credential(): Promise<Credential> {', 'credential(): Promise<Credential> { return fetch(${JSON.stringify(`${fake.url.origin}/credential-read`)}).then(() => this.countedCredential()); } private countedCredential(): Promise<Credential> {');
        }
      }] };
    `,
    );
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    let output = '';
    child = spawn(
      'bun',
      ['run', 'dev', '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
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
      },
    );
    child.stdout!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    child.stderr!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${origin}/en`)).status === 200) return origin;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(output);
  })());
}
async function page(options: BrowserContextOptions = {}) {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, ...options });
  return context.newPage();
}
async function signedInCookie(origin: string) {
  const client = await page();
  await client.goto(`${origin}/auth/sign-in?return_to=/en`);
  await client.waitForLoadState('networkidle');
  const cookie = (await client.context().cookies()).find((cookie) => cookie.name === sessionCookie)!;
  expect(cookie).toBeDefined();
  await client.context().close();
  return cookie;
}
afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  kernel.stop(true);
  fake.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});
const paths = ['/en', `/en/spaces/${space.address}`, `/en/boards/${board.board.id}`];

test('the root has no session, cookie or request header loader and consumers use useSession', async () => {
  const root = await Bun.file(join(app, 'src/routes/__root.tsx')).text();
  expect(root).not.toMatch(/\bloader\s*:/);
  expect(root).not.toContain('readSession');
  expect(root).not.toContain('getRequestHeader');
  expect(root).toContain('suppressHydrationWarning');
  for (const route of [
    'boards/$id',
    'boards/$id_.new',
    'collections/new',
    'settings',
    'subjects/$id',
    'threads/$id_.$slug',
  ]) {
    const source = await Bun.file(join(app, `src/routes/${route}.tsx`)).text();
    expect(source).not.toMatch(/useLoaderData\(\{ from: '__root__' \}\)/);
    expect(source).toContain('useSession()');
  }
});

test(
  'home, Space and board server renders have zero session and Auth requests and identical HTML',
  async () => {
    const origin = await site();
    const cookie = await signedInCookie(origin);
    for (const path of paths) {
      const html: string[] = [];
      sessionReads = 0;
      credentialReads = 0;
      sessionQueries = 0;
      authRequests = 0;
      for (const signedIn of [false, true]) {
        const response = await fetch(`${origin}${path}`, {
          headers: signedIn
            ? { cookie: `${cookie.name}=${cookie.value}; rezics_theme=dark; rezics_nav=collapsed` }
            : {},
        });
        expect(response.status).toBe(200);
        const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)![1]!;
        const body = (await response.text()).replaceAll(nonce, 'NONCE');
        expect(body).not.toContain('name="csrf-token"');
        html.push(body);
      }
      expect(sessionReads).toBe(0);
      expect(credentialReads).toBe(0);
      expect(authRequests).toBe(0);
      expect(html[1]).toBe(html[0]);
    }
  },
  timeout,
);

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
      sessionReads = 0;
      sessionQueries = 0;
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
        expect(await client.locator('input[name="csrf_token"]').inputValue()).not.toBe('');
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
      expect(sessionReads).toBe(signedIn ? 1 : 0);
      expect(sessionQueries).toBe(1);
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
