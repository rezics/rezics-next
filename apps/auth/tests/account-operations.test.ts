import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { createFakeAuthState, startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'screenshot-account';
const session = 'account-operation-session';
const calls: FakeAuthRequest[] = [];
const state = createFakeAuthState();
const fake = startFakeAuth({ state, onRequest: (request) => calls.push(request) });

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
let issuerOrigin = '';

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
      env: { ...process.env, AUTH_ORIGIN: fake.url.origin, PRIVACY_CONTACT_URL: 'mailto:privacy@example.test' },
    });
    let startError: Error | undefined;
    child.on('error', (error) => (startError = error));
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    issuerOrigin = origin;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 200) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(
  path: string,
  options: BrowserContextOptions = {},
  withSessionCookie = true,
): Promise<{ page: Page; origin: string }> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...options,
    javaScriptEnabled: true,
  });
  if (withSessionCookie)
    await context.addCookies([
      { name: 'auth_session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    expect(response?.status(), `the documented dev server serves ${path}`).toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function authCalls(path: string): FakeAuthRequest[] {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === path);
}

function postBodies(path: string): Record<string, unknown>[] {
  return authCalls(path).map((call) => {
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
    expect(call.headers.origin).toBe(issuerOrigin);
    return JSON.parse(call.body) as Record<string, unknown>;
  });
}

function reset(overrides: Partial<typeof state> = {}) {
  calls.length = 0;
  Object.assign(state, {
    signedOut: false,
    sessionFresh: true,
    signInSucceeds: false,
    organizationsOpen: true,
    denyAccountOperation: false,
    dropFirstExecuteResponse: false,
    sessionCount: 4,
    organizationCount: 1,
    ...overrides,
  });
}

async function confirmDelete(page: Page) {
  await page.getByRole('checkbox', { name: 'I understand that this cannot be undone', exact: true }).check();
  return page.getByRole('button', { name: 'Delete account', exact: true });
}

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'a signed-in person deletes their account after confirming, sees it was deleted, and is signed out',
  async () => {
    reset();
    const { page, origin } = await open('/account/delete');
    try {
      await page.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
      await page.getByRole('checkbox').waitFor({ state: 'visible' });
      expect(await page.getByText(/permanently deletes your REZICS account/i).count()).toBe(1);
      expect(await page.getByText(/signs you out everywhere/i).count()).toBe(1);
      expect(await page.getByText(/cannot be undone/i).count()).toBeGreaterThan(0);
      expect(await page.getByText(/no automated accounts are operated by this account/i).count()).toBe(1);
      expect(await page.getByText(/not the last owner of any organization/i).count()).toBe(1);
      expect(await page.getByText(/no transfer is pending/i).count()).toBe(1);

      const button = page.getByRole('button', { name: 'Delete account', exact: true });
      expect(await button.isEnabled()).toBe(true);
      const submit = await confirmDelete(page);
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
        ),
        submit.click(),
      ]);
      expect(await page.getByRole('status').innerText()).toContain('Your account has been deleted');
      expect(await page.getByRole('button').count()).toBe(0);
      expect(await page.context().cookies(origin)).not.toContainEqual(
        expect.objectContaining({ name: 'auth_session', value: session }),
      );

      expect(authCalls('/session')).toHaveLength(1);
      expect(postBodies('/account-operations/approve')).toEqual([
        { operationKey: expect.any(String), operation: { kind: 'delete', accountId } },
      ]);
      expect(postBodies('/account-operations/execute')).toEqual([
        {
          operationKey: postBodies('/account-operations/approve')[0]!.operationKey,
          operation: { kind: 'delete', accountId },
          reference: 'approval-' + postBodies('/account-operations/approve')[0]!.operationKey,
        },
      ]);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'deleting without a fresh sign-in goes through step-up and returns to the delete page',
  async () => {
    reset({ sessionFresh: false, signInSucceeds: true });
    const { page, origin } = await open('/account/delete');
    try {
      await page.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
      const submit = await confirmDelete(page);
      await Promise.all([page.waitForURL((url) => url.pathname === '/step-up'), submit.click()]);
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      expect(new URL(page.url()).searchParams.get('return_to')).toBe('/account/delete');
      expect(authCalls('/account-operations/approve')).toHaveLength(1);
      expect(authCalls('/account-operations/execute')).toHaveLength(0);

      await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
      await page.getByLabel('Password', { exact: true }).fill('secure-password');
      await Promise.all([
        page.waitForURL((url) => url.origin === origin && url.pathname === '/account/delete'),
        page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
      ]);
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      await page.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
      await page.getByRole('checkbox').waitFor({ state: 'visible' });
      expect(state.sessionFresh).toBe(true);
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a refused deletion lists what must be done first and deletes nothing',
  async () => {
    reset({ denyAccountOperation: true });
    const { page } = await open('/account/delete');
    try {
      await page.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
      const submit = await confirmDelete(page);
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/account-operations/approve'),
        submit.click(),
      ]);
      const alert = page.getByRole('alert');
      await alert.waitFor();
      expect(await alert.innerText()).toContain('This account cannot be deleted yet');
      expect(await alert.innerText()).toContain('Complete the items listed above first.');
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
      expect(state.signedOut).toBe(false);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a retry after a lost response reuses the same operation key',
  async () => {
    reset({ dropFirstExecuteResponse: true });
    const { page } = await open('/account/delete');
    try {
      await page.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
      const submit = await confirmDelete(page);
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
        ),
        submit.click(),
      ]);
      expect(await page.getByRole('status').innerText()).toContain('Your account has been deleted');
      const approve = postBodies('/account-operations/approve')[0]!;
      const executes = postBodies('/account-operations/execute');
      expect(executes).toHaveLength(2);
      expect(executes.map((body) => body.operationKey)).toEqual([approve.operationKey, approve.operationKey]);
      expect(executes.map((body) => body.operation)).toEqual([
        { kind: 'delete', accountId },
        { kind: 'delete', accountId },
      ]);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a person creates an organization with a normalized handle and sees it created',
  async () => {
    reset();
    const { page } = await open('/organizations/new');
    try {
      await page.getByRole('heading', { name: 'Create an organization', exact: true }).waitFor();
      const handle = page.getByLabel('Handle', { exact: true });
      await handle.fill('Team-Alpha');
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
        ),
        page.getByRole('button', { name: 'Create organization', exact: true }).click(),
      ]);
      expect(await page.getByRole('status').innerText()).toContain('@team-alpha');
      expect(await page.getByRole('link', { name: 'Account security', exact: true }).getAttribute('href')).toBe(
        '/security',
      );
      const approve = postBodies('/account-operations/approve')[0]!;
      expect(approve).toEqual({
        operationKey: expect.any(String),
        operation: { kind: 'organization', handle: 'team-alpha' },
      });
      expect(postBodies('/account-operations/execute')[0]).toEqual({
        operationKey: approve.operationKey,
        operation: { kind: 'organization', handle: 'team-alpha' },
        reference: 'approval-' + approve.operationKey,
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'creating an organization while it is closed says so and keeps the handle',
  async () => {
    reset({ organizationsOpen: false });
    const { page } = await open('/organizations/new');
    try {
      await page.getByRole('heading', { name: 'Create an organization', exact: true }).waitFor();
      const handle = page.getByLabel('Handle', { exact: true });
      await handle.fill('kept-handle');
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/account-operations/approve' && response.status() === 403,
        ),
        page.getByRole('button', { name: 'Create organization', exact: true }).click(),
      ]);
      expect(await page.getByRole('alert').innerText()).toContain('This part of REZICS is not open yet.');
      expect(await handle.inputValue()).toBe('kept-handle');
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'security settings link to creating an organization and deleting the account',
  async () => {
    reset();
    const { page } = await open('/security');
    try {
      await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Organizations', exact: true }).waitFor();
      expect(await page.getByRole('heading', { name: 'Organizations', exact: true }).count()).toBe(1);
      expect(await page.getByRole('link', { name: 'Create organization', exact: true }).getAttribute('href')).toBe(
        '/organizations/new',
      );
      expect(await page.getByRole('heading', { name: 'Delete account', exact: true }).count()).toBe(1);
      expect(await page.getByRole('link', { name: 'Delete account', exact: true }).getAttribute('href')).toBe(
        '/account/delete',
      );
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'both account-operation pages offer sign-in when signed out',
  async () => {
    reset({ signedOut: true });
    for (const [path, heading] of [
      ['/account/delete', 'Delete your account'],
      ['/organizations/new', 'Create an organization'],
    ]) {
      const { page } = await open(path, {}, false);
      try {
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/login');
        expect(authCalls('/account-operations/approve')).toHaveLength(0);
        expect(authCalls('/account-operations/execute')).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
