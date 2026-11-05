import { afterAll, expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import cloudflareConfig from '../cloudflare.config.ts';

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
const tokenRequests: string[] = [];
const grantResources: string[] = [];
const accessTokens: string[] = [];
const idTokens: string[] = [];
const revoked: string[] = [];
const kernelCalls: { path: string; authorization: string | null }[] = [];
type MediaRoutes = ReturnType<KernelClient['media']>;
type KernelProblem = Extract<NonNullable<Awaited<ReturnType<MediaRoutes['get']>>['error']>, { status: 404 }>['value'];
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
        idTokens.push(body.id_token as string);
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
      tokenRequests.push(form.get('grant_type') ?? '');
      grantResources.push(`${form.get('grant_type')} ${form.getAll('resource').join(' ')}`);
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
      revoked.push(form.get('token') ?? '');
      const family = families.get(form.get('token') ?? '');
      if (family) family.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/v1/media' || url.pathname.startsWith('/v1/media/')) {
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

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;

// The documented command, pointed at the fake through the environment it reads in development.
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

afterAll(() => {
  fake.stop(true);
  if (child?.pid)
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
// Starts a sign-in, answers it as Auth would, and returns the opaque session cookie.
async function signIn(
  returnTo = '/ja',
  grant: Partial<Grant> = {},
  callback: (params: URLSearchParams, code: string) => string = (params, code) =>
    `code=${code}&state=${params.get('state')}`,
) {
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
    ...grant,
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?${callback(params, code)}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect(answer.status).toBe(303);
  const value = cookieValue(answer, session);
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return value!;
}

// Keep every request on the documented dev command's real local ratelimit bindings;
// no test limiter, lowered quota, or replacement clock is installed.
const mediaPath = `/media/${randomUUID()}/original`;
type Visitor = Record<string, string>;
const address = () => ({ 'CF-Connecting-IP': `192.0.2.${++visitor}` });
let visitor = 0;
const withCookie = (name: string, value: string, ip = address()): Visitor => ({
  ...ip,
  cookie: `${name}=${value}`,
});

async function request(headers: Visitor, path = mediaPath, method = 'GET') {
  const reservation: Parameters<KernelClient['media']['post']>[0] = {
    containerId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
    purpose: 'post-image',
    mediaType: 'image/png',
    byteCount: 1,
  };
  return fetch(`${await site()}${path}`, {
    method,
    headers: method === 'POST' ? { ...headers, 'content-type': 'application/json' } : headers,
    ...(method === 'POST' ? { body: JSON.stringify(reservation) } : {}),
    redirect: 'manual',
  });
}

async function allowed(count: number, headers: Visitor, mixed = false) {
  // Pages and downloads, GET and HEAD, must all consume the same two budgets.
  const modes = mixed
    ? ([
        ['/en', 'GET', 200],
        ['/en', 'HEAD', 200],
        [mediaPath, 'GET', 404],
        [mediaPath, 'HEAD', 404],
      ] as const)
    : ([[mediaPath, 'GET', 404]] as const);
  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const [path, method, status] = modes[index % modes.length]!;
      const response = await request(headers, path, method);
      expect(response.status, `${method} ${path} within quota`).toBe(status);
      await response.arrayBuffer();
    }),
  );
}

async function limited(headers: Visitor, period: 10 | 60, path = mediaPath, method = 'GET') {
  const before = kernelCalls.length;
  const response = await request(headers, path, method);
  expect(response.status, `${method} ${path} beyond ${period}s quota`).toBe(429);
  expect(response.headers.get('content-type')).toStartWith('application/problem+json');
  expect(response.headers.get('retry-after')).toBe(String(period));
  if (method === 'HEAD') expect(await response.text()).toBe('');
  else expect(await response.json()).toMatchObject({ status: 429, code: 'rate_limited' });
  expect(kernelCalls.length, 'refused reads must stop before the kernel').toBe(before);
}

async function nextWindow(period: 10 | 60 = 10) {
  // Miniflare's local simulation uses wall-clock-aligned windows. Start just
  // inside one, so the burst cannot accidentally straddle its boundary.
  const milliseconds = period * 1000;
  await Bun.sleep(milliseconds - (Date.now() % milliseconds) + 250);
}

test(
  "site reads beyond a window's limit answer 429 with Retry-After",
  async () => {
    await site();
    const short = address();
    await nextWindow();
    await allowed(100, short, true);
    await limited(short, 10);
    await limited(short, 10, mediaPath, 'HEAD');
    await limited(short, 10, '/en');
    await limited(short, 10, '/en', 'HEAD');

    const long = address();
    await nextWindow(60);
    // Exactly 300 reads spread over three short windows exhaust only the minute.
    for (let burst = 0; burst < 3; burst++) {
      if (burst) await nextWindow();
      await allowed(100, long, true);
    }
    await nextWindow();
    await limited(long, 60);
    await limited(long, 60, mediaPath, 'HEAD');
    await limited(long, 60, '/en');
    await nextWindow(60);
    await allowed(1, long);

    // Configuration is checked after behavior, so missing bindings do not mask
    // the missing 429 as a setup failure in this specification.
    const rateLimits = Object.entries(cloudflareConfig.worker.env).filter(
      ([, binding]) => binding.type === 'rate-limit',
    );
    expect(rateLimits).toEqual([
      ['READS_10S', { type: 'rate-limit', namespace: '1001', simple: { limit: 100, period: 10 } }],
      ['READS_60S', { type: 'rate-limit', namespace: '1002', simple: { limit: 300, period: 60 } }],
    ]);
  },
  timeout,
);

test(
  "a signed-in person's credential reads share one limit across their sessions",
  async () => {
    const sub = randomUUID();
    const first = await signIn('/en', { sub });
    const second = await signIn('/en', { sub });
    const other = await signIn('/en', { sub: randomUUID() });
    expect(second).not.toBe(first);
    const ip = address();
    await nextWindow();
    await allowed(50, withCookie(session, first, ip));
    await allowed(50, withCookie(session, second));
    // A different account on the same IP has its own budget.
    await allowed(1, withCookie(session, other, ip));
    await limited(withCookie(session, second, ip), 10);
    await limited(withCookie(session, first), 10);
  },
  timeout,
);

test(
  "a signed-out visitor's reads are limited by their session cookie, or by IP without one",
  async () => {
    const origin = await site();
    // An actual pending login cookie and a well-formed id without an active
    // session both identify a signed-out visitor; arbitrary malformed ids do not.
    const start = await fetch(`${origin}/auth/sign-in`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const pending = cookieValue(start, login)!;
    expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const [name, value] of [
      [session, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')],
      [login, pending],
    ]) {
      const ip = address();
      await nextWindow();
      const own = withCookie(name!, value!, ip);
      await allowed(100, own);
      // Another cookie and a bare request on the same IP remain independent.
      await allowed(1, withCookie(name!, 'z'.repeat(43), ip));
      await allowed(1, ip);
      // Moving IP does not restore the cookie's budget.
      await limited(withCookie(name!, value!), 10);
    }
    for (const cookie of [undefined, `${session}=malformed; ${login}=also-malformed`]) {
      const ip = address();
      const headers = cookie ? { ...ip, cookie } : ip;
      await nextWindow();
      await allowed(100, headers);
      await allowed(1, address());
      await limited(cookie ? ip : { ...ip, cookie: `${session}=malformed; ${login}=also-malformed` }, 10);
    }
  },
  timeout,
);

test(
  'unsafe requests are not counted against the read limits',
  async () => {
    await site();
    const ip = address();
    await nextWindow(60);
    // More than either read limit, reaching the fake kernel rather than CSRF
    // rejection: unsigned POST reservations and PUT uploads need no Origin.
    const before = kernelCalls.length;
    await Promise.all(
      Array.from({ length: 302 }, async (_, index) => {
        const response = await request(ip, index % 2 ? '/media' : `/media/${randomUUID()}`, index % 2 ? 'POST' : 'PUT');
        expect(response.status).toBe(404);
        await response.arrayBuffer();
      }),
    );
    expect(kernelCalls.length - before).toBe(302);
    for (let burst = 0; burst < 3; burst++) {
      if (burst) await nextWindow();
      await allowed(100, ip);
    }
    await nextWindow();
    await limited(ip, 60);
    // An exhausted read budget still does not reject a write at the website.
    const response = await request(ip, `/media/${randomUUID()}`, 'PUT');
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  },
  timeout,
);
