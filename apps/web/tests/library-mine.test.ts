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
const scopes = ['openid'];

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
type Collection = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: 'private' | 'public' | 'unlisted';
  revision: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
};
type Follow = {
  targetId: string;
  targetType: 'subject' | 'collection' | 'space';
  state: 'following' | 'unfollowed';
  reason: 'explicit' | 'library' | 'membership';
  updatedAt: string;
  target: { id: string; type: string; label: string } | null;
};
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  authorization: string | null;
  key: string | null;
};

const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const calls: Call[] = [];
let counter = 0;
let followRows: Follow[] = [];
const owner = { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' };
const stamp = '2026-10-26T12:00:00.000Z';
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const collections: Collection[] = Array.from({ length: 101 }, (_, index) => {
  const number = index + 1;
  return {
    id: id(1000 + number),
    curatorAccountId: 'alice',
    title: `Collection ${String(number).padStart(3, '0')}`,
    description: null,
    visibility: (['private', 'public', 'unlisted'] as const)[index % 3]!,
    revision: 1,
    memberCount: number,
    createdAt: new Date(Date.UTC(2026, 0, number)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, number)).toISOString(),
    curator: owner,
  };
}).reverse();

function reset() {
  calls.length = 0;
  followRows = [
    {
      targetId: id(2001),
      targetType: 'subject',
      state: 'following',
      reason: 'library',
      updatedAt: stamp,
      target: { id: id(2001), type: 'book', label: 'Followed subject' },
    },
    {
      targetId: id(2002),
      targetType: 'collection',
      state: 'following',
      reason: 'explicit',
      updatedAt: stamp,
      target: { id: id(2002), type: 'collection', label: 'Followed collection' },
    },
    {
      targetId: id(2003),
      targetType: 'space',
      state: 'following',
      reason: 'membership',
      updatedAt: stamp,
      target: { id: id(2003), type: 'space', label: 'Followed space' },
    },
    {
      targetId: 'hidden-follow-target-id',
      targetType: 'subject',
      state: 'following',
      reason: 'explicit',
      updatedAt: stamp,
      target: null,
    },
    {
      targetId: id(2004),
      targetType: 'subject',
      state: 'unfollowed',
      reason: 'explicit',
      updatedAt: stamp,
      target: { id: id(2004), type: 'book', label: 'No longer followed' },
    },
  ];
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
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    calls.push({
      method: request.method,
      path: url.pathname,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      authorization: request.headers.get('authorization'),
      key: request.headers.get('idempotency-key'),
    });
    if (request.method === 'GET' && url.pathname === '/v1/collections') {
      if (url.searchParams.get('curatorAccountId') !== 'alice') return json(apiProblem(404, 'not_found'), 404, true);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = url.searchParams.get('cursor') === 'collections-next' ? 100 : 0;
      const page = collections.slice(offset, offset + limit);
      return json({ collections: page, next: offset + page.length < collections.length ? 'collections-next' : null });
    }
    if (request.method === 'GET' && url.pathname === '/v1/follows') return json({ follows: followRows, next: null });
    const followId = /^\/v1\/follows\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === 'DELETE' && followId) {
      followRows = followRows.map((follow) =>
        follow.targetId === followId ? { ...follow, state: 'unfollowed' } : follow,
      );
      return json({ follow: followRows.find((follow) => follow.targetId === followId) });
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
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  return { status: response.status, html: await response.text(), cookie };
}
async function readWithCookie(path: string, cookie: string) {
  const response = await fetch(`${await site()}${path}`, { headers: { cookie: `${session}=${cookie}` } });
  return { status: response.status, html: await response.text() };
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

test(
  'a signed-in person sees their own collections of every visibility, newest first, paged',
  async () => {
    reset();
    const first = await readPage('/en/library/collections');
    expect(first.status).toBe(200);
    const body = main(first.html);
    expect(body).toContain('Collection 101');
    expect(body).toContain('Collection 002');
    expect(body).not.toContain('Collection 001');
    expect(body.indexOf('Collection 101')).toBeLessThan(body.indexOf('Collection 002'));
    expect(body).toContain('Private');
    expect(body).toContain('Public');
    expect(body).toContain('Unlisted');
    expect(first.html).toContain('/en/collections/new');
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/v1/collections',
        view: 'FULL',
        limit: '100',
        cursor: null,
        authorization: 'Bearer access-1',
      }),
    );
    const next = hrefFor(first.html, 'More');
    expect(next).toBeTruthy();
    expect(next).toContain('cursor=collections-next');
    const second = await readWithCookie(
      new URL(next!, 'http://site.test').pathname + new URL(next!, 'http://site.test').search,
      first.cookie!,
    );
    expect(second.status).toBe(200);
    expect(main(second.html)).toContain('Collection 001');
    expect(main(second.html)).not.toContain('Collection 002');
  },
  timeout,
);

test(
  'a signed-in person sees what they follow (subjects, collections and spaces), and can unfollow',
  async () => {
    reset();
    const first = await readPage('/en/library/following');
    expect(first.status).toBe(200);
    const body = main(first.html);
    expect(body).toContain('Followed subject');
    expect(body).toContain('Followed collection');
    expect(body).toContain('Followed space');
    expect(body).toContain('Unavailable');
    expect(body).not.toContain('hidden-follow-target-id');
    expect(body).not.toContain('No longer followed');
    expect(body).toContain('Added from your library');
    expect(body).toContain('Required by membership');
    expect(first.html).toContain(`/en/collections/${id(2002)}`);
    const cookie = first.cookie!;
    const page = await open('/en/library/following', cookie);
    try {
      await page.getByRole('button', { name: 'More actions for Followed subject' }).click();
      await page.getByRole('menuitem', { name: 'Unfollow' }).click();
      await page.getByRole('link', { name: 'Followed subject', exact: true }).waitFor({ state: 'detached' });
      expect(calls.some((call) => call.method === 'DELETE' && call.path === `/v1/follows/${id(2001)}`)).toBe(true);
      const deletion = calls.find((call) => call.method === 'DELETE')!;
      expect(deletion.key).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, both pages offer sign-in',
  async () => {
    reset();
    for (const path of ['/en/library/collections', '/en/library/following']) {
      const page = await readPage(path, false);
      expect(page.status).toBe(200);
      const content = main(page.html);
      expect(content).toMatch(
        /<a\b[^>]*href="\/auth\/sign-in\?return_to=%2Fen%2Flibrary%2F(?:collections|following)"[^>]*>Sign in<\/a>/,
      );
    }
    expect(calls).toHaveLength(0);
  },
  timeout,
);
