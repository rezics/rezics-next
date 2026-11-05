import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Browser } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const pages = [
  '/login',
  '/signup',
  '/consent',
  '/recovery',
  '/security',
  '/step-up',
  '/account/delete',
  '/organizations/new',
];
const cookies = [
  'auth_session=opaque-session; Path=/; HttpOnly; SameSite=Lax',
  'auth_flow=opaque-flow; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly',
];
type Received = { method: string; path: string; body: string; cookie: string | null; origin: string | null };
const received: Received[] = [];

// Copied from session.test.ts's fake OpenID provider; only Auth's HTTP boundary is needed here, not token issuance.
// These are Auth echoes, not fake kernel responses.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const echo: Received = {
      method: request.method,
      path: url.pathname + url.search,
      body: Buffer.from(await request.arrayBuffer()).toString('base64'),
      cookie: request.headers.get('cookie'),
      origin: request.headers.get('origin'),
    };
    received.push(echo);
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    const status = url.pathname === '/authorize' ? 302 : url.pathname === '/token' ? 401 : 207;
    if (status === 302) headers.set('location', '/login?request=opaque');
    return Response.json(echo, { status, headers });
  },
});

// Copied from apps/web/tests/session.test.ts.
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

// Copied from session.test.ts: the documented command, with Auth's origin and an unprefixed readiness page.
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
      env: { ...process.env, AUTH_ORIGIN: fake.url.origin },
    });
    let startError: Error | undefined;
    child.on('error', (error) => {
      startError = error;
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

// Browser context and navigation steps copied from apps/web/tests/shell.test.ts.
async function open(origin: string, headers: Record<string, string>) {
  browser ??= await (await import('playwright')).chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: false,
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  const response = await page.goto(`${origin}/login`, { waitUntil: 'networkidle' });
  return { page, response };
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

// Implement apps/auth's dev command and unprefixed pages with locale negotiation to turn this into test(...).
test(
  "the documented dev command serves the sign-in page in the visitor's language",
  async () => {
    let startError: unknown;
    const origin = await site().catch((error: unknown) => {
      startError = error;
    });
    expect(startError, 'bun run dev in apps/auth starts and serves /login').toBeUndefined();

    const cases = [
      { headers: { cookie: 'rezics_locale=ja', 'accept-language': 'de' }, locale: 'ja', heading: 'ログイン' },
      { headers: { cookie: 'rezics_locale=de', 'accept-language': 'ja' }, locale: 'de', heading: 'Anmelden' },
      { headers: { 'accept-language': 'ja' }, locale: 'ja', heading: 'ログイン' },
      { headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' }, locale: 'de', heading: 'Anmelden' },
      { headers: { 'accept-language': 'ja;q=0.2,de;q=0.9' }, locale: 'de', heading: 'Anmelden' },
      { headers: { cookie: 'rezics_locale=unsupported', 'accept-language': 'ja' }, locale: 'ja', heading: 'ログイン' },
      { headers: { 'accept-language': 'unsupported' }, locale: 'en', heading: 'Sign in' },
      { headers: {}, locale: 'en', heading: 'Sign in' },
    ];
    for (const { headers, locale, heading } of cases) {
      const { page, response } = await open(origin!, headers);
      try {
        expect(response?.status(), locale).toBe(200);
        expect(page.url(), locale).toBe(`${origin}/login`);
        expect(await page.locator('html').getAttribute('lang'), locale).toBe(locale);
        expect(await page.getByRole('heading', { name: heading, exact: true }).count(), locale).toBe(1);
      } finally {
        await page.context().close();
      }
    }
    for (const locale of locales) {
      for (const headers of [
        { cookie: `rezics_locale=${locale}`, 'accept-language': 'unsupported' },
        { 'accept-language': locale },
      ]) {
        const { page, response } = await open(origin!, headers);
        try {
          expect(response?.status(), locale).toBe(200);
          expect(page.url(), locale).toBe(`${origin}/login`);
          expect(await page.locator('html').getAttribute('lang'), locale).toBe(locale);
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);

// Implement page admission by method while preserving every other Auth request byte for byte.
test(
  'root page requests and native protocol methods route by path and method',
  async () => {
    let startError: unknown;
    const origin = await site().catch((error: unknown) => {
      startError = error;
    });
    expect(startError, 'bun run dev in apps/auth starts and serves /login').toBeUndefined();

    const paths = [
      '/',
      '/.well-known/openid-configuration',
      '/jwks',
      '/authorize',
      '/token',
      '/signin',
      '/signout',
      '/session',
      '/revoke',
      '/introspect',
      '/end-session',
      '/unknown/path',
      '/ja/login',
      ...pages.flatMap((path) => [`${path}-other`, `${path}/action`]),
    ];
    const body = Buffer.from([0, 255, 13, 10, 38, 61, 43, 128]);
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
        const target = `${path}?repeat=one&repeat=two&encoded=%2f%2B&space=hello+world&empty=`;
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const expected: Received = {
          method,
          path: target,
          body: hasBody ? body.toString('base64') : '',
          cookie: 'auth_session=opaque; rezics_locale=ja; other=a%2Bb',
          origin: 'https://web.rezics.test',
        };
        const before = received.length;
        const response = await fetch(`${origin}${target}`, {
          method,
          redirect: 'manual',
          headers: { cookie: expected.cookie!, origin: expected.origin!, 'content-type': 'application/octet-stream' },
          ...(hasBody ? { body } : {}),
        });
        if (path === '/' && (method === 'GET' || method === 'HEAD')) {
          expect(received.slice(before), `${method} ${target} is a page`).toEqual([]);
          expect(response.status, `${method} ${target}`).toBe(200);
          expect(response.headers.get('content-type')).toStartWith('text/html');
          expect(response.headers.get('cache-control')).toBe('private, no-store');
          expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
          const html = await response.text();
          if (method === 'HEAD') expect(html).toBe('');
          else {
            expect(html).toContain('lang="ja"');
            expect(html).toContain('aria-current="page"');
          }
          continue;
        }
        expect(received.slice(before), `${method} ${target}`).toEqual([expected]);
        expect(response.status, `${method} ${path}`).toBe(path === '/authorize' ? 302 : path === '/token' ? 401 : 207);
        expect(response.headers.getSetCookie()).toEqual(cookies);
        if (path === '/authorize') expect(response.headers.get('location')).toBe('/login?request=opaque');
        if (method !== 'HEAD') expect(await response.json()).toEqual(expected);
        else expect(await response.text()).toBe('');
      }
    }
  },
  timeout,
);

// Serve all six Auth pages with private, no-store and framing protection to turn this into test(...).
test(
  'pages are private, no-store and cannot be framed',
  async () => {
    let startError: unknown;
    const origin = await site().catch((error: unknown) => {
      startError = error;
    });
    expect(startError, 'bun run dev in apps/auth starts and serves /login').toBeUndefined();

    for (const path of pages) {
      const before = received.length;
      const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toStartWith('text/html');
      expect(received.length, `${path} is a page, not a forwarded Auth endpoint`).toBe(before);
      expect(response.headers.get('cache-control'), path).toBe('private, no-store');
      const csp = response.headers.get('content-security-policy') ?? '';
      const deny = response.headers.get('x-frame-options')?.toUpperCase() === 'DENY';
      expect(deny || /(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/i.test(csp), path).toBe(true);
    }
  },
  timeout,
);
