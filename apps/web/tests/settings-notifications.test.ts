import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { csrfTokenFromRequest } from '../src/session/csrf';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const scopes = ['account:read', 'account:update'];
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string; sub: string };
type Family = { sub: string; current: string; revoked: boolean };
type Call = { method: string; path: string; key: string | null; contentType: string | null; body: unknown };
type Stored = {
  spoilerLevel: 0 | 1 | 2;
  suitability: 'blur' | 'show';
  notifications: Record<string, boolean>;
  version: number;
};

const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const calls: Call[] = [];
let counter = 0;
let rejectNotifications = false;
let stored: Stored;

function reset(notifications: Record<string, boolean> = { reply: true, mention: true, weekly_digest: true }) {
  calls.length = 0;
  rejectNotifications = false;
  stored = { spoilerLevel: 0, suitability: 'blur', notifications: { ...notifications }, version: 3 };
}

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...(problem ? { 'content-type': 'application/problem+json' } : {}) },
  });
function apiProblem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: 'not_applicable',
    request_id: randomUUID(),
  };
}

reset();
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return false;
      try {
        const { payload } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        if (!payload.jti || assertions.has(payload.jti)) return false;
        assertions.add(payload.jti);
        return true;
      } catch {
        return false;
      }
    };
    const issue = async (family: Family, nonce?: string) => {
      counter += 1;
      const access = `access-${counter}`;
      const refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined)
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      return json(body);
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue({ sub: grant.sub, current: '', revoked: false }, grant.nonce);
      }
      if (form.get('grant_type') === 'refresh_token') {
        const family = families.get(form.get('refresh_token') ?? '');
        if (!family || family.revoked || family.current !== form.get('refresh_token')) {
          if (family) family.revoked = true;
          return json({ error: 'invalid_grant' }, 400);
        }
        return issue(family);
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      const family = families.get(form.get('token') ?? '');
      if (family) family.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body: unknown = request.method === 'PATCH' ? await request.json() : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      key: request.headers.get('idempotency-key'),
      contentType: request.headers.get('content-type'),
      body,
    });
    if (url.pathname !== '/v1/accounts/alice/preferences') return json(apiProblem(404, 'not_found'), 404, true);
    if (request.method === 'GET') return json(stored);
    if (request.method === 'PATCH') {
      const change = body as { expectedVersion?: number; notifications?: Record<string, boolean | null> | null };
      if (change.expectedVersion !== stored.version) return json(apiProblem(409, 'conflict'), 409, true);
      if (rejectNotifications && 'notifications' in change) return json(apiProblem(400, 'invalid_request'), 400, true);
      if (change.notifications === null) {
        stored.notifications = Object.fromEntries(Object.keys(stored.notifications).map((kind) => [kind, true]));
      } else if (change.notifications) {
        for (const [kind, value] of Object.entries(change.notifications))
          stored.notifications[kind] = value === null ? true : value;
      }
      stored = { ...stored, version: stored.version + 1 };
      return json(stored);
    }
    return json(apiProblem(404, 'not_found'), 404, true);
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
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
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

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);
async function signIn(returnTo: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    sub: 'alice',
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303]).toContain(answer.status);
  return cookieValue(answer, session)!;
}

let browser: Browser | undefined;
async function readPage(path: string) {
  const cookie = await signIn(path);
  const response = await fetch(`${await site()}${path}`, { headers: { cookie: `${session}=${cookie}` } });
  return { status: response.status, html: await response.text(), cookie };
}
async function open(path: string, cookie: string, javascriptEnabled = true): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javascriptEnabled,
  });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${await site()}${path}`, { waitUntil: javascriptEnabled ? 'networkidle' : 'load' });
  if (javascriptEnabled) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 15_000 });
  return page;
}
const patches = () => calls.filter((call) => call.method === 'PATCH');
async function until(condition: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the API did not receive the write in time');
    await Bun.sleep(50);
  }
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'notification switches follow the preferences map order, use localized names and humanize unknown kinds',
  async () => {
    reset({ reply: true, mention: true, weekly_digest: true });
    const first = await readPage('/en/settings');
    expect(first.status).toBe(200);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    const page = await open('/en/settings', first.cookie!);
    const reads = calls.filter((call) => call.method === 'GET');
    expect(reads).toHaveLength(6);
    expect(reads.filter((call) => call.path === '/v1/accounts/alice/preferences')).toHaveLength(2);
    expect(reads.filter((call) => call.path === '/v1/platform/exposure')).toHaveLength(2);
    expect(reads.filter((call) => call.path === '/v1/accounts/alice/notifications/count')).toHaveLength(1);
    // The existing profile and public-activity sections share one account lookup.
    expect(reads.filter((call) => call.path === '/v1/accounts')).toHaveLength(1);
    try {
      await page.getByRole('heading', { level: 2, name: 'Notifications' }).waitFor();
      const group = page.getByRole('group', { name: 'Notifications' });
      const switches = group.getByRole('switch');
      expect(await switches.count()).toBe(3);
      expect(await switches.allTextContents()).toEqual(['', '', '']);
      expect(await switches.nth(0).getAttribute('aria-label')).toBe('Replies to your posts');
      expect(await switches.nth(1).getAttribute('aria-label')).toBe('Mentions of you');
      expect(await switches.nth(2).getAttribute('aria-label')).toBe('Weekly Digest');
      const mandatory = group.getByText('Moderation decisions about your content are always sent.');
      await mandatory.waitFor();
      expect(await mandatory.evaluate((node) => node.tagName)).toBe('P');
      expect(await mandatory.locator('[role="switch"]').count()).toBe(0);
      expect(await mandatory.evaluate((node) => node.parentElement?.lastElementChild === node)).toBe(true);
      expect(await group.getByRole('switch').count()).toBe(3);
    } finally {
      await page.context().close();
    }

    reset({ reply: true, mention: true });
    const translated = await readPage('/zh-Hans/settings');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    const chinese = await open('/zh-Hans/settings', translated.cookie!);
    try {
      await chinese.getByRole('heading', { level: 2, name: '通知' }).waitFor();
      const group = chinese.getByRole('group', { name: '通知' });
      expect(await group.getByRole('switch').nth(0).getAttribute('aria-label')).toBe('有人回复了你的帖子');
      expect(await group.getByRole('switch').nth(1).getAttribute('aria-label')).toBe('有人提到了你');
      await group.getByText('关于你内容的审核决定始终会发送。').waitFor();
    } finally {
      await chinese.context().close();
    }
  },
  timeout,
);

test(
  'changing one notification sends one merge patch and Restore defaults sends notifications null',
  async () => {
    reset({ reply: true, mention: true });
    const first = await readPage('/en/settings');
    const page = await open('/en/settings', first.cookie!);
    try {
      const group = page.getByRole('group', { name: 'Notifications' });
      const replies = group.getByRole('switch', { name: 'Replies to your posts' });
      await replies.click();
      await page.getByText('Saved', { exact: true }).waitFor();
      expect(await replies.isChecked()).toBe(false);
      expect(patches()).toHaveLength(1);
      expect(patches()[0]).toMatchObject({
        path: '/v1/accounts/alice/preferences',
        body: { expectedVersion: 3, notifications: { reply: false } },
        contentType: 'application/merge-patch+json',
      });
      expect(patches()[0]!.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(stored.notifications).toEqual({ reply: false, mention: true });

      await group.getByRole('button', { name: 'Restore defaults' }).click();
      await page.getByText('Saved', { exact: true }).waitFor();
      expect(patches()).toHaveLength(2);
      expect(patches()[1]).toMatchObject({ body: { expectedVersion: 4, notifications: null } });
      expect(stored.notifications).toEqual({ reply: true, mention: true });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a rejected notification write keeps the saved switch value and shows the error',
  async () => {
    reset({ reply: true, mention: true });
    rejectNotifications = true;
    const first = await readPage('/en/settings');
    const page = await open('/en/settings', first.cookie!);
    try {
      const replies = page.getByRole('switch', { name: 'Replies to your posts' });
      await replies.click();
      await page.getByRole('alert').getByText('Your settings were not saved').waitFor();
      expect(await replies.isChecked()).toBe(true);
      expect(stored.notifications).toEqual({ reply: true, mention: true });
      expect(patches()).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'notification preferences can be saved by the form action without JavaScript',
  async () => {
    reset({ reply: true, mention: true, weekly_digest: true });
    const first = await readPage('/en/settings');
    const page = await open('/en/settings', first.cookie!, false);
    try {
      const digest = page.getByRole('switch', { name: 'Weekly Digest' });
      await digest.click();
      const form = digest.locator('xpath=ancestor::form');
      await form.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('switch', { name: 'Weekly Digest' }).waitFor();
      expect(await page.getByRole('switch', { name: 'Weekly Digest' }).isChecked()).toBe(false);
      expect(patches()).toHaveLength(1);
      expect(patches()[0]).toMatchObject({
        body: { notifications: { weekly_digest: false } },
        contentType: 'application/merge-patch+json',
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'no-JavaScript settings writes require their session CSRF token and form tokens stay route-scoped',
  async () => {
    reset({ reply: true, mention: true });
    const firstCookie = await signIn('/en/settings');
    const otherCookie = await signIn('/en/settings');
    const firstPage = await open('/en/settings', firstCookie, false);
    const otherPage = await open('/en/settings', otherCookie, false);
    try {
      const firstToken = await firstPage.locator('input[name="csrf_token"]').first().inputValue();
      const otherToken = await otherPage.locator('input[name="csrf_token"]').first().inputValue();
      expect(firstToken).not.toBe('');
      expect(otherToken).not.toBe(firstToken);
      const origin = new URL(firstPage.url()).origin;
      const post = (token?: string) => {
        const form = new URLSearchParams({ expectedVersion: '3', notificationKind: 'reply', action: 'save' });
        if (token !== undefined) form.set('csrf_token', token);
        return fetch(`${origin}/en/settings`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            cookie: `${session}=${firstCookie}`,
            origin,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
        });
      };

      expect((await post()).status).toBe(403);
      expect(patches()).toHaveLength(0);
      expect((await post(otherToken)).status).toBe(403);
      expect(patches()).toHaveLength(0);
      expect((await post(firstToken)).status).toBe(303);
      expect(patches()).toHaveLength(1);
      expect(patches()[0]?.body).toMatchObject({ notifications: { reply: false } });
    } finally {
      await firstPage.context().close();
      await otherPage.context().close();
    }

    const token = 'A'.repeat(22);
    const formRequest = (path: string) =>
      new Request(`https://rezics.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf_token: token }).toString(),
      });
    expect(await csrfTokenFromRequest(formRequest('/auth/sign-out'))).toBe(token);
    for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'])
      expect(await csrfTokenFromRequest(formRequest(`/${locale}/settings`))).toBe(token);
    for (const path of ['/auth/sign-in', '/en/profile', '/settings', '/unknown'])
      expect(await csrfTokenFromRequest(formRequest(path))).toBeNull();
  },
  timeout,
);
