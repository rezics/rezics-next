import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const paths = [
  '/login',
  '/signup',
  '/consent',
  '/recovery',
  '/security',
  '/step-up',
  '/account/delete',
  '/organizations/new',
];
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

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

function site(): Promise<string> {
  return (started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    const env = { ...process.env, NODE_ENV: 'production', TURNSTILE_SITE_KEY: 'offline-public-key' };
    const build = spawn('bun', ['run', 'build'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    build.stdout!.on('data', keep);
    build.stderr!.on('data', keep);
    const code = await new Promise<number | null>((resolve, reject) => {
      build.once('error', reject);
      build.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`production build failed: ${output}`);
    child = spawn(
      'bun',
      ['x', '--no-install', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: app, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let startError: Error | undefined;
    child.once('error', (error) => {
      startError = error;
    });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`preview exited with ${child.exitCode}: ${output}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(60_000) });
        await response.text();
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`preview did not serve /login: ${output}`);
      await Bun.sleep(500);
    }
  })());
}

function nonce(policy: string | null): string {
  expect(policy).not.toBeNull();
  const value = /'nonce-([^']+)'/.exec(policy!)?.[1];
  expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(Buffer.from(value!, 'base64').length).toBe(16);
  return value!;
}

function directives(policy: string) {
  return Object.fromEntries(
    policy.split(';').map((part) => {
      const [key, ...values] = part.trim().split(/\s+/);
      return [key, values];
    }),
  );
}

async function page(locale = 'en') {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ extraHTTPHeaders: { 'accept-language': locale } });
  await context.addInitScript(() => {
    const state = window as unknown as { violations: string[] };
    state.violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      state.violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = {
      ready(callback) { callback(); },
      render(element, options) {
        element.dataset.action = options.action;
        element.dataset.language = options.language;
        options.callback('offline-turnstile-token');
        return 'offline-widget';
      },
      reset() {}, remove() {}
    };`,
    }),
  );
  // The production preview has no issuer backend. These are browser Auth responses, not kernel reads.
  await context.route(/\/(session|sessions|consent\/[^/?]+)(\?|$)/, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    }),
  );
  return context.newPage();
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
});

test(
  'every Auth page sends a strict nonce policy, a fresh nonce per response and the standard headers',
  async () => {
    const origin = await site();
    const seen = new Set<string>();
    await Promise.all(
      paths.flatMap((path) =>
        ['GET', 'GET', 'HEAD'].map(async (method) => {
          const response = await fetch(`${origin}${path}`, { method });
          expect(response.status).toBe(200);
          const policy = response.headers.get('content-security-policy');
          const value = nonce(policy);
          expect(seen.has(value)).toBe(false);
          seen.add(value);
          expect(directives(policy!)).toEqual({
            'default-src': ["'self'"],
            'script-src': [`'nonce-${value}'`, "'strict-dynamic'", 'https://challenges.cloudflare.com'],
            'style-src': ["'self'", `'nonce-${value}'`],
            'style-src-attr': ["'unsafe-inline'"],
            'img-src': ["'self'", 'data:'],
            'connect-src': ["'self'"],
            'frame-src': ['https://challenges.cloudflare.com'],
            'form-action': ["'self'"],
            'base-uri': ["'none'"],
            'object-src': ["'none'"],
            'frame-ancestors': ["'none'"],
            'upgrade-insecure-requests': [],
          });
          expect(response.headers.get('x-content-type-options')).toBe('nosniff');
          expect(response.headers.get('x-frame-options')).toBe('DENY');
          expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
          expect(response.headers.get('strict-transport-security')).toBeNull();
          const html = await response.text();
          if (method === 'HEAD') expect(html).toBe('');
          else {
            const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
            expect(scripts.length).toBeGreaterThan(0);
            for (const script of scripts) expect(script[1]).toContain(`nonce="${value}"`);
          }
        }),
      ),
    );
    const { securityHeaders } = await import('../src/security/headers.ts');
    const request = new Request('https://auth.rezics.test/login');
    expect(securityHeaders(request, 'test').get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(directives(securityHeaders(request, 'test', true).get('content-security-policy')!)['connect-src']).toEqual([
      "'self'",
      'wss://auth.rezics.test',
    ]);
  },
  timeout,
);

test(
  'Auth pages leak no referrer and are never cached',
  async () => {
    const origin = await site();
    const tab = await page();
    try {
      for (const path of paths) {
        const response = await tab.goto(`${origin}${path}?client_id=private&state=secret`, {
          waitUntil: 'networkidle',
        });
        expect(response!.headers()['cache-control']).toBe('private, no-store');
        expect(response!.headers()['referrer-policy']).toBe('no-referrer');
        await tab.route(`${origin}/referrer-probe`, (route) =>
          route.fulfill({ contentType: 'text/html', body: 'probe' }),
        );
        await tab.evaluate(() => {
          const link = document.createElement('a');
          link.href = '/referrer-probe';
          link.textContent = 'referrer probe';
          document.body.appendChild(link);
        });
        const request = tab.waitForRequest(`${origin}/referrer-probe`);
        await tab.getByRole('link', { name: 'referrer probe', exact: true }).click();
        expect((await request).headers()['referer']).toBeUndefined();
      }
    } finally {
      await tab.context().close();
    }
  },
  timeout,
);

test(
  "every Auth page renders and hydrates with no policy violation, sign-up's Turnstile included",
  async () => {
    const origin = await site();
    for (const locale of locales) {
      const tab = await page(locale);
      try {
        for (const path of paths) {
          const response = await tab.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
          expect(response!.status()).toBe(200);
          nonce(response!.headers()['content-security-policy'] ?? null);
          await tab.locator('html[data-hydrated]').waitFor();
          expect(await tab.locator('html').getAttribute('lang')).toBe(locale);
          expect(await tab.getByRole('heading').count()).toBeGreaterThan(0);
          if (path === '/signup') {
            await tab.locator('.auth-signup-turnstile[data-action="signup"]').waitFor({ state: 'attached' });
            expect(await tab.locator('.auth-signup-turnstile').getAttribute('data-language')).toBe(locale);
            expect(await tab.locator(`script[src="${turnstileUrl}"]`).count()).toBe(1);
            await tab.locator('#signup-handle').fill('reader');
            await tab.locator('#signup-email').fill('reader@example.test');
            await tab.locator('#signup-password').fill('correct horse battery staple');
            expect(await tab.locator('button[type="submit"]').isEnabled()).toBe(true);
          }
          expect(await tab.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
        }
      } finally {
        await tab.context().close();
      }
    }
    const tab = await page();
    try {
      await tab.route(`${origin}/login`, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({ response, body: html.replace('</head>', '<script>window.__injected=1</script></head>') });
      });
      await tab.goto(`${origin}/login`, { waitUntil: 'networkidle' });
      await tab.locator('html[data-hydrated]').waitFor();
      expect(await tab.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
      expect(await tab.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([
        'script-src-elem: inline',
      ]);
    } finally {
      await tab.context().close();
    }
  },
  timeout,
);

test(
  'passkey ceremonies stay allowed by the permissions policy',
  async () => {
    const origin = await site();
    for (const path of paths) {
      const response = await fetch(`${origin}${path}`);
      expect(response.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
      );
    }
    const tab = await page();
    try {
      await tab.goto(`${origin}/security`, { waitUntil: 'networkidle' });
      expect(
        await tab.evaluate(() => {
          const policy = (document as unknown as { featurePolicy: { allowsFeature: (name: string) => boolean } })
            .featurePolicy;
          return ['publickey-credentials-get', 'publickey-credentials-create'].map((name) =>
            policy.allowsFeature(name),
          );
        }),
      ).toEqual([true, true]);
    } finally {
      await tab.context().close();
    }
  },
  timeout,
);

test(
  'assets and unknown paths keep their own answers',
  async () => {
    const origin = await site();
    const asset = await fetch(`${origin}/auth-assets/rezics-mark.svg`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('image/svg+xml');
    expect(await asset.text()).toContain('<svg');
    expect(asset.headers.has('content-security-policy')).toBe(false);
    for (const path of ['/auth-assets/missing.js', '/unknown', '/login-other', '/signup/nested', '/en/login']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(response.headers.has('content-security-policy')).toBe(false);
      expect(response.headers.has('referrer-policy')).toBe(false);
      expect(response.headers.has('permissions-policy')).toBe(false);
    }
  },
  timeout,
);
