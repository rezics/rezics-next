import AxeBuilder from '@axe-core/playwright';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const session = 'polish-current-session';
const calls: FakeAuthRequest[] = [];
let holdNextSignIn = false;
let signInReceived: (() => void) | undefined;
let releaseSignIn: (() => void) | undefined;

const turnstileScript = `(() => {
  let serial = 0;
  window.turnstile = {
    ready(fn) { fn(); },
    render(_element, options) { window.__turnstileOptions = options; return 'widget-' + (++serial); },
    reset() {},
    remove() {},
  };
})();`;

const turnstile = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/api.js')
      return new Response(turnstileScript, { headers: { 'content-type': 'text/javascript' } });
    return new Response('Not Found', { status: 404 });
  },
});

const fake = startFakeAuth({
  async onRequest(request) {
    calls.push(request);
    if (request.method === 'POST' && request.url === '/signin' && holdNextSignIn) {
      holdNextSignIn = false;
      signInReceived?.();
      await new Promise<void>((resolve) => {
        releaseSignIn = resolve;
      });
    }
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

function site(): Promise<string> {
  started ??= (async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
          AUTH_ORIGIN: fake.url.origin,
          TURNSTILE_SITE_KEY: 'polish-test-site-key',
          TURNSTILE_SCRIPT_URL: `${turnstile.url.origin}/api.js`,
        },
      });
      let startError: Error | undefined;
      child.on('error', (error) => (startError = error));
      child.stdout!.on('data', keep);
      child.stderr!.on('data', keep);
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 150_000;
      for (;;) {
        if (startError) throw startError;
        if (child.exitCode !== null) {
          if (output.includes('Port ') && output.includes('already in use') && attempt < 3) break;
          throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
        }
        try {
          const response = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

async function open(path = '/login', options: BrowserContextOptions = {}) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    timezoneId: 'UTC',
    ...options,
    javaScriptEnabled: true,
  });
  await context.addCookies([{ name: 'auth_session', value: session, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin };
  } catch (error) {
    await context.close();
    throw error;
  }
}

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  turnstile.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const pages = [
  ['/login', 'input[name="email"]'],
  ['/signup', 'input[name="handle"]'],
  ['/step-up?return_to=%2Fsecurity', 'input[name="email"]'],
  ['/recovery', 'input[name="email"]'],
  ['/recovery#account_id=screenshot-account&token=screenshot-token', 'input[type="password"]'],
  ['/consent?client_id=screenshot-client&scope=openid+offline_access', 'main button[type="button"]'],
  ['/security', 'input[name="password"]'],
  ['/account/delete', 'input[type="text"]'],
  ['/organizations/new', 'input[name="handle"]'],
] as const;

test('no Auth page imports a legacy @rezics/ui component that has a shadcn counterpart', () => {
  const source = join(app, 'src');
  const files = [
    ...readdirSync(source)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => join(source, name)),
    ...readdirSync(join(source, 'routes'))
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => join(source, 'routes', name)),
  ];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from ['"]@rezics\/ui\/([^'"]+)['"]/g)) {
      expect(match[1] === 'utils' || match[1]!.startsWith('shadcn/'), file).toBe(true);
    }
  }
});

test(
  'sign-in, sign-up, step-up, recovery, consent, security, delete account and create organization render their forms from shadcn field, input, button and alert',
  async () => {
    for (const [path, ready] of pages) {
      const { page } = await open(path);
      try {
        await page.locator(ready).first().waitFor();
        expect(await page.locator('[data-slot="card"]').count(), path).toBeGreaterThan(0);
        const controls = page.locator('main input:not([type="hidden"]):not([aria-hidden="true"]), main button');
        for (const control of await controls.all()) {
          expect(['input', 'input-group-control', 'button', 'checkbox'], path).toContain(
            await control.getAttribute('data-slot'),
          );
        }
        for (const input of await page.locator('main input:not([type="hidden"]):not([type="checkbox"])').all()) {
          expect(await input.locator('xpath=ancestor::*[@data-slot="field"]').count(), path).toBeGreaterThan(0);
        }
        if (path === '/login') {
          await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
          await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await page.getByRole('alert').waitFor();
          expect(await page.getByRole('alert').getAttribute('data-slot')).toBe('alert');
        }
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test('every Auth page has no accessibility violations in either theme at phone and desktop widths', async () => {
  for (const locale of ['en', 'zh-Hans']) {
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const width of [390, 1280]) {
        for (const [path, ready] of pages) {
          const { page } = await open(path, {
            colorScheme,
            viewport: { width, height: 900 },
            locale,
            extraHTTPHeaders: { 'Accept-Language': locale },
          });
          try {
            await page.locator(ready).first().waitFor();
            await page.evaluate(() => document.fonts.ready);
            const result = await new AxeBuilder({ page }).analyze();
            expect(result.violations, `${path} ${locale} ${colorScheme} ${width}`).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
          } finally {
            await page.context().close();
          }
        }
      }
    }
  }
}, 900_000);
