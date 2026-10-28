import { readSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { KernelClient } from '@rezics/client';
import { chromium, type Browser } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

type ReadResult = Awaited<ReturnType<ReturnType<KernelClient['media']>['get']>>;
type KernelProblem = NonNullable<ReadResult['error']>['value'];

const secondOrigin = 'https://www.rezics.test';
const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
// The API scopes registered for the website client, as deployment configures them; these five carry the media routes.
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];

// The website client's key, which only the Worker holds, and the issuer's signing key.
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
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
const kernelCalls: { path: string; authorization: string | null }[] = [];
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// An OpenID provider as Auth will serve the website client, and the kernel's media calls, recording what they receive.
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
        // Auth's contract: the registered kid, iss = sub = the client, aud exactly the issuer, at most 120 seconds.
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
      const access = `access-${counter}`,
        refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      accessTokens.push(access);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: 'openid offline_access media:complete',
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
        // Reusing a rotated refresh token revokes its whole family.
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
    if (url.pathname.startsWith('/v1/media/')) {
      kernelCalls.push({ path: url.pathname + url.search, authorization: request.headers.get('authorization') });
      return Response.json(
        {
          type: 'https://rezics.com/problems/not_found',
          title: 'Not Found',
          status: 404,
          code: 'not_found',
          retryable: false,
          effect_status: 'not_applicable',
          request_id: randomUUID(),
        } satisfies KernelProblem,
        { status: 404, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    return json({ error: 'not_found' }, 404);
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

const children: ChildProcess[] = [];
const started = new Map<boolean, Promise<string>>();
let browser: Browser | undefined;

// The documented command, pointed at the fake through the environment it reads in development.
function site(configured = false): Promise<string> {
  if (started.has(configured)) return started.get(configured)!;
  const starting = (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
        SITE_ORIGINS: configured ? `http://127.0.0.1:${port},${secondOrigin}` : undefined,
      },
    });
    children.push(child);
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
  started.set(configured, starting);
  return starting;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
});

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]!
    .slice(name.length + 1);
// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the callback.
async function signIn(configured = false) {
  const origin = await site(configured);
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent('/en')}`, { redirect: 'manual' });
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
  expect(start.status).toBe(302);
  expect(answer.status).toBe(303);
  const value = cookieValue(answer, session);
  expect(value).toBeDefined();
  return { origin, start, answer, value: value!, access: accessTokens.at(-1)! };
}

// Read server-rendered HTML in a browser with scripts disabled, as in the existing browser tests.
async function pageOf(origin: string, value?: string) {
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: false,
    extraHTTPHeaders: value ? { cookie: `${session}=${value}` } : {},
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${origin}/en`, { waitUntil: 'networkidle' });
    expect(response?.status()).toBe(200);
    const meta = page.locator('head meta[name="csrf-token"]');
    const count = await meta.count();
    return {
      count,
      token: value ? await readSessionToken(origin, `${session}=${value}`) : null,
      cookies: (await response!.headersArray()).filter((header) => header.name.toLowerCase() === 'set-cookie'),
    };
  } finally {
    await context.close();
  }
}

async function upload(origin: string, headers: Record<string, string>, method = 'PUT') {
  const id = randomUUID();
  const response = await fetch(`${origin}/media/${id}`, {
    method,
    redirect: 'manual',
    body: 'x',
    headers: { 'content-type': 'image/png', ...headers },
  });
  const calls = kernelCalls.filter((call) => call.path.startsWith(`/v1/media/${id}`));
  return { response, calls };
}

async function refused(result: Awaited<ReturnType<typeof upload>>) {
  expect(result.response.status).toBe(403);
  expect(result.response.headers.get('content-type')).toStartWith('application/problem+json');
  expect(await result.response.json()).toEqual({
    type: 'https://rezics.com/problems/forbidden',
    title: 'Forbidden',
    status: 403,
    code: 'forbidden',
  });
  expect(result.calls).toEqual([]);
}

function tokenHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { 'X-CSRF-Token': token };
}

function tokenBytes(token: string | null) {
  // Pin the entropy size without prescribing hex versus base64url serialization.
  expect(token).not.toBeNull();
  expect(token!).toMatch(/^(?:[a-fA-F0-9]{32}|[A-Za-z0-9_-]{22}(?:==)?)$/);
  return Buffer.from(token!, /^[a-fA-F0-9]{32}$/.test(token!) ? 'hex' : 'base64url');
}

// Enforce the exact SITE_ORIGINS allowlist, with the dev origin as the default, to turn this into test(...).
test(
  "an unsafe request that carries the session is refused unless its Origin is exactly one of the site's origins",
  async () => {
    const { origin, value, access } = await signIn(true);
    const { token } = await pageOf(origin, value);
    const headers = { cookie: `${session}=${value}`, ...tokenHeaders(token) };
    // A comma-separated second origin is trusted even though it is not the request URL's origin.
    const second = await upload(origin, { ...headers, origin: secondOrigin });
    expect(second.response.status).toBe(404);
    expect(second.calls.map((call) => call.authorization)).toEqual([`Bearer ${access}`]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      for (const extra of [
        {},
        { origin: 'null' },
        { origin: 'https://evil.example' },
        { origin: 'https://auth.rezics.test' },
        { origin: 'https://auth.rezics.test', 'Sec-Fetch-Site': 'same-site' },
        { origin: `${secondOrigin}.evil.example` },
        { origin: `${secondOrigin}/` },
        { origin: 'http://www.rezics.test' },
        { origin: 'https://www.rezics.test:444' },
      ]) {
        await refused(await upload(origin, { ...headers, ...extra }, method));
      }
    }
    const own = await upload(origin, { ...headers, origin });
    expect(own.calls.map((call) => call.authorization)).toEqual([`Bearer ${access}`]);

    const development = await signIn();
    const devToken = (await pageOf(development.origin, development.value)).token;
    const devHeaders = { cookie: `${session}=${development.value}`, ...tokenHeaders(devToken) };
    const devOwn = await upload(development.origin, { ...devHeaders, origin: development.origin });
    expect(devOwn.calls.map((call) => call.authorization)).toEqual([`Bearer ${development.access}`]);
    await refused(await upload(development.origin, { ...devHeaders, origin: secondOrigin }));
    // Safe methods do not require Origin or a synchronizer token.
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await fetch(`${origin}/media/${randomUUID()}`, { method, headers: { cookie: headers.cookie } });
      expect(response.status).not.toBe(403);
    }
    // No ambient session cookie: even an untrusted Origin keeps the existing anonymous upload behaviour.
    for (const extra of [{}, { origin: 'https://evil.example' }, { origin: 'null' }]) {
      const bare = await upload(origin, extra);
      expect(bare.response.status).toBe(404);
      expect(bare.calls.map((call) => call.authorization)).toEqual([null]);
    }
  },
  timeout,
);

// Validate the session's synchronizer token before dispatching unsafe requests to turn this into test(...).
test(
  "an unsafe request that carries the session is refused without that session's CSRF token",
  async () => {
    const first = await signIn();
    const headers = { cookie: `${session}=${first.value}`, origin: first.origin };
    // Check the behavioural rejection before asserting token delivery, so today's failure is the missing defence.
    await refused(await upload(first.origin, headers));
    const own = (await pageOf(first.origin, first.value)).token;
    const other = await signIn();
    const foreign = (await pageOf(other.origin, other.value)).token;
    expect(tokenBytes(own).length).toBe(16);
    expect(tokenBytes(foreign).length).toBe(16);
    for (const token of ['', 'malformed', 'a'.repeat(31), 'a'.repeat(33), `${own},${foreign}`, foreign!]) {
      await refused(await upload(first.origin, { ...headers, 'X-CSRF-Token': token }));
    }
    const accepted = await upload(first.origin, { ...headers, 'X-CSRF-Token': own! });
    expect(accepted.response.status).toBe(404);
    expect(accepted.calls.map((call) => call.authorization)).toEqual([`Bearer ${first.access}`]);
  },
  timeout,
);

// Public HTML carries no token; the private browser session query supplies it.
test(
  "a signed-in browser reads its session's CSRF token while the public head carries none",
  async () => {
    const { origin, value } = await signIn();
    const signedOut = await pageOf(origin);
    expect(signedOut.count).toBe(0);
    const signedIn = await pageOf(origin, value);
    expect(signedIn.count).toBe(0);
    expect(tokenBytes(signedIn.token).length).toBe(16);
    expect((await pageOf(origin, value)).token).toBe(signedIn.token);
    const accepted = await upload(origin, { cookie: `${session}=${value}`, origin, ...tokenHeaders(signedIn.token) });
    expect(accepted.calls).toHaveLength(1);
    expect((await pageOf(origin)).count).toBe(0);
  },
  timeout,
);

// Create a fresh random 128-bit token with each session and keep it out of cookies to turn this into test(...).
test(
  'the CSRF token changes with the session and is never in a cookie',
  async () => {
    const first = await signIn();
    const firstPage = await pageOf(first.origin, first.value);
    expect(tokenBytes(firstPage.token).length).toBe(16);
    const second = await signIn();
    const secondPage = await pageOf(second.origin, second.value);
    expect(tokenBytes(secondPage.token).length).toBe(16);
    expect(second.value).not.toBe(first.value);
    expect(secondPage.token).not.toBe(firstPage.token);
    expect((await pageOf(first.origin, first.value)).token).toBe(firstPage.token);
    const cookies = [
      ...first.start.headers.getSetCookie(),
      ...first.answer.headers.getSetCookie(),
      ...second.start.headers.getSetCookie(),
      ...second.answer.headers.getSetCookie(),
      ...firstPage.cookies.map((header) => header.value),
      ...secondPage.cookies.map((header) => header.value),
    ];
    for (const cookie of cookies) {
      expect(cookie).not.toContain(firstPage.token!);
      expect(cookie).not.toContain(secondPage.token!);
      expect(cookie.split('=')[0]!).not.toMatch(/csrf/i);
    }
    await refused(
      await upload(first.origin, {
        cookie: `${session}=${first.value}`,
        origin: first.origin,
        ...tokenHeaders(secondPage.token),
      }),
    );
  },
  timeout,
);
