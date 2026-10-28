import { readSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['account:read', 'account:update'];

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = {
  challenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
  sub: string;
  expiresIn: number;
  idNonce?: string;
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
type Call = {
  method: string;
  path: string;
  authorization: string | null;
  key: string | null;
  body: unknown;
};
type Stored = { spoilerLevel: 0 | 1 | 2; suitability: 'blur' | 'show'; version: number };

const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const calls: Call[] = [];
const revocations: string[] = [];
let counter = 0;
let stored: Stored = { spoilerLevel: 0, suitability: 'blur', version: 3 };

function reset() {
  calls.length = 0;
  revocations.length = 0;
  stored = { spoilerLevel: 0, suitability: 'blur', version: 3 };
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
    effect_status: status === 409 ? 'not_applied' : 'not_applicable',
    request_id: randomUUID(),
  };
}

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
        const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        if (
          protectedHeader.kid !== clientJwk.kid ||
          payload.aud !== issuer ||
          !payload.jti ||
          assertions.has(payload.jti) ||
          !payload.exp ||
          !payload.iat ||
          payload.exp - payload.iat > 120
        )
          return false;
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
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined) {
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      }
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
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue(
          { sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false },
          grant.idNonce ?? grant.nonce,
        );
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
      revocations.push(form.get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body: unknown = request.method === 'PATCH' ? await request.json() : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      key: request.headers.get('idempotency-key'),
      body,
    });
    if (url.pathname !== '/v1/accounts/alice/preferences') return json(apiProblem(404, 'not_found'), 404, true);
    if (request.method === 'GET') return json(stored);
    if (request.method === 'PATCH') {
      const change = body as Partial<Stored> & { expectedVersion: number };
      if (change.expectedVersion !== stored.version) return json(apiProblem(409, 'conflict'), 409, true);
      const next = { ...stored, ...change, version: stored.version + 1 } as Stored & { expectedVersion?: number };
      delete next.expectedVersion;
      stored = next;
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
        API_RESOURCE: resource,
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

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]!
    .slice(name.length + 1);
async function signIn(returnTo: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location')!);
  const params = location.searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: 'alice',
    expiresIn: 3600,
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  return cookieValue(answer, session)!;
}

let browser: Browser | undefined;
async function readPage(path: string, signedIn = true) {
  const cookie = signedIn ? await signIn(path) : undefined;
  const response = await fetch(`${await site()}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  return { status: response.status, html: await response.text(), cookie, location: response.headers.get('location') };
}
async function readWithCookie(path: string, cookie: string) {
  const response = await fetch(`${await site()}${path}`, {
    redirect: 'manual',
    headers: { cookie: `${session}=${cookie}` },
  });
  return { status: response.status, html: await response.text(), location: response.headers.get('location') };
}
async function open(path: string, cookie: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  const url = `${await site()}${path}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(url, { waitUntil: 'networkidle' });
    try {
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 15_000 });
      await page.waitForFunction(() => {
        const radios = document.querySelectorAll('[role="radio"]');
        return radios.length === 3 && radios[0]?.getAttribute('aria-disabled') !== 'true';
      });
      return page;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return page;
}
function main(html: string) {
  return /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
}
function hrefFor(html: string, label: string) {
  const anchor = [...main(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find(
    (match) => match[2]!.replace(/<[^>]+>/g, '').trim() === label,
  );
  return anchor ? /href="([^"]*)"/.exec(anchor[1]!)?.[1]?.replaceAll('&amp;', '&') : undefined;
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the API did not receive the write in time');
    await Bun.sleep(50);
  }
}
const patches = () => calls.filter((call) => call.method === 'PATCH');

async function openWithoutScripts(path: string, cookie: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, javaScriptEnabled: false });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${await site()}${path}`, { waitUntil: 'load' });
  return page;
}

test(
  'a signed-in person sees and changes their spoiler level and cover suitability, saved with the version they read',
  async () => {
    reset();
    const first = await readPage('/en/settings');
    expect(first.status).toBe(200);
    const body = main(first.html);
    expect(body).toContain('Settings');
    // Each level says what it hides, and the suitability setting says what showing covers means.
    expect(body).toContain('Hide all spoilers');
    expect(body).toContain('Show minor spoilers');
    expect(body).toContain('Show all spoilers');
    expect(body).toMatch(/Minor and major spoilers stay behind a reveal control/);
    expect(body).toMatch(/Major spoilers stay behind a reveal control/);
    expect(body).toMatch(/Minor and major spoilers appear without a reveal control/);
    expect(body).toContain('Show covers withheld for suitability');
    expect(body).toMatch(/blurred behind a label/);
    // One preferences read for the page, made for the signed-in account with its bearer credential.
    const reads = calls.filter((call) => call.method === 'GET');
    expect(reads).toEqual([
      expect.objectContaining({ path: '/v1/accounts/alice/preferences', authorization: 'Bearer access-1' }),
    ]);

    const page = await open('/en/settings', first.cookie!);
    try {
      const none = page.getByRole('radio', { name: 'Hide all spoilers' });
      const minor = page.getByRole('radio', { name: 'Show minor spoilers' });
      const major = page.getByRole('radio', { name: 'Show all spoilers' });
      const suitability = page.getByRole('switch', { name: 'Show covers withheld for suitability' });
      await none.waitFor();
      expect(await none.getAttribute('aria-checked')).toBe('true');
      expect(await suitability.getAttribute('aria-checked')).toBe('false');
      expect(await major.isEnabled()).toBe(true);

      await minor.click();
      await page.getByText('Saved', { exact: true }).waitFor();
      expect(await minor.getAttribute('aria-checked')).toBe('true');
      expect(patches()).toHaveLength(1);
      expect(patches()[0]).toMatchObject({
        path: '/v1/accounts/alice/preferences',
        body: { expectedVersion: 3, spoilerLevel: 1 },
      });
      expect(patches()[0]!.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(stored).toEqual({ spoilerLevel: 1, suitability: 'blur', version: 4 });

      await suitability.click();
      // The write reaches the API, then the page settles with the controls enabled again.
      await until(() => stored.version === 5);
      await page.waitForFunction(() => !document.querySelector('[role=switch][disabled]'));
      expect(await suitability.getAttribute('aria-checked')).toBe('true');
      expect(patches()).toHaveLength(2);
      expect(patches()[1]).toMatchObject({ body: { expectedVersion: 4, suitability: 'show' } });
      expect(patches()[1]!.key).not.toBe(patches()[0]!.key);
      expect(stored).toEqual({ spoilerLevel: 1, suitability: 'show', version: 5 });
    } finally {
      await page.context().close();
    }

    const again = await readWithCookie('/en/settings', first.cookie!);
    expect(again.status).toBe(200);
    const html = main(again.html);
    const titleOf = (id: string) => new RegExp(`id="${id}">([^<]*)<`).exec(html)?.[1];
    const radios = [...html.matchAll(/role="radio"[^>]*aria-checked="(true|false)"[^>]*aria-labelledby="([^"]+)"/g)];
    expect(radios.filter((radio) => radio[1] === 'true').map((radio) => titleOf(radio[2]!))).toEqual([
      'Show minor spoilers',
    ]);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
  },
  timeout,
);

test(
  'a stale version keeps the person’s choice and offers to reload',
  async () => {
    reset();
    const first = await readPage('/en/settings');
    const page = await open('/en/settings', first.cookie!);
    try {
      const none = page.getByRole('radio', { name: 'Hide all spoilers' });
      const minor = page.getByRole('radio', { name: 'Show minor spoilers' });
      const major = page.getByRole('radio', { name: 'Show all spoilers' });
      await none.waitFor();
      // Another device changed the settings after this page read version 3.
      stored = { spoilerLevel: 2, suitability: 'blur', version: 4 };
      await minor.click();
      await page.getByRole('alert').getByText('Your settings changed elsewhere').waitFor();
      expect(patches()).toHaveLength(1);
      expect(patches()[0]).toMatchObject({ body: { expectedVersion: 3, spoilerLevel: 1 } });
      // The stale write changed nothing, and the person's choice is still what the page shows.
      expect(stored).toEqual({ spoilerLevel: 2, suitability: 'blur', version: 4 });
      expect(await minor.getAttribute('aria-checked')).toBe('true');

      await page.getByRole('button', { name: 'Reload' }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      expect(await major.getAttribute('aria-checked')).toBe('true');
      expect(await minor.getAttribute('aria-checked')).toBe('false');

      // After reloading, the next change carries the version just read.
      await none.click();
      await page.getByText('Saved', { exact: true }).waitFor();
      expect(patches()).toHaveLength(2);
      expect(patches()[1]).toMatchObject({ body: { expectedVersion: 4, spoilerLevel: 0 } });
      expect(stored).toEqual({ spoilerLevel: 0, suitability: 'blur', version: 5 });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the page links to account security on the Auth site and signs out',
  async () => {
    reset();
    const first = await readPage('/en/settings');
    const content = main(first.html);
    expect(hrefFor(first.html, 'Security settings')).toBe(`${fake.url.origin}/security`);
    const form = /<form\b[^>]*action="\/auth\/sign-out"[^>]*>([\s\S]*?)<\/form>/.exec(content);
    expect(form, 'a sign-out form on the page').toBeTruthy();
    expect(form![0]).toMatch(/method="post"/i);
    expect(form![1]).toMatch(/>\s*Sign out\s*</);
    const token = await readSessionToken(await site(), `${session}=${first.cookie}`);
    expect(token, 'the form carries the session’s CSRF token').toBeTruthy();
    expect(first.html).not.toContain('name="csrf-token"');

    const origin = await site();
    const answer = await fetch(`${origin}/auth/sign-out`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${session}=${first.cookie}`, origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: token! }),
    });
    expect([302, 303]).toContain(answer.status);
    expect(answer.headers.get('location')).toStartWith(`${fake.url.origin}/auth/end-session`);
    expect(revocations).toHaveLength(1);
    const ended = await readWithCookie('/en/settings', first.cookie!);
    expect(main(ended.html)).not.toContain('Hide all spoilers');
    expect(ended.status).toBe(302);
    expect(ended.location).toBe('/auth/sign-in?return_to=%2Fen%2Fsettings');
  },
  timeout,
);

test(
  'signed out, settings redirects to sign-in; without JavaScript the controls are disabled',
  async () => {
    reset();
    const out = await readPage('/en/settings', false);
    expect(out.status).toBe(302);
    expect(out.location).toBe('/auth/sign-in?return_to=%2Fen%2Fsettings');
    expect(main(out.html)).not.toContain('role="radio"');
    expect(calls).toHaveLength(0);

    const cookie = await signIn('/en/settings');
    const page = await openWithoutScripts('/en/settings', cookie);
    try {
      const radios = page.getByRole('radio');
      expect(await radios.count()).toBe(3);
      for (let index = 0; index < 3; index += 1) expect(await radios.nth(index).isDisabled()).toBe(true);
      expect(await page.getByRole('switch').isDisabled()).toBe(true);
      // Nothing can be changed, so nothing is written.
      expect(patches()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
