import { securityEnvelope } from './security-page-fixture';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'acct+id/秘密';
const password = 'new secure password';
const session = 'current-session-token';
const now = Date.now();

type Session = {
  id: string;
  client_id: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
};
type Call = { method: string; url: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];
const revoked = new Set<string>();
const sessions: Session[] = [
  {
    id: 'older-session',
    client_id: 'website',
    created_at: new Date(now - 4 * 86_400_000).toISOString(),
    expires_at: new Date(now + 8 * 86_400_000).toISOString(),
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    current: false,
  },
  {
    id: 'current-session',
    client_id: 'login',
    created_at: new Date(now - 86_400_000).toISOString(),
    expires_at: new Date(now + 14 * 86_400_000).toISOString(),
    user_agent: null,
    current: true,
  },
];
let signedOut = false;
let stepUpRequired = false;
let inventoryUnavailable = false;
let beforeSessions: (() => Promise<void>) | undefined;

// Copied from apps/auth/tests/recovery.test.ts's fake Auth HTTP server.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    };
    calls.push(call);
    const headers = new Headers({ 'cache-control': 'no-store' });

    if (url.pathname === '/security-page' && request.method === 'GET') {
      await beforeSessions?.();
      if (signedOut) return Response.json({}, { status: 401, headers });
      if (inventoryUnavailable) return Response.json({}, { status: 503, headers });
      return Response.json(
        securityEnvelope(
          accountId,
          sessions.filter((row) => !revoked.has(row.id)),
          [],
          !stepUpRequired,
        ),
        { headers },
      );
    }
    if (url.pathname === '/session' && request.method === 'GET') {
      if (signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
      return Response.json({ account_id: accountId }, { headers });
    }

    if (url.pathname === '/sessions' && request.method === 'GET') {
      await beforeSessions?.();
      if (signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
      if (inventoryUnavailable) return Response.json({ error: 'unavailable' }, { status: 503, headers });
      return Response.json({ sessions }, { headers });
    }

    if (url.pathname.startsWith('/credential-effects/') && request.method === 'POST') {
      if (stepUpRequired) return Response.json({ error: 'step_up_required' }, { status: 401, headers });
      if (url.pathname === '/credential-effects/stage')
        return Response.json(
          {
            effectRef: 'effect-ref',
            key: JSON.parse(call.body).key,
            subjectId: accountId,
            purpose: 'password',
            digest: 'digest',
          },
          { headers },
        );
      if (url.pathname === '/credential-effects/approve')
        return Response.json(
          { reference: 'approval-reference', expiresAt: new Date(now + 60_000).toISOString() },
          { headers },
        );
      if (url.pathname === '/credential-effects/apply')
        return Response.json({ receiptId: 'receipt-id', replayed: true }, { headers });
    }

    if (url.pathname === '/sessions/revoke' && request.method === 'POST') {
      const body = JSON.parse(call.body) as { session_id: string };
      revoked.add(body.session_id);
      if (body.session_id === 'current-session')
        headers.append('set-cookie', 'auth_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      return Response.json({}, { headers });
    }

    return new Response('Not Found', { status: 404, headers });
  },
});

// Copied from apps/web/tests/session.test.ts as used by apps/auth/tests/recovery.test.ts.
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

// Copied from apps/auth/tests/recovery.test.ts's dev-server startup and readiness check.
function site(): Promise<string> {
  started ??= (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
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
        if (child.exitCode !== null) {
          if (output.includes('Port ') && output.includes('already in use') && attempt < 3) break;
          throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
        }
        try {
          const response = await fetch(`${origin}/security`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /security in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

async function open(
  path = '/security',
  options: BrowserContextOptions = {},
  withSessionCookie = true,
  failFirstApply = false,
) {
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
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  if (failFirstApply)
    await page.addInitScript(() => {
      const nativeFetch = window.fetch;
      let failed = false;
      window.fetch = function (input, init) {
        const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!failed && new URL(requestUrl, location.href).pathname === '/credential-effects/apply') {
          failed = true;
          window.sessionStorage.setItem('security-apply-network-failure', '1');
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return nativeFetch.call(this, input, init);
      };
    });
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin, urls };
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
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function passwordForm(page: Page) {
  const input = page.getByLabel('New password', { exact: true });
  await input.waitFor({ state: 'visible' });
  expect(await input.count(), 'security settings has one labelled new password field').toBe(1);
  return { input, submit: page.getByRole('button', { name: 'Update password', exact: true }) };
}

function authCalls(path: string) {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === path);
}

function postBody(path: string, index = -1) {
  const call = authCalls(path).at(index);
  expect(call, `Auth receives ${path}`).toBeDefined();
  expect(call!.method).toBe('POST');
  expect(call!.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
  return JSON.parse(call!.body) as Record<string, unknown>;
}

test(
  'a signed-in person changes their password through the staged credential effect',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    calls.length = 0;
    revoked.clear();
    const { page, urls } = await open('/security', { timezoneId: 'America/Los_Angeles' }, true, true);
    try {
      const form = await passwordForm(page);
      expect(await form.input.getAttribute('autocomplete')).toBe('new-password');
      expect(await form.input.getAttribute('maxlength')).toBeNull();
      expect(await page.getByRole('button', { name: 'Show password', exact: true }).count()).toBe(1);
      await form.input.fill(password);
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/credential-effects/apply'),
        form.submit.click(),
      ]);
      expect(await page.getByRole('status').innerText()).toContain('Password changed');

      const stage = postBody('/credential-effects/stage');
      const approve = postBody('/credential-effects/approve');
      const apply = postBody('/credential-effects/apply');
      expect(stage).toEqual({
        key: expect.any(String),
        subjectId: accountId,
        credential: { kind: 'password', password },
      });
      expect(approve).toEqual({ key: stage.key, subjectId: accountId, effectRef: 'effect-ref' });
      expect(apply).toEqual({
        key: stage.key,
        subjectId: accountId,
        effectRef: 'effect-ref',
        reference: 'approval-reference',
      });
      expect(authCalls('/credential-effects/stage').length).toBe(1);
      expect(authCalls('/credential-effects/approve').length).toBe(1);
      expect(authCalls('/credential-effects/apply').length).toBe(1);
      expect(await page.evaluate(() => window.sessionStorage.getItem('security-apply-network-failure'))).toBe('1');
      for (const url of [...urls, page.url(), ...calls.map((call) => call.url)]) {
        expect(url).not.toContain(password);
        expect(decodeURIComponent(url.replace(/\+/g, ' '))).not.toContain(password);
      }
      expect(
        calls.filter((call) => call.method === 'GET').map((call) => new URL(call.url, fake.url).pathname),
      ).toContain('/security-page');
      expect(
        calls.filter((call) => call.method === 'GET').map((call) => new URL(call.url, fake.url).pathname),
      ).not.toContain('/sessions');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a stale session is sent to step-up and comes back to security settings',
  async () => {
    signedOut = false;
    stepUpRequired = true;
    calls.length = 0;
    revoked.clear();
    const { page, origin } = await open();
    try {
      const form = await passwordForm(page);
      await form.input.fill(password);
      await Promise.all([page.waitForURL((url) => url.pathname === '/step-up'), form.submit.click()]);
      const stepUpUrl = new URL(page.url());
      expect(stepUpUrl.searchParams.get('return_to')).toBe('/security');
      expect(page.url()).not.toContain(password);
      expect(authCalls('/credential-effects/stage')).toHaveLength(1);

      stepUpRequired = false;
      await page.goto(`${origin}/security`, { waitUntil: 'networkidle' });
      expect(await page.getByRole('heading', { name: 'Account security' }).count()).toBe(1);
      expect(await page.getByLabel('New password', { exact: true }).inputValue()).toBe('');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a person sees their sessions, the current one marked, and revokes another',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    calls.length = 0;
    revoked.clear();
    const { page } = await open('/security', { locale: 'en', timezoneId: 'America/Los_Angeles' });
    try {
      const list = page.getByRole('list', { name: 'Sessions' });
      await list.waitFor({ state: 'visible' });
      expect(await list.count()).toBe(1);
      const rows = list.getByRole('listitem');
      expect(await rows.count()).toBe(2);
      expect(await rows.first().innerText()).toContain('Unknown device');
      expect(await rows.first().innerText()).toContain('REZICS account');
      expect(await rows.first().innerText()).toContain('This device');
      expect(await rows.nth(1).innerText()).toContain('Firefox on Linux');
      expect(await rows.nth(1).innerText()).toContain('website');
      const formattedDate = new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeZone: 'America/Los_Angeles',
      }).format(new Date(sessions[0]!.created_at));
      expect(await rows.nth(1).innerText()).toContain(formattedDate);

      let confirmations = 0;
      page.on('dialog', async (dialog) => {
        confirmations++;
        expect(dialog.type()).toBe('confirm');
        await dialog.accept();
      });
      await rows.nth(1).getByRole('button', { name: 'Sign out Firefox on Linux', exact: true }).click();
      await rows.nth(1).waitFor({ state: 'detached' });
      expect(confirmations).toBe(1);
      expect(postBody('/sessions/revoke')).toEqual({ session_id: 'older-session' });
      await rows.nth(1).waitFor({ state: 'detached' });
      expect(await rows.count()).toBe(1);
      expect(authCalls('/sessions/revoke')).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'revoking the current session signs the person out',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    calls.length = 0;
    revoked.clear();
    const { page, origin } = await open();
    try {
      const current = page.getByRole('listitem').filter({ hasText: 'This device' });
      await current.waitFor({ state: 'visible' });
      expect(await current.count()).toBe(1);
      page.once('dialog', (dialog) => dialog.accept());
      await Promise.all([
        page.waitForURL(`${origin}/login`),
        current.getByRole('button', { name: 'Sign out Unknown device', exact: true }).click(),
      ]);
      expect(postBody('/sessions/revoke')).toEqual({ session_id: 'current-session' });
      expect(await page.context().cookies(origin)).not.toContainEqual(
        expect.objectContaining({ name: 'auth_session', value: session }),
      );
      expect(new URL(page.url()).pathname).toBe('/login');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, the page offers sign-in',
  async () => {
    signedOut = true;
    stepUpRequired = false;
    calls.length = 0;
    revoked.clear();
    const { page } = await open('/security', {}, false);
    try {
      const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
      await signIn.waitFor({ state: 'visible' });
      expect(await signIn.getAttribute('href')).toBe('/login');
      expect(authCalls('/security-page')).toHaveLength(1);
      expect(authCalls('/sessions')).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'Auth Security exposes one explicit read-only retry after unavailable inventory and never restores stale private authority',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    inventoryUnavailable = true;
    calls.length = 0;
    revoked.clear();
    const { page } = await open();
    try {
      await page.getByRole('alert').waitFor();
      const reload = page.getByRole('button', { name: 'Reload list', exact: true });
      expect(await reload.count()).toBe(1);
      expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/login');
      expect(await page.getByRole('list', { name: 'Sessions', exact: true }).count()).toBe(0);
      expect(await page.getByText('No active sessions were returned.', { exact: true }).count()).toBe(0);
      expect(await page.getByLabel('New password', { exact: true }).count()).toBe(0);
      expect(authCalls('/security-page')).toHaveLength(1);
      expect(authCalls('/sessions')).toHaveLength(0);

      inventoryUnavailable = false;
      await reload.click();
      const list = page.getByRole('list', { name: 'Sessions', exact: true });
      await list.waitFor();
      expect(await list.getByRole('listitem').count()).toBe(2);
      expect(await page.getByLabel('New password', { exact: true }).inputValue()).toBe('');
      expect(authCalls('/security-page')).toHaveLength(2);
      expect(authCalls('/sessions')).toHaveLength(0);
      // Identity is an existing read carried by POST; inventory recovery must send no mutation.
      expect(calls.filter((call) => call.method !== 'GET' && call.url !== '/account-identity')).toEqual([]);
      expect(authCalls('/account-identity').every((call) => call.method === 'POST' && call.body === '{}')).toBe(true);
    } finally {
      inventoryUnavailable = false;
      await page.context().close();
    }
  },
  timeout,
);

test(
  'an inventory retry shows loading, suppresses repeated clicks and keeps another unavailable read unknown',
  async () => {
    signedOut = false;
    inventoryUnavailable = true;
    calls.length = 0;
    revoked.clear();
    const { page } = await open();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const reload = page.getByRole('button', { name: 'Reload list', exact: true });
      await reload.waitFor();
      beforeSessions = async () => {
        entered.resolve();
        await release.promise;
      };
      await reload.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await entered.promise;
      await page.getByRole('status').filter({ hasText: 'Loading account information…' }).waitFor();
      expect(await page.locator('.auth-security-page').getAttribute('aria-busy')).toBe('true');
      expect(await page.getByLabel('New password', { exact: true }).count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Sessions', exact: true }).count()).toBe(0);
      expect(authCalls('/security-page')).toHaveLength(2);
      expect(authCalls('/sessions')).toHaveLength(0);

      release.resolve();
      await reload.waitFor();
      expect(await page.getByRole('alert').count()).toBe(1);
      expect(await reload.count()).toBe(1);
      expect(await page.getByText('No active sessions were returned.', { exact: true }).count()).toBe(0);
      expect(authCalls('/sessions')).toHaveLength(0);
      // Identity is an existing read carried by POST; inventory recovery must send no mutation.
      expect(calls.filter((call) => call.method !== 'GET' && call.url !== '/account-identity')).toEqual([]);
      expect(authCalls('/account-identity').every((call) => call.method === 'POST' && call.body === '{}')).toBe(true);
    } finally {
      release.resolve();
      beforeSessions = undefined;
      inventoryUnavailable = false;
      await page.context().close();
    }
  },
  timeout,
);

test(
  'an explicit inventory retry that finds a signed-out person keeps private security controls absent',
  async () => {
    signedOut = false;
    inventoryUnavailable = true;
    calls.length = 0;
    revoked.clear();
    const { page } = await open();
    try {
      const reload = page.getByRole('button', { name: 'Reload list', exact: true });
      await reload.waitFor();
      signedOut = true;
      inventoryUnavailable = false;
      await reload.click();
      await page.getByText('You are signed out. Sign in to manage your security settings.', { exact: true }).waitFor();
      expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/login');
      expect(await reload.count()).toBe(0);
      expect(await page.getByLabel('New password', { exact: true }).count()).toBe(0);
      expect(await page.getByRole('heading', { name: /^(Sessions|Passkeys)$/ }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Check current security settings', exact: true }).count()).toBe(0);
      expect(authCalls('/security-page')).toHaveLength(2);
      expect(authCalls('/sessions')).toHaveLength(0);
      // Identity is an existing read carried by POST; inventory recovery must send no mutation.
      expect(calls.filter((call) => call.method !== 'GET' && call.url !== '/account-identity')).toEqual([]);
      expect(authCalls('/account-identity').every((call) => call.method === 'POST' && call.body === '{}')).toBe(true);
    } finally {
      inventoryUnavailable = false;
      await page.context().close();
    }
  },
  timeout,
);
