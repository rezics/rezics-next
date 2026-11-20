import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';
import { inputByLabel, navigateToHydratedAuthPage } from './browser-fixture';

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
          AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue',
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
  if (path !== '/login' && path !== '/signup') {
    await context.addCookies([{ name: 'auth_session', value: session, url: origin }]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await navigateToHydratedAuthPage(page, `${origin}${path}`);
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

test(
  'submit buttons stay enabled until a request is pending, and invalid forms focus their first invalid field',
  async () => {
    const login = await open('/login');
    try {
      const button = login.page.getByRole('button', { name: 'Sign in', exact: true });
      expect(await button.isEnabled()).toBe(true);
      await button.click();
      const email = inputByLabel(login.page, 'Email');
      expect(await email.getAttribute('aria-invalid')).toBe('true');
      expect(await login.page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('email');
      expect(await email.getAttribute('aria-describedby')).toBeTruthy();

      await email.fill('reader@example.test');
      await inputByLabel(login.page, 'Password').fill('secret-password');
      let received!: () => void;
      const arrived = new Promise<void>((resolve) => (received = resolve));
      signInReceived = received;
      holdNextSignIn = true;
      releaseSignIn = undefined;
      const submit = button.click();
      await arrived;
      expect(await button.isDisabled()).toBe(true);
      releaseSignIn?.();
      await submit;
      await login.page.getByRole('alert').waitFor();
    } finally {
      releaseSignIn?.();
      await login.page.context().close();
    }

    const signup = await open('/signup');
    try {
      const button = signup.page.getByRole('button', { name: 'Create an account', exact: true });
      expect(await button.isEnabled()).toBe(true);
      await button.click();
      const handle = inputByLabel(signup.page, 'Handle');
      expect(await handle.getAttribute('aria-invalid')).toBe('true');
      expect(await signup.page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('handle');
      expect(await handle.getAttribute('aria-describedby')).toBeTruthy();
    } finally {
      await signup.page.context().close();
    }

    const security = await open('/security');
    try {
      const button = security.page.getByRole('button', { name: 'Review password change', exact: true });
      await button.waitFor({ state: 'visible' });
      expect(await button.isEnabled()).toBe(true);
      await button.click();
      const password = inputByLabel(security.page, 'New password');
      expect(await password.getAttribute('aria-invalid')).toBe('true');
      expect(await security.page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('password');
      expect(await password.getAttribute('aria-describedby')).toBeTruthy();
    } finally {
      await security.page.context().close();
    }

    const stepUp = await open('/step-up?return_to=%2Fsecurity');
    try {
      const button = stepUp.page.getByRole('button', { name: 'Verify your identity', exact: true });
      expect(await button.isEnabled()).toBe(true);
      await button.click();
      const email = inputByLabel(stepUp.page, 'Email');
      expect(await email.getAttribute('aria-invalid')).toBe('true');
      expect(await stepUp.page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('email');
      expect(await email.getAttribute('aria-describedby')).toBeTruthy();
    } finally {
      await stepUp.page.context().close();
    }
  },
  timeout,
);

test(
  'every password field has an in-field show and hide control with a localized name',
  async () => {
    const pages: { page: Page; password: ReturnType<Page['getByLabel']> }[] = [];
    const login = await open('/login');
    pages.push({ page: login.page, password: inputByLabel(login.page, 'Password') });
    const signup = await open('/signup');
    pages.push({ page: signup.page, password: inputByLabel(signup.page, 'Password') });
    const security = await open('/security');
    pages.push({ page: security.page, password: inputByLabel(security.page, 'New password') });
    const stepUp = await open('/step-up?return_to=%2Fsecurity');
    pages.push({ page: stepUp.page, password: inputByLabel(stepUp.page, 'Password') });
    const recovery = await open('/recovery#account_id=polish-account&token=polish-token');
    pages.push({ page: recovery.page, password: inputByLabel(recovery.page, 'New password') });

    try {
      for (const { page, password } of pages) {
        await password.waitFor({ state: 'visible' });
        const group = password.locator('xpath=ancestor::*[@data-slot="input-group"]');
        const show = group.getByRole('button', { name: 'Show password', exact: true });
        expect(await show.count()).toBe(1);
        expect(await show.evaluate((button) => Boolean(button.closest('[data-slot="input-group"]')))).toBe(true);
        await show.click();
        expect(await password.getAttribute('type')).toBe('text');
        expect(await group.getByRole('button', { name: 'Hide password', exact: true }).count()).toBe(1);
      }
    } finally {
      for (const { page } of pages) await page.context().close();
    }
  },
  timeout,
);

test(
  'security settings list sessions with a device, an app name and dates, and mark the current one as this device',
  async () => {
    calls.length = 0;
    const { page, origin } = await open('/security');
    try {
      const list = page.getByRole('list', { name: 'Sessions' });
      await list.waitFor();
      const sections = page.getByRole('heading', { level: 2 });
      expect(await sections.allTextContents()).toEqual([
        'Signed-in account',
        'Password',
        'Passkeys',
        'Sessions',
        'Applications you own',
        'Permissions you granted',
        'Organizations',
        'Delete account',
      ]);
      const rows = list.getByRole('listitem');
      expect(await rows.count()).toBe(4);
      const current = rows.filter({ hasText: 'Google Chrome on Linux' });
      expect(await current.getByText('REZICS account', { exact: true }).count()).toBe(1);
      expect(await current.getByText('This device', { exact: true }).count()).toBe(1);
      expect(await current.locator('time').count()).toBe(2);
      const datetimes = await current
        .locator('time')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('datetime')));
      expect(datetimes).toHaveLength(2);
      expect(datetimes.every((value) => value !== null && Number.isFinite(Date.parse(value)))).toBe(true);
      const website = rows.filter({ hasText: 'Safari on macOS' });
      expect(await website.getByText('REZICS', { exact: true }).count()).toBe(1);
      const companion = rows.filter({ hasText: 'Safari on iOS' });
      expect(await companion.getByText('REZICS Reading Companion', { exact: true }).count()).toBe(1);
      expect(await rows.filter({ hasText: 'Unknown device' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Revoke', exact: true }).count()).toBe(0);
      await current.getByRole('button', { name: 'Sign out Google Chrome on Linux', exact: true }).click();
      await page.getByRole('heading', { name: 'Review session sign-out', exact: true }).waitFor();
      await Promise.all([
        page.waitForURL(`${origin}/login`),
        page.getByRole('button', { name: 'Confirm session sign-out', exact: true }).click(),
      ]);
      expect(calls.filter((call) => call.url === '/sessions/revoke').map((call) => JSON.parse(call.body))).toEqual([
        { session_id: 'current-session' },
      ]);
      expect(await page.context().cookies(origin)).not.toContainEqual(
        expect.objectContaining({ name: 'auth_session', value: session }),
      );
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  "consent lists each scope's description before its identifier",
  async () => {
    const { page } = await open('/consent?client_id=screenshot-client&scope=openid+offline_access');
    try {
      await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
      const expected = [
        ['Identify you', 'openid'],
        ['Keep access when you are away', 'offline_access'],
      ];
      const rows = page.getByRole('listitem');
      for (const [description, identifier] of expected) {
        const row = rows.filter({ has: page.getByText(identifier, { exact: true }) });
        const order = await row.evaluate((item) => {
          const children = Array.from(item.children);
          const descriptionIndex = children.findIndex((child) => child.textContent?.trim());
          const identifierIndex = children.findIndex((child) => child.tagName === 'CODE');
          return descriptionIndex < identifierIndex;
        });
        expect(order, `${description} precedes ${identifier}`).toBe(true);
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'error alerts are danger alerts with an icon, and a failed sign-in moves focus to the alert',
  async () => {
    const { page } = await open('/login');
    try {
      await inputByLabel(page, 'Email').fill('reader@example.test');
      await inputByLabel(page, 'Password').fill('incorrect-password');
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
        page.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
      const alert = page.getByRole('alert');
      await alert.waitFor({ state: 'visible' });
      expect(await alert.getAttribute('data-slot')).toBe('alert');
      expect(await alert.evaluate((element) => element.classList.contains('text-destructive'))).toBe(true);
      expect(await alert.locator('svg').count()).toBeGreaterThan(0);
      expect(await alert.locator('[data-slot="alert-title"]').count()).toBe(1);
      expect(await alert.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the test and screenshot scripts use the private network namespace wrapper',
  async () => {
    const packageJson = await Bun.file(join(app, 'package.json')).json();
    expect(packageJson.scripts.test).toStartWith('bun scripts/isolated.ts ');
    expect(packageJson.scripts.screenshots).toStartWith('bun scripts/isolated.ts ');
    expect(await Bun.file(join(app, 'scripts/isolated.ts')).exists()).toBe(true);
  },
  timeout,
);
