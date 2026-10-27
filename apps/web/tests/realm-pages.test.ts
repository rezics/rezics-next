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
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];

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
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const tokens = new Map<string, string>();
const assertions = new Set<string>();
let counter = 0;

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...(problem ? { 'content-type': 'application/problem+json' } : {}) },
  });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const stamp = '2026-04-02T15:04:05.000Z';
const mediaId = id(9001);

function problem(status: number, code: string) {
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

type Space = { id: string; address: string; title: string; summary: string; realmId: string | null };
type Realm = { id: string; spaceId: string; title: string; summary: string; visibility: 'public' | 'protected' };

const atlas: Space = {
  id: id(101),
  address: 'atlas',
  title: 'Atlas Readers',
  summary: 'A reading room for <i>long</i> maps & slow novels.',
  realmId: id(201),
};
const quiet: Space = {
  id: id(102),
  address: 'quiet',
  title: 'Quiet Corner',
  summary: 'A space that carries no Realm.',
  realmId: null,
};
const vault: Space = {
  id: id(103),
  address: 'vault',
  title: 'The Vault',
  summary: 'Members only reading.',
  realmId: id(203),
};
const exile: Space = {
  id: id(104),
  address: 'exile',
  title: 'Exile Gardens',
  summary: 'A public garden.',
  realmId: id(204),
};
const spaces = new Map([atlas, quiet, vault, exile].map((item) => [item.id, item]));
const addresses = new Map<string, string>([
  ...[atlas, quiet, vault, exile].map((item) => [item.address, item.id] as const),
  ['ghost', id(199)],
]);
const realms = new Map<string, Realm>([
  [
    atlas.realmId!,
    { id: atlas.realmId!, spaceId: atlas.id, title: 'Atlas Readers', summary: atlas.summary, visibility: 'public' },
  ],
  [
    vault.realmId!,
    {
      id: vault.realmId!,
      spaceId: vault.id,
      title: 'The Vault Circle',
      summary: 'Hidden shelf talk.',
      visibility: 'protected',
    },
  ],
  [
    exile.realmId!,
    {
      id: exile.realmId!,
      spaceId: exile.id,
      title: 'Exile Gardens',
      summary: 'A public garden.',
      visibility: 'public',
    },
  ],
]);
const boards = [
  { id: id(301), title: 'General talk', purpose: 'discussion', visibility: 'published', availability: 'available' },
  { id: id(302), title: 'Reviews of the week', purpose: 'reviews', visibility: 'published', availability: 'available' },
  { id: id(303), title: 'Erased board secret', purpose: 'discussion', visibility: 'published', availability: 'erased' },
].map((board, index) => ({
  ...board,
  route: 7,
  securityRevision: '1',
  createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
}));
const subjects = new Map([
  [id(401), { label: 'Zebra Chronicle', type: 'schema:Book', cover: true }],
  [id(402), { label: 'Bare Placeholder', type: 'schema:Book', cover: false }],
]);
const members = new Map<string, 'member' | 'pending'>();

type Call = {
  method: string;
  path: string;
  limit: string | null;
  cursor: string | null;
  authorization: string | null;
  key: string | null;
};
const calls: Call[] = [];
function reset() {
  calls.length = 0;
  members.clear();
  members.set(`alice:${atlas.realmId}`, 'member');
  members.set(`alice:${vault.realmId}`, 'member');
}

function viewerOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header ? (tokens.get(header.replace(/^Bearer /, '')) ?? null) : null;
}
function readableRealm(realm: Realm, viewer: string | null) {
  return realm.visibility === 'public' || (viewer !== null && members.get(`${viewer}:${realm.id}`) === 'member');
}

function kernel(request: Request, url: URL): Response {
  const viewer = viewerOf(request);
  const notFound = () => json(problem(404, 'not_found'), 404, true);
  const spaceAddress = /^\/v1\/spaceAddresses\/([^/]+)$/.exec(url.pathname)?.[1];
  if (spaceAddress) {
    const spaceId = addresses.get(decodeURIComponent(spaceAddress));
    return spaceId ? json({ spaceId }) : notFound();
  }
  const spaceMatch = /^\/v1\/spaces\/([^/]+)$/.exec(url.pathname)?.[1];
  if (spaceMatch) {
    const space = spaces.get(spaceMatch);
    if (!space) return notFound();
    const realm = space.realmId ? realms.get(space.realmId) : undefined;
    return json({
      space: {
        spaceId: space.id,
        realmId: realm && readableRealm(realm, viewer) ? realm.id : null,
        state: 'active',
        headRevisionId: id(900),
        createdAt: stamp,
        creator: id(1),
        predecessor: null,
        address: space.address,
        title: space.title,
        summary: space.summary,
        revisionCreatedAt: stamp,
        author: id(1),
      },
    });
  }
  if (url.pathname === '/v1/me/realms') {
    if (!viewer) return json(problem(401, 'unauthenticated'), 401, true);
    const items = [...realms.values()]
      .filter((realm) => members.get(`${viewer}:${realm.id}`) === 'member')
      .map((realm) => ({ realmId: realm.id, name: realm.title, role: 'member' }));
    return json({ items, next: null });
  }
  const realmMatch = /^\/v1\/realms\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
  if (!realmMatch) return notFound();
  const realm = realms.get(realmMatch[1]!);
  const part = realmMatch[2];
  if (!realm || !readableRealm(realm, viewer)) return notFound();
  if (!part && request.method === 'GET')
    return json({
      realm: {
        realmId: realm.id,
        spaceId: realm.spaceId,
        state: 'active',
        visibility: realm.visibility,
        contextId: id(7),
        boardSchemeId: null,
        headRevisionId: id(901),
        createdAt: stamp,
        creator: id(1),
        predecessor: null,
        title: realm.title,
        summary: realm.summary,
        revisionCreatedAt: stamp,
        author: id(1),
        votes: {},
      },
    });
  if (part === 'boards') return json({ items: realm.id === atlas.realmId ? boards : [], next: null });
  if (part === 'publications')
    return json({
      items:
        realm.id === atlas.realmId
          ? [...subjects.keys()].map((subjectId, index) => ({
              realmId: realm.id,
              subjectId,
              publicationId: id(500 + index),
              subjectRevisionId: null,
              publishedAt: stamp,
              verdict: 'adopt',
            }))
          : [],
      next: null,
    });
  if (part === 'members/me') {
    if (!viewer) return json(problem(401, 'unauthenticated'), 401, true);
    const state = members.get(`${viewer}:${realm.id}`) ?? 'none';
    return json({ state, since: state === 'member' ? stamp : null });
  }
  if (part === 'participation') {
    if (!viewer) return json(problem(401, 'unauthenticated'), 401, true);
    return viewer === 'blake' && realm.id === exile.realmId
      ? json(problem(403, 'forbidden'), 403, true)
      : new Response(null, { status: 204 });
  }
  if (part === 'membership' && viewer) {
    if (request.method === 'POST') members.set(`${viewer}:${realm.id}`, 'member');
    else members.delete(`${viewer}:${realm.id}`);
    return json({ workflowId: `workflow-${counter}` }, 202);
  }
  return notFound();
}

function subjectRead(subjectId: string): Response {
  const item = subjects.get(subjectId);
  if (!item) return json(problem(404, 'not_found'), 404, true);
  return json({
    subject: {
      id: subjectId,
      type: item.type,
      labels: { en: item.label },
      release: 'r1',
      revision: 1,
      context: id(7),
      statements: {},
      aliases: {},
      descriptions: {},
      resolution: {},
    },
    related: {},
    summary: {
      id: subjectId,
      type: item.type,
      types: [item.type],
      label: { value: item.label, language: 'en' },
      creativeWork: true,
      cover: item.cover
        ? {
            media: mediaId,
            width: 800,
            height: 1200,
            placeholder: { thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==', color: '#336699' },
            variants: [
              { format: 'avif', width: 320 },
              { format: 'webp', width: 320 },
            ],
            focalPoint: null,
            credit: {
              rightsHolder: 'Test Press',
              via: { name: 'Source', url: 'https://example.test' },
              license: 'CC0',
              obligations: [],
            },
          }
        : null,
    },
  });
}

// OpenID provider copied from library-collection.test.ts.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
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
      tokens.set(access, family.sub);
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
        token_endpoint: `${issuer}/token`,
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
        return issue({ sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false }, grant.nonce);
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
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      authorization: request.headers.get('authorization'),
      key: request.headers.get('idempotency-key'),
    });
    const subjectId = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname)?.[1];
    if (subjectId && request.method === 'GET') return subjectRead(subjectId);
    return kernel(request, url);
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
let browser: Browser | undefined;

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
      } catch {
        // The dev server is still starting.
      }
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
    ?.split(';')[0]
    ?.slice(name.length + 1);

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the session cookie.
async function signIn(sub: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent('/en')}`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location')!);
  const params = location.searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub,
    expiresIn: 3600,
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  return sessionCookie!;
}
const cookies = new Map<string, Promise<string>>();
const cookieFor = (sub: string) => {
  if (!cookies.has(sub)) cookies.set(sub, signIn(sub));
  return cookies.get(sub)!;
};

async function readPage(path: string, sub?: string) {
  const cookie = sub ? await cookieFor(sub) : undefined;
  const response = await fetch(`${await site()}${path}`, {
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text(), location: response.headers.get('location') };
}
async function open(path: string, sub: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addCookies([
    {
      name: session,
      value: await cookieFor(sub),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
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
function links(html: string) {
  const found: { href: string; text: string }[] = [];
  for (const match of main(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(match[1] ?? '')?.[1]?.replaceAll('&amp;', '&');
    if (!href) continue;
    found.push({ href, text: match[2]!.replace(/<[^>]+>/g, '').trim() });
  }
  return found;
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

test(
  'a Space address opens its page, with the Realm it carries: title, summary, boards, published subjects and member state',
  async () => {
    reset();
    const anonymous = await readPage('/en/spaces/atlas');
    expect(anonymous.status).toBe(200);
    const body = main(anonymous.html);
    expect(body).toContain('Atlas Readers');
    expect(body).toContain('A reading room for &lt;i&gt;long&lt;/i&gt; maps &amp; slow novels.');
    expect(anonymous.html).not.toContain('<i>long</i>');
    const anchors = links(anonymous.html);
    expect(anchors).toContainEqual({ href: `/en/boards/${id(301)}`, text: expect.stringContaining('General talk') });
    expect(anchors).toContainEqual({
      href: `/en/boards/${id(302)}`,
      text: expect.stringContaining('Reviews of the week'),
    });
    expect(body).not.toContain('Erased board secret');
    expect(
      anchors.some((anchor) => anchor.href === `/en/subjects/${id(401)}` && anchor.text.includes('Zebra Chronicle')),
    ).toBe(true);
    expect(
      anchors.some((anchor) => anchor.href === `/en/subjects/${id(402)}` && anchor.text.includes('Bare Placeholder')),
    ).toBe(true);
    // Published subjects are covers: one with an image from the media route, one with the placeholder.
    expect([...body.matchAll(/data-slot="cover"/g)]).toHaveLength(2);
    expect(body).toContain(`/media/${mediaId}/avif-320`);
    expect(body).toContain('data-state="placeholder"');
    // Anonymous readers get a sign-in link, no member state and no authorized reads.
    expect(anchors.some((anchor) => anchor.href === '/auth/sign-in?return_to=%2Fen%2Fspaces%2Fatlas')).toBe(true);
    expect(body).not.toContain('data-member-state');
    // A cold render reads each definitions resource at most once, independent of the number of subjects.
    expect(
      Math.max(
        calls.filter((call) => call.path === '/v1/definitions/active').length,
        calls.filter((call) => call.path.startsWith('/v1/definitions/releases/')).length,
      ),
    ).toBeLessThanOrEqual(1);
    // The shell's template read and cached definitions reads are outside the page's community reads.
    const reads = calls.filter(
      (call) =>
        call.path !== '/v1/pages:read' &&
        !call.path.startsWith('/v1/subjects/') &&
        !call.path.startsWith('/v1/definitions/'),
    );
    expect(reads.every((call) => call.method === 'GET' && call.authorization === null)).toBe(true);
    expect(reads.map((call) => call.path).sort()).toEqual(
      [
        '/v1/spaceAddresses/atlas',
        `/v1/spaces/${atlas.id}`,
        `/v1/realms/${atlas.realmId}`,
        `/v1/realms/${atlas.realmId}/boards`,
        `/v1/realms/${atlas.realmId}/publications`,
      ].sort(),
    );
    for (const call of reads.filter((read) => /\/(boards|publications)$/.test(read.path)))
      expect(call.limit).toMatch(/^\d+$/);

    // A member sees their state and can leave; a signed-in non-member can join, once the page has hydrated.
    calls.length = 0;
    const member = await readPage('/en/spaces/atlas', 'alice');
    expect(main(member.html)).toContain('data-member-state="member"');
    expect(main(member.html)).toMatch(/<button\b[^>]*>\s*Leave\s*<\/button>/);
    expect(
      calls.some((call) => call.path === `/v1/realms/${atlas.realmId}/members/me` && call.authorization !== null),
    ).toBe(true);
    const visitor = await readPage('/en/spaces/atlas', 'blake');
    expect(main(visitor.html)).toContain('data-member-state="none"');
    expect(main(visitor.html)).toMatch(/<button\b[^>]*\bdisabled\b[^>]*>\s*Join\s*<\/button>/);

    // A Space that carries no Realm shows the Space alone and reads nothing else.
    calls.length = 0;
    const alone = await readPage('/en/spaces/quiet', 'alice');
    expect(alone.status).toBe(200);
    expect(main(alone.html)).toContain('Quiet Corner');
    expect(main(alone.html)).toContain('A space that carries no Realm.');
    expect(main(alone.html)).not.toContain('data-member-state');
    expect(calls.some((call) => call.path.startsWith('/v1/realms/'))).toBe(false);
  },
  timeout,
);

test(
  'a signed-in person joins and leaves a Realm, and a banned or protected Realm explains what they can see',
  async () => {
    reset();
    const page = await open('/en/spaces/atlas', 'blake');
    try {
      await page.getByRole('button', { name: 'Join' }).click();
      await page.locator('[data-member-state="pending"]').waitFor();
      const join = calls.find(
        (call) => call.method === 'POST' && call.path === `/v1/realms/${atlas.realmId}/membership`,
      );
      expect(join?.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(join?.authorization).not.toBeNull();
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await page.locator('[data-member-state="member"]').waitFor();
      await page.getByRole('button', { name: 'Leave' }).click();
      await page.locator('[data-member-state="pending"]').waitFor();
      expect(
        calls.some((call) => call.method === 'DELETE' && call.path === `/v1/realms/${atlas.realmId}/membership`),
      ).toBe(true);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('[data-member-state="none"]').waitFor();
    } finally {
      await page.context().close();
    }

    reset();
    const banned = await readPage('/en/spaces/exile', 'blake');
    expect(banned.status).toBe(200);
    const bannedMain = main(banned.html);
    expect(bannedMain).toContain('Exile Gardens');
    expect(bannedMain).toContain('data-member-state="banned"');
    expect(bannedMain).toMatch(/banned from this Realm/);
    expect(bannedMain).not.toMatch(/<button\b[^>]*>\s*Join\s*<\/button>/);

    const protectedMember = await readPage('/en/spaces/vault', 'alice');
    expect(protectedMember.status).toBe(200);
    expect(main(protectedMember.html)).toContain('The Vault');
    expect(main(protectedMember.html)).toContain('data-visibility="protected"');
    expect(main(protectedMember.html)).toMatch(/only members can read/i);

    // Anyone else sees the Space alone, with nothing about the Realm it carries.
    for (const sub of [undefined, 'blake']) {
      const other = await readPage('/en/spaces/vault', sub);
      expect(other.status).toBe(200);
      expect(main(other.html)).toContain('The Vault');
      expect(main(other.html)).not.toContain('The Vault Circle');
      expect(main(other.html)).not.toContain('data-visibility');
      expect(main(other.html)).not.toContain('data-member-state');
    }
  },
  timeout,
);

test(
  "a person's own Realms are listed with links to each",
  async () => {
    reset();
    const mine = await readPage('/en/realms', 'alice');
    expect(mine.status).toBe(200);
    const anchors = links(mine.html);
    expect(anchors).toContainEqual({ href: `/en/realms/${atlas.realmId}`, text: 'Atlas Readers' });
    expect(anchors).toContainEqual({ href: `/en/realms/${vault.realmId}`, text: 'The Vault Circle' });
    const listing = calls.filter((call) => call.path === '/v1/me/realms');
    expect(listing).toHaveLength(1);
    expect(listing[0]!.authorization).not.toBeNull();
    expect(calls.filter((call) => call.path.startsWith('/v1/')).length).toBe(1);

    // A Realm link lands on the page of the Space that carries it.
    const hop = await readPage(`/en/realms/${atlas.realmId}`, 'alice');
    expect([301, 302, 303, 307, 308]).toContain(hop.status);
    expect(hop.location).toBe('/en/spaces/atlas');

    const empty = await readPage('/en/realms', 'carol');
    expect(empty.status).toBe(200);
    expect(main(empty.html)).toContain('You have not joined any Realms yet.');
    const signedOut = await readPage('/en/realms');
    expect(links(signedOut.html).some((anchor) => anchor.href === '/auth/sign-in?return_to=%2Fen%2Frealms')).toBe(true);
  },
  timeout,
);

test(
  'an unknown or unreadable address answers the same not-found page',
  async () => {
    reset();
    const unknown = await readPage('/en/spaces/no-such-place');
    const unreadable = await readPage('/en/spaces/ghost', 'alice');
    const malformed = await readPage(`/en/spaces/${encodeURIComponent('bad address/../')}`);
    const unknownRealm = await readPage(`/en/realms/${id(998)}`, 'alice');
    for (const result of [unknown, unreadable, malformed, unknownRealm]) expect(result.status).toBe(404);
    expect(main(unknown.html)).toContain('Page not found');
    for (const result of [unreadable, malformed, unknownRealm]) expect(main(result.html)).toBe(main(unknown.html));
    // The Realm that the viewer may not read is just as absent.
    const hidden = await readPage(`/en/realms/${vault.realmId}`, 'blake');
    expect(hidden.status).toBe(404);
    expect(main(hidden.html)).toBe(main(unknown.html));
  },
  timeout,
);
