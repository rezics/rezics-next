import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { download } from '../src/media/download.ts';
import type { MediaEnv } from '../src/media/index.ts';

type Messages = Record<string, string>;

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
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

const hostile = '<script>window.__x=1</script>';
const subjectId = fixtures.subjects[0]!.id;
let hostileLabel = false;
const kernel = createFakeKernelFetch(fixtures);
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const metadata = { route: 0, visibility: 'published', securityRevision: '1', createdAt: '2026-01-01T00:00:00.000Z' };

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
    if (url.pathname === `/v1/threads/${threadId}`)
      return json({
        thread: {
          ...metadata,
          id: threadId,
          boardId: threadId,
          authorId: 'alice',
          licence: 'CC-BY-4.0',
          subjectIds: [],
          title: 'Reading room',
          availability: 'available',
          firstPost: null,
        },
      });
    if (url.pathname === `/v1/threads/${threadId}/posts`)
      return json({ posts: [], next: null, as_of: metadata.createdAt });
    if (url.pathname === '/v1/subjects:search')
      return json({
        subjects: [{ id: subjectId, labels: fixtures.subjects[0]!.labels, descriptions: {} }],
        next: null,
        as_of: metadata.createdAt,
      });
    if (url.pathname.includes(':authorizeDownload'))
      return json({
        allowed: true,
        key: 'media',
        sha256: 'a'.repeat(64),
        mediaType: 'text/plain',
        byteCount: 5,
        publicCache: false,
        cacheControl: 'private, no-store',
      });
    const response = await kernel(request);
    if (hostileLabel && url.pathname === `/v1/subjects/${subjectId}`) {
      const body = await response.json();
      body.subject.labels.en = hostile;
      return json(body);
    }
    if (hostileLabel && request.method === 'POST' && url.pathname === '/v1/pages:read') {
      const requestBody = (await request.clone().json()) as { target?: { subject?: unknown } };
      if (requestBody.target?.subject === subjectId) {
        const body = (await response.json()) as {
          reads?: Record<string, { body?: { subject?: { id?: unknown; labels?: Record<string, string> } } }>;
        };
        for (const read of Object.values(body.reads ?? {})) {
          const subject = read.body?.subject;
          if (subject?.id === subjectId && subject.labels) subject.labels.en = hostile;
        }
        return json(body);
      }
    }
    return response;
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

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
    };
    const build = spawn('bun', ['run', 'build'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    build.stdout!.on('data', keep);
    build.stderr!.on('data', keep);
    const code = await new Promise<number | null>((resolve) => build.once('exit', resolve));
    if (code !== 0) throw new Error(`production build failed: ${output}`);
    child = spawn(
      'bun',
      ['x', '--no-install', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    );
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`preview server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`preview server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function page(signedIn = false): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const state = window as unknown as { violations: string[] };
    state.violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      state.violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  const page = await context.newPage();
  if (signedIn) {
    await page.goto(`${origin}/auth/sign-in?return_to=/en`);
    await page.locator('html[data-hydrated]').waitFor();
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookie)).toBe(true);
    await page.locator('form[action="/auth/sign-out"]').waitFor({ state: 'attached' });
    expect(await page.locator('form[action="/auth/sign-out"]').count()).toBe(1);
  }
  return page;
}

function nonce(policy: string | null): string {
  expect(policy).not.toBeNull();
  const value = /'nonce-([^']+)'/.exec(policy!)?.[1];
  expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(Buffer.from(value!, 'base64').length).toBe(16);
  return value!;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const signInLink = (page: Page, own: Messages) => page.getByRole('link', { name: own.account_sign_in!, exact: true });
const signOutButton = (page: Page, own: Messages) =>
  page.getByRole('button', { name: own.account_sign_out!, exact: true });
const homeLink = (page: Page, own: Messages) =>
  page
    .getByRole('navigation', { name: own.shell_navigation!, exact: true })
    .getByRole('link', { name: own.nav_home!, exact: true });

// Follows the page's sign-in link through Auth and back to the page it was opened from.
async function signIn(page: Page, own: Messages, javaScriptEnabled = true) {
  const origin = await site();
  const from = page.url();
  await Promise.all([
    page.waitForResponse((response) => response.url().startsWith(`${origin}/auth/callback`)),
    signInLink(page, own).click(),
  ]);
  await page.waitForURL(from);
  await page.waitForLoadState('networkidle');
  if (javaScriptEnabled) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
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
  "the built site's pages hydrate under a nonce-based content security policy with no violations",
  async () => {
    const origin = await site();
    for (const signedIn of [false, true]) {
      const tab = await page(signedIn);
      try {
        for (const path of ['/en', `/en/subjects/${subjectId}`, '/en/search?q=reading', `/en/threads/${threadId}`]) {
          const response = await tab.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
          expect(response!.status()).toBe(200);
          nonce(response!.headers()['content-security-policy'] ?? null);
          await tab.locator('html[data-hydrated]').waitFor();
          expect(await tab.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
        }
      } finally {
        await tab.context().close();
      }
    }
  },
  timeout,
);

test(
  'every page response carries a fresh nonce, and only nonced scripts run',
  async () => {
    const origin = await site();
    const seen = new Set<string>();
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const response = await fetch(`${origin}/en`);
        const value = nonce(response.headers.get('content-security-policy'));
        const html = await response.text();
        const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
        expect(scripts.length).toBeGreaterThan(0);
        for (const script of scripts) expect(script[1]).toContain(`nonce="${value}"`);
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }),
    );
    hostileLabel = true;
    const tab = await page();
    try {
      await tab.goto(`${origin}/en/subjects/${subjectId}`, { waitUntil: 'networkidle' });
      await tab.locator('html[data-hydrated]').waitFor();
      expect(await tab.getByRole('heading', { name: hostile, exact: true }).count()).toBe(1);
      expect(await tab.locator('main script').count()).toBe(0);
      expect(await tab.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
      expect(await tab.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
      // Inject parser-inserted HTML, rather than evaluate(), which bypasses CSP in Playwright.
      await tab.route('**/en', async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({ response, body: html.replace('</head>', '<script>window.__x=1</script></head>') });
      });
      await tab.goto(`${origin}/en`, { waitUntil: 'networkidle' });
      await tab.locator('html[data-hydrated]').waitFor();
      expect(await tab.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
      expect(await tab.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([
        'script-src-elem: inline',
      ]);
    } finally {
      hostileLabel = false;
      await tab.context().close();
    }
  },
  timeout,
);

test('only the curator page editor route relaxes styles, and nothing else', async () => {
  const { securityHeaders } = await import('../src/security/headers.ts');
  const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
  const policyAt = (path: string) =>
    securityHeaders(new Request(`https://rezics.test${path}`), 'test', `${fake.url.origin}/auth`).get(
      'content-security-policy',
    )!;
  const strictPolicy = policyAt('/en');
  const relaxedPolicy = strictPolicy.replace("style-src 'self' 'nonce-test'", "style-src 'self' 'unsafe-inline'");
  expect(relaxedPolicy).not.toBe(strictPolicy);

  for (const locale of locales) {
    for (const suffix of ['', '/', '/nested/deeper'])
      expect(policyAt(`/${locale}/curate/presentation${suffix}`)).toBe(relaxedPolicy);

    for (const path of [
      `/${locale}`,
      `/${locale}/curate`,
      `/${locale}/curate/presentationx`,
      `/${locale}/curate/presentationx/nested`,
      `/${locale}/x/curate/presentation`,
    ])
      expect(policyAt(path)).toBe(strictPolicy);
  }
});

test(
  'the policy admits exactly the outside origins the site uses',
  async () => {
    const response = await fetch(`${await site()}/en`);
    const policy = response.headers.get('content-security-policy');
    const value = nonce(policy);
    const directives = Object.fromEntries(
      policy!
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .map(([key, ...values]) => [key, values]),
    );
    expect(directives).toEqual({
      'default-src': ["'self'"],
      'script-src': [`'nonce-${value}'`, "'strict-dynamic'", 'https://challenges.cloudflare.com'],
      'style-src': ["'self'", `'nonce-${value}'`],
      'style-src-attr': ["'unsafe-inline'"],
      'img-src': ["'self'", 'blob:', 'data:'],
      'connect-src': ["'self'"],
      'frame-src': ['https://challenges.cloudflare.com'],
      'form-action': ["'self'", fake.url.origin],
      'base-uri': ["'none'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': [],
    });
  },
  timeout,
);

test(
  'pages send HSTS, nosniff, referrer and permissions policies, and refuse framing',
  async () => {
    const origin = await site();
    for (const path of ['/en', '/en/no-such-page']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      );
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('strict-transport-security')).toBeNull();
    }
    const { securityHeaders } = await import('../src/security/headers.ts');
    const headers = securityHeaders(new Request('https://rezics.test/en'), 'test', `${fake.url.origin}/auth`);
    expect(headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    const tab = await page();
    try {
      await tab.route('**/frame-parent', (route) =>
        route.fulfill({ contentType: 'text/html', body: `<iframe src="${origin}/en"></iframe>` }),
      );
      await tab.goto(`${origin}/frame-parent`, { waitUntil: 'networkidle' });
      expect(tab.frames().some((frame) => frame.url() === `${origin}/en`)).toBe(false);
    } finally {
      await tab.context().close();
    }
  },
  timeout,
);

test('media downloads keep their own sandbox policy', async () => {
  const object = { size: 5, body: new Blob(['hello']).stream() };
  const env = {
    KERNEL_ORIGIN: fake.url.origin,
    MEDIA: { head: async () => object, get: async () => object },
  } as unknown as MediaEnv;
  for (const method of ['GET', 'HEAD']) {
    const response = await download(
      new Request('https://rezics.test/media/file/original', { method }),
      'file',
      'original',
      env,
    );
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }
});
