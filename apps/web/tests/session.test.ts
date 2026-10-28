import { readSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

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
        },
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
const cleared = (line: string | undefined) =>
  line !== undefined && /;\s*max-age=0\b|;\s*expires=thu, 01 jan 1970/i.test(line);
function hardened(line: string | undefined) {
  expect(line).toBeDefined();
  expect(line!).toMatch(/;\s*httponly\b/i);
  expect(line!).toMatch(/;\s*secure\b/i);
  expect(line!).toMatch(/;\s*samesite=lax\b/i);
  expect(line!).toMatch(/;\s*path=\/(;|$)/i);
  expect(line!).not.toMatch(/;\s*domain=/i);
}

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the callback.
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
  return { origin, start, location, answer, session: cookieValue(answer, session) };
}

// The credential the Worker sends the kernel for a request carrying this session, seen through a media download.
async function credentialOf(value?: string): Promise<string | null> {
  const id = randomUUID();
  await fetch(`${await site()}/media/${id}/original`, {
    redirect: 'manual',
    headers: value ? { cookie: `${session}=${value}` } : {},
  });
  const call = kernelCalls.findLast((entry) => entry.path.startsWith(`/v1/media/${id}:`));
  expect(call).toBeDefined();
  return call!.authorization;
}

async function csrfTokenOf(origin: string, value: string): Promise<string> {
  const response = await fetch(`${origin}/en`, { headers: { cookie: `${session}=${value}` } });
  expect(response.status).toBe(200);
  const token = await readSessionToken(origin, `${session}=${value}`);
  expect(token).toBeDefined();
  return token!;
}

test(
  'signing in runs the authorization code flow with PKCE and keeps the tokens on the server',
  async () => {
    const {
      origin,
      start,
      location,
      answer,
      session: value,
    } = await signIn('/ja/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01');
    expect([302, 303]).toContain(start.status);
    expect(`${location.origin}${location.pathname}`).toBe(`${fake.url.origin}/auth/authorize`);
    const params = location.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    expect(params.get('scope')!.split(' ').sort()).toEqual(['openid', 'offline_access', ...scopes].sort());
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')!.length).toBeGreaterThanOrEqual(22);
    expect(params.get('nonce')!.length).toBeGreaterThanOrEqual(22);
    hardened(setCookie(start, login));

    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe('/ja/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01');
    hardened(setCookie(answer, session));
    expect(cleared(setCookie(answer, login))).toBe(true);
    // The browser holds only an opaque session id; the tokens never leave the Worker.
    expect(value!.length).toBeGreaterThanOrEqual(32);
    const visible = `${answer.headers.getSetCookie().join('\n')}\n${await answer.text()}`;
    for (const token of [accessTokens.at(-1)!, `refresh-${counter}`, idTokens.at(-1)!])
      expect(visible).not.toContain(token);
    expect(await credentialOf(value)).toBe(`Bearer ${accessTokens.at(-1)}`);
    expect(await credentialOf()).toBeNull();

    // Each sign-in has its own state and nonce.
    const again = await signIn();
    expect(again.location.searchParams.get('state')).not.toBe(params.get('state'));
    expect(again.location.searchParams.get('nonce')).not.toBe(params.get('nonce'));
    expect(again.session).not.toBe(value);
  },
  timeout,
);

test(
  'a callback that does not match the sign-in it answers is refused',
  async () => {
    const before = tokenRequests.length;
    const forged = await signIn('/ja', {}, (_, code) => `code=${code}&state=forged-state-value-0000000000`);
    expect(forged.answer.status).toBe(400);
    expect(forged.answer.headers.get('content-type')).toStartWith('application/problem+json');
    expect(forged.session).toBeUndefined();
    expect(tokenRequests.length).toBe(before);

    // A callback without the sign-in's cookie, as from another browser.
    const origin = await site();
    const start = await fetch(`${origin}/auth/sign-in?return_to=%2Fja`, { redirect: 'manual' });
    const params = new URL(start.headers.get('location')!).searchParams;
    const stray = await fetch(`${origin}/auth/callback?code=code-stray&state=${params.get('state')}`, {
      redirect: 'manual',
    });
    expect(stray.status).toBe(400);
    expect(cookieValue(stray, session)).toBeUndefined();
    expect(tokenRequests.length).toBe(before);

    // The person declined at Auth: back to where they were, signed out.
    const declined = await signIn('/de', {}, (params) => `error=access_denied&state=${params.get('state')}`);
    expect(declined.answer.status).toBe(303);
    expect(declined.answer.headers.get('location')).toBe('/de');
    expect(declined.session).toBeUndefined();

    const replayed = await signIn('/ja', { idNonce: 'a-nonce-this-sign-in-never-sent' });
    expect(replayed.answer.status).toBe(400);
    expect(replayed.session).toBeUndefined();

    // Only paths on this site are return targets.
    for (const target of ['https://evil.example/x', '//evil.example/x', '/\\evil.example/x']) {
      const { answer } = await signIn(target);
      expect(answer.status, target).toBe(303);
      expect(answer.headers.get('location'), target).toBe('/');
    }
  },
  timeout,
);

test(
  'the session refreshes its tokens once under concurrent requests, and ends when refresh fails',
  async () => {
    const { session: value } = await signIn('/ja', { expiresIn: 61 });
    const first = accessTokens.at(-1)!;
    // Within a minute of expiry the session refreshes before it answers.
    await Bun.sleep(2_200);
    let refreshes = tokenRequests.filter((grant) => grant === 'refresh_token').length;
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => credentialOf(value)));
    expect(tokenRequests.filter((grant) => grant === 'refresh_token').length).toBe(refreshes + 1);
    const second = accessTokens.at(-1)!;
    expect(second).not.toBe(first);
    expect(new Set(concurrent)).toEqual(new Set([`Bearer ${second}`]));

    // The rotated refresh token is the one used next; reusing the old one would end the family.
    await Bun.sleep(2_200);
    expect(await credentialOf(value)).toBe(`Bearer ${accessTokens.at(-1)}`);
    expect(accessTokens.at(-1)).not.toBe(second);

    // Auth revokes the family: the next refresh fails, the request continues signed out, and the session is gone.
    families.get(`refresh-${counter}`)!.revoked = true;
    await Bun.sleep(2_200);
    expect(await credentialOf(value)).toBeNull();
    refreshes = tokenRequests.filter((grant) => grant === 'refresh_token').length;
    expect(await credentialOf(value)).toBeNull();
    expect(tokenRequests.filter((grant) => grant === 'refresh_token').length).toBe(refreshes);
  },
  timeout,
);

test(
  "unsafe requests that carry the session need the site's own Origin",
  async () => {
    const { origin, session: value } = await signIn();
    const csrfToken = await csrfTokenOf(origin, value!);
    const token = { 'X-CSRF-Token': csrfToken };
    const put = async (headers: Record<string, string>) => {
      const id = randomUUID();
      const response = await fetch(`${origin}/media/${id}`, {
        method: 'PUT',
        redirect: 'manual',
        body: 'x',
        headers: { 'content-type': 'image/png', ...headers },
      });
      return { response, call: kernelCalls.find((entry) => entry.path.startsWith(`/v1/media/${id}`)) };
    };
    for (const headers of [{}, { origin: 'https://evil.example' }, { origin: 'null' }]) {
      const { response, call } = await put({ cookie: `${session}=${value}`, ...token, ...headers });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.headers.get('content-type')).toStartWith('application/problem+json');
      expect(call).toBeUndefined();
    }
    const same = await put({ cookie: `${session}=${value}`, ...token, origin });
    expect(same.call?.authorization).toBe(`Bearer ${accessTokens.at(-1)}`);
    // Without the session there is no ambient credential to protect.
    const bare = await put({});
    expect(bare.response.status).not.toBe(403);
    expect(bare.call?.authorization ?? null).toBeNull();

    const refused = await fetch(`${origin}/auth/sign-out`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${session}=${value}`, ...token },
    });
    expect(refused.status).toBe(403);
    expect(await credentialOf(value)).toBe(`Bearer ${accessTokens.at(-1)}`);
  },
  timeout,
);

test(
  'signing out revokes the tokens at Auth, deletes the session and ends the Auth session',
  async () => {
    const { origin, session: value } = await signIn();
    const csrfToken = await csrfTokenOf(origin, value!);
    const refresh = `refresh-${counter}`;
    const idToken = idTokens.at(-1)!;
    expect(
      (await fetch(`${origin}/auth/sign-out`, { redirect: 'manual', headers: { cookie: `${session}=${value}` } }))
        .status,
    ).toBe(405);

    const out = await fetch(`${origin}/auth/sign-out`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${session}=${value}`, origin, 'X-CSRF-Token': csrfToken },
    });
    expect(out.status).toBe(303);
    const location = new URL(out.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${fake.url.origin}/auth/end-session`);
    expect(location.searchParams.get('id_token_hint')).toBe(idToken);
    expect(location.searchParams.get('client_id')).toBe(clientId);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(`${origin}/`);
    expect(cleared(setCookie(out, session))).toBe(true);
    expect(revoked).toContain(refresh);
    expect(await credentialOf(value)).toBeNull();
  },
  timeout,
);

test(
  'every grant names the API resource, so access tokens carry the API audience',
  async () => {
    const before = grantResources.length;
    const { location, session: value } = await signIn('/ja', { expiresIn: 61 });
    expect(location.searchParams.getAll('resource')).toEqual([resource]);
    // Within a minute of expiry the next credential use refreshes, naming the same resource.
    await Bun.sleep(2_200);
    expect(await credentialOf(value)).toBe(`Bearer ${accessTokens.at(-1)}`);
    expect(grantResources.slice(before)).toEqual([`authorization_code ${resource}`, `refresh_token ${resource}`]);
  },
  timeout,
);
