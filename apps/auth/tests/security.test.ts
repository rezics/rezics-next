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
let refuseNextStage = false;
let refuseNextApply = false;
let approvalLifetimeMs = 60_000;
const acceptedApplyKeys = new Set<string>();
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
    if (url.pathname === '/registration-page' && request.method === 'GET')
      return Response.json(
        {
          kind: 'already-signed-in',
          viewer: { account_id: accountId },
          requirements: {
            handle: { minLength: 3, maxLength: 64 },
            email: { maxLength: 254 },
            password: { minLength: 8, maxLength: 128 },
            verification: { provider: 'turnstile', required: true },
          },
          verification: { configured: false },
          actions: { register: false, continue: true },
        },
        { headers },
      );

    if (url.pathname === '/sessions' && request.method === 'GET') {
      await beforeSessions?.();
      if (signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
      if (inventoryUnavailable) return Response.json({ error: 'unavailable' }, { status: 503, headers });
      return Response.json({ sessions }, { headers });
    }

    if (url.pathname.startsWith('/credential-effects/') && request.method === 'POST') {
      if (stepUpRequired)
        return Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401, headers });
      if (url.pathname === '/credential-effects/stage' && refuseNextStage) {
        refuseNextStage = false;
        return Response.json(
          { error: 'credential_effect_denied', effect_status: 'not_applied' },
          { status: 409, headers },
        );
      }
      if (url.pathname === '/credential-effects/stage')
        return Response.json(
          {
            effectRef: 'effect-ref',
            key: JSON.parse(call.body).key,
            subjectId: accountId,
            purpose: 'set-password',
            digest: 'a'.repeat(64),
          },
          { headers },
        );
      if (url.pathname === '/credential-effects/approve')
        return Response.json(
          { reference: 'approval-reference', expiresAt: new Date(Date.now() + approvalLifetimeMs).toISOString() },
          { headers },
        );
      if (url.pathname === '/credential-effects/apply' && refuseNextApply) {
        refuseNextApply = false;
        return Response.json(
          { error: 'credential_effect_denied', effect_status: 'not_applied' },
          { status: 409, headers },
        );
      }
      if (url.pathname === '/credential-effects/apply') {
        const key = String(JSON.parse(call.body).key);
        const replayed = acceptedApplyKeys.has(key);
        acceptedApplyKeys.add(key);
        return Response.json({ receiptId: 'receipt-id', replayed }, { headers });
      }
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
  applyFailure: false | 'before' | 'after' = false,
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
  if (applyFailure)
    await page.addInitScript((mode) => {
      const attempts: { path: string; body: unknown }[] = [];
      Object.defineProperty(window, '__passwordChangeAttempts', { value: attempts });
      const nativeFetch = window.fetch;
      let failed = false;
      window.fetch = function (input, init) {
        const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(requestUrl, location.href).pathname;
        if (path === '/credential-effects/apply')
          attempts.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
        if (!failed && path === '/credential-effects/apply' && mode === 'before') {
          failed = true;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        const response = nativeFetch.call(this, input, init);
        if (!failed && path === '/credential-effects/apply' && mode === 'after') {
          failed = true;
          return response.then(() => Promise.reject(new TypeError('Failed to fetch')));
        }
        return response;
      };
    }, applyFailure);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
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
  return {
    input,
    confirmation: page.getByLabel('Confirm password', { exact: true }),
    review: page.getByRole('button', { name: 'Review password change', exact: true }),
    confirm: page.getByRole('button', { name: 'Confirm password change', exact: true }),
  };
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
  'a signed-in person reviews the exact target and native effects before changing their password',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    inventoryUnavailable = false;
    approvalLifetimeMs = 60_000;
    refuseNextStage = false;
    refuseNextApply = false;
    acceptedApplyKeys.clear();
    calls.length = 0;
    revoked.clear();
    const { page, urls } = await open('/security', { timezoneId: 'America/Los_Angeles' });
    try {
      const form = await passwordForm(page);
      expect(await form.input.getAttribute('autocomplete')).toBe('new-password');
      expect(authCalls('/registration-page')).toHaveLength(1);
      expect(await form.input.getAttribute('maxlength'), await page.locator('#security-password-help').innerText()).toBe(
        '128',
      );
      expect(await form.confirmation.getAttribute('autocomplete')).toBe('new-password');
      expect(await page.getByRole('button', { name: 'Show password', exact: true }).count()).toBe(2);
      await form.input.fill(password);
      await form.confirmation.fill(password);
      await form.review.click();
      await page.getByRole('heading', { name: 'Review this password change' }).waitFor();
      expect(await page.locator('body').innerText()).toContain(accountId);
      expect(await page.locator('body').innerText()).toContain('Auth signs out all sessions, including this one.');
      expect(await page.locator('body').innerText()).not.toContain(password);
      expect(authCalls('/credential-effects/stage')).toHaveLength(0);
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/credential-effects/apply'),
        form.confirm.click(),
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
      expect(approve).toEqual({
        key: stage.key,
        subjectId: accountId,
        effectRef: 'effect-ref',
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      });
      expect(apply).toEqual({
        key: stage.key,
        subjectId: accountId,
        effectRef: 'effect-ref',
        purpose: 'set-password',
        digest: 'a'.repeat(64),
        reference: 'approval-reference',
      });
      expect(stage).not.toHaveProperty('confirmation');
      expect(authCalls('/credential-effects/stage').length).toBe(1);
      expect(authCalls('/credential-effects/approve').length).toBe(1);
      expect(authCalls('/credential-effects/apply').length).toBe(1);
      expect(await page.context().cookies()).not.toContainEqual(expect.objectContaining({ value: password }));
      expect(await page.evaluate(() => [window.localStorage.length, window.sessionStorage.length])).toEqual([0, 0]);
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
      expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/login');
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
    acceptedApplyKeys.clear();
    calls.length = 0;
    revoked.clear();
    const { page, origin } = await open();
    try {
      const form = await passwordForm(page);
      await form.input.fill(password);
      await form.confirmation.fill(password);
      await Promise.all([page.waitForURL((url) => url.pathname === '/step-up'), form.review.click()]);
      const stepUpUrl = new URL(page.url());
      expect(stepUpUrl.searchParams.get('return_to')).toBe('/security');
      expect(page.url()).not.toContain(password);
      expect(authCalls('/credential-effects/stage')).toHaveLength(0);

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
  'an allowed review handles a later native refusal as definitive without step-up navigation',
  async () => {
    signedOut = false;
    stepUpRequired = false;
    refuseNextStage = false;
    refuseNextApply = false;
    calls.length = 0;
    acceptedApplyKeys.clear();
    const { page, origin } = await open();
    try {
      const form = await passwordForm(page);
      await form.input.fill(password);
      await form.confirmation.fill(password);
      refuseNextStage = true;
      await form.review.click();
      await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/credential-effects/stage' && response.status() === 409,
        ),
        form.confirm.click(),
      ]);
      await page.getByText('Auth refused this step and reported that it was not applied.', { exact: false }).waitFor();
      expect(new URL(page.url()).pathname).toBe('/security');
      expect(page.url()).toContain(origin);
      expect(authCalls('/credential-effects/stage')).toHaveLength(1);
      expect(authCalls('/credential-effects/approve')).toHaveLength(0);
      expect(authCalls('/credential-effects/apply')).toHaveLength(0);
    } finally {
      refuseNextStage = false;
      await page.context().close();
    }
  },
  timeout,
);

test.each(['before', 'after'] as const)(
  'lost apply acknowledgement (%s dispatch) stays unknown until a deliberate exact retry',
  async (loss) => {
    signedOut = false;
    stepUpRequired = false;
    refuseNextStage = false;
    refuseNextApply = false;
    calls.length = 0;
    acceptedApplyKeys.clear();
    approvalLifetimeMs = loss === 'after' ? 500 : 60_000;
    const { page } = await open('/security', {}, true, loss);
    try {
      const form = await passwordForm(page);
      await form.input.fill(password);
      await form.confirmation.fill(password);
      await form.review.click();
      await form.confirm.click();
      await page.getByText('Auth did not confirm whether the password changed.', { exact: false }).waitFor();
      await page.waitForTimeout(100);
      expect(
        await page.evaluate(
          () => (window as Window & { __passwordChangeAttempts?: Array<{ body: unknown }> }).__passwordChangeAttempts,
        ),
      ).toHaveLength(1);
      expect(authCalls('/credential-effects/apply')).toHaveLength(loss === 'after' ? 1 : 0);
      const original = await page.evaluate(
        () => (window as Window & { __passwordChangeAttempts?: Array<{ body: unknown }> }).__passwordChangeAttempts?.[0]?.body,
      );

      if (loss === 'before') {
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/credential-effects/apply'),
          page.getByRole('button', { name: 'Retry original attempt', exact: true }).click(),
        ]);
        expect(await page.getByRole('status').innerText()).toContain('Password changed');
        expect(authCalls('/credential-effects/apply')).toHaveLength(1);
      } else {
        await page.waitForTimeout(550);
        refuseNextApply = true;
        await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/credential-effects/apply' && response.status() === 409,
          ),
          page.getByRole('button', { name: 'Retry original attempt', exact: true }).click(),
        ]);
        await page.getByText('A refusal now cannot tell whether an earlier apply changed the password.', { exact: false }).waitFor();
        await page
          .getByRole('status')
          .filter({ hasText: 'Auth did not confirm whether the password changed.' })
          .waitFor();
        expect(
          await page.getByRole('status').filter({ hasText: 'Auth did not confirm whether the password changed.' }).count(),
        ).toBe(1);
        expect(authCalls('/credential-effects/apply')).toHaveLength(2);
      }

      const attempts = await page.evaluate(
        () => (window as Window & { __passwordChangeAttempts?: Array<{ body: unknown }> }).__passwordChangeAttempts,
      );
      expect(attempts).toHaveLength(2);
      expect(attempts?.[0]?.body).toEqual(original);
      expect(attempts?.[1]?.body).toEqual(original);
      for (const call of authCalls('/credential-effects/apply'))
        expect(JSON.parse(call.body)).toEqual(original);
      if (loss === 'after') expect(acceptedApplyKeys.has((original as { key: string }).key)).toBe(true);
    } finally {
      refuseNextApply = false;
      approvalLifetimeMs = 60_000;
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
