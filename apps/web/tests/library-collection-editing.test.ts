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
  idNonce?: string;
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
const subjects = new Map<string, string>();
let counter = 0;

const json = (body: unknown, status = 200, problem = false) => {
  const headers = {
    'cache-control': 'no-store',
    ...(problem ? { 'content-type': 'application/problem+json' } : {}),
  };
  // A 204 carries no body, so a delete answers like the kernel does.
  return status === 204 ? new Response(null, { status, headers }) : Response.json(body, { status, headers });
};

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const stamp = '2026-04-02T15:04:05.000Z';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Visibility = 'private' | 'unlisted' | 'public';
type Subject = { id: string; label: string; type: string } | null;
type Member = { id: string; subjectId: string; note: string | null; addedAt: string; subject: Subject };
type Shelf = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: Visibility;
  revision: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
  members: Member[];
};
type Follow = {
  targetId: string;
  targetType: 'collection';
  state: 'following' | 'unfollowed';
  reason: 'explicit';
  updatedAt: string;
};

function member(n: number, label: string): Member {
  const subjectId = id(1000 + n);
  return {
    id: id(2000 + n),
    subjectId,
    note: null,
    addedAt: stamp,
    subject: { id: subjectId, label, type: 'book' },
  };
}

const aliceCurator = { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' };
const alpha = member(1, 'Alpha story');
const beta = member(2, 'Beta story');
const gamma = member(3, 'Gamma story');
function freshMembers(): Member[] {
  return [alpha, beta, gamma].map((item) => ({
    ...item,
    subject: item.subject ? { ...item.subject } : null,
    note: null,
  }));
}
const shelf: Shelf = {
  id: id(7),
  curatorAccountId: 'alice',
  title: 'Night reading',
  description: 'Stories after dark',
  visibility: 'public',
  revision: 1,
  memberCount: 3,
  createdAt: stamp,
  updatedAt: stamp,
  curator: aliceCurator,
  members: freshMembers(),
};
const packed: Shelf = {
  id: id(8),
  curatorAccountId: 'alice',
  title: 'Packed shelf',
  description: 'Nothing more fits',
  visibility: 'public',
  revision: 1,
  memberCount: 5000,
  createdAt: stamp,
  updatedAt: stamp,
  curator: aliceCurator,
  members: [member(4, 'Last story')],
};
const shelves = new Map<string, Shelf>([
  [shelf.id, shelf],
  [packed.id, packed],
]);
const follows = new Map<string, Follow>();
const replay = new Map<string, { status: number; body: unknown }>();

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  key: string | null;
  authorization: string | null;
  view: string | null;
};
const calls: Call[] = [];

function problem(status: number, code: string) {
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
function resetShelf() {
  shelf.title = 'Night reading';
  shelf.description = 'Stories after dark';
  shelf.visibility = 'public';
  shelf.revision = 1;
  shelf.memberCount = 3;
  shelf.updatedAt = stamp;
  shelf.members = freshMembers();
  shelves.set(shelf.id, shelf);
  follows.clear();
  calls.length = 0;
}
function actor(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return subjects.get(header.slice('Bearer '.length)) ?? null;
}
function collectionView(item: Shelf, full: boolean) {
  const { members: _members, ...value } = item;
  return full ? value : { ...value, curator: undefined };
}
function remember(key: string | null, status: number, body: unknown) {
  if (key) replay.set(key, { status, body });
  return json(body, status, status >= 400);
}

// OpenID provider copied from posting.test.ts; library writes use the issued access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['collections', 'personal_library'] });
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
      const access = `access-${counter}`;
      const refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      subjects.set(access, family.sub);
      accessTokens.push(access);
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

    const raw = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const key = request.headers.get('idempotency-key');
    calls.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body,
      key,
      authorization: request.headers.get('authorization'),
      view: url.searchParams.get('view'),
    });
    if (key && replay.has(key) && request.method !== 'GET') {
      const saved = replay.get(key)!;
      return json(saved.body, saved.status, saved.status >= 400);
    }
    const who = actor(request);
    const full = url.searchParams.get('view') === 'FULL';
    const followId = /^\/v1\/follows\/([^/]+)$/.exec(url.pathname)?.[1];
    if (followId) {
      if (!who) return remember(key, 401, problem(401, 'unauthorized'));
      const target = shelves.get(followId);
      const followKey = `${who}:${followId}`;
      if (request.method === 'GET') {
        const current = follows.get(followKey);
        if (!current) return json(problem(404, 'not_found'), 404, true);
        return json({
          follow: {
            ...current,
            ...(full && target
              ? { target: { id: target.id, type: 'collection', label: target.title } }
              : full
                ? { target: null }
                : {}),
          },
        });
      }
      if (!target || target.visibility !== 'public') return remember(key, 404, problem(404, 'not_found'));
      if (request.method === 'PUT') {
        const follow = {
          targetId: followId,
          targetType: 'collection' as const,
          state: 'following' as const,
          reason: 'explicit' as const,
          updatedAt: stamp,
        };
        follows.set(followKey, follow);
        return remember(key, 200, { follow });
      }
      if (request.method === 'DELETE') {
        const follow = {
          targetId: followId,
          targetType: 'collection' as const,
          state: 'unfollowed' as const,
          reason: 'explicit' as const,
          updatedAt: stamp,
        };
        follows.set(followKey, follow);
        return remember(key, 200, { follow });
      }
    }

    if (url.pathname === '/v1/collections' && request.method === 'POST') {
      if (!who) return remember(key, 401, problem(401, 'unauthorized'));
      const draft = body as { title?: unknown; description?: unknown; visibility?: unknown };
      if (
        typeof draft?.title !== 'string' ||
        !draft.title.trim() ||
        (draft.description !== undefined && draft.description !== null && typeof draft.description !== 'string') ||
        (draft.visibility !== 'private' && draft.visibility !== 'unlisted' && draft.visibility !== 'public')
      )
        return remember(key, 422, problem(422, 'validation'));
      const created: Shelf = {
        id: randomUUID(),
        curatorAccountId: who,
        title: draft.title,
        description: typeof draft.description === 'string' ? draft.description : null,
        visibility: draft.visibility,
        revision: 1,
        memberCount: 0,
        createdAt: stamp,
        updatedAt: stamp,
        curator: who === 'alice' ? aliceCurator : { id: who, handle: who, displayName: who },
        members: [],
      };
      shelves.set(created.id, created);
      const { members: _members, ...value } = created;
      return remember(key, 201, { collection: value });
    }

    if (url.pathname === '/v1/collections' && request.method === 'GET') {
      const owner = url.searchParams.get('curatorAccountId');
      return json({
        collections: [...shelves.values()]
          .filter((item) => item.curatorAccountId === owner && (item.visibility !== 'private' || who === owner))
          .map((item) => collectionView(item, full)),
        next: null,
      });
    }
    const collectionId = /^\/v1\/collections\/([^/]+)$/.exec(url.pathname)?.[1];
    const memberMatch = /^\/v1\/collections\/([^/]+)\/members\/([^/:]+)(?::move)?$/.exec(url.pathname);
    const membersId = /^\/v1\/collections\/([^/]+)\/members$/.exec(url.pathname)?.[1];
    const item = shelves.get(collectionId ?? memberMatch?.[1] ?? membersId ?? '');
    if (request.method === 'GET' && collectionId) {
      if (!item || (item.visibility === 'private' && who !== item.curatorAccountId))
        return json(problem(404, 'not_found'), 404, true);
      return json({ collection: collectionView(item, full) });
    }
    if (request.method === 'GET' && membersId) {
      if (!item || (item.visibility === 'private' && who !== item.curatorAccountId))
        return json(problem(404, 'not_found'), 404, true);
      return json({
        members: item.members.map((entry) => (full ? entry : { ...entry, subject: undefined })),
        next: null,
      });
    }
    if (!item || who !== item.curatorAccountId) return remember(key, 404, problem(404, 'not_found'));
    if (request.method === 'PATCH' && collectionId) {
      const draft = body as { revision?: unknown; title?: unknown; description?: unknown; visibility?: unknown };
      if (draft.revision !== item.revision) return remember(key, 409, problem(409, 'conflict'));
      if (typeof draft.title === 'string') item.title = draft.title;
      if (draft.description === null || typeof draft.description === 'string') item.description = draft.description;
      if (draft.visibility === 'private' || draft.visibility === 'unlisted' || draft.visibility === 'public')
        item.visibility = draft.visibility;
      item.revision += 1;
      item.updatedAt = stamp;
      const { members: _members, ...value } = item;
      return remember(key, 200, { collection: value });
    }
    if (request.method === 'DELETE' && collectionId) {
      const revision = Number(url.searchParams.get('revision'));
      if (revision !== item.revision) return remember(key, 409, problem(409, 'conflict'));
      shelves.delete(item.id);
      return remember(key, 204, null);
    }
    if (memberMatch && url.pathname.endsWith(':move') && request.method === 'POST') {
      const memberId = memberMatch[2]!;
      const after = (body as { after?: unknown })?.after;
      const index = item.members.findIndex((entry) => entry.id === memberId);
      if (index < 0 || (after !== null && typeof after !== 'string'))
        return remember(key, 404, problem(404, 'not_found'));
      const [moved] = item.members.splice(index, 1);
      if (after === null) item.members.unshift(moved!);
      else {
        const afterIndex = item.members.findIndex((entry) => entry.id === after);
        if (afterIndex < 0) return remember(key, 404, problem(404, 'not_found'));
        item.members.splice(afterIndex + 1, 0, moved!);
      }
      return remember(key, 200, {
        member: { id: moved!.id, subjectId: moved!.subjectId, note: moved!.note, addedAt: moved!.addedAt },
      });
    }
    if (memberMatch && request.method === 'PATCH') {
      const current = item.members.find((entry) => entry.id === memberMatch[2]);
      if (!current) return remember(key, 404, problem(404, 'not_found'));
      const note = (body as { note?: unknown })?.note;
      if (note !== null && typeof note !== 'string') return remember(key, 422, problem(422, 'validation'));
      current.note = note;
      return remember(key, 200, {
        member: { id: current.id, subjectId: current.subjectId, note: current.note, addedAt: current.addedAt },
      });
    }
    if (memberMatch && request.method === 'DELETE') {
      const index = item.members.findIndex((entry) => entry.id === memberMatch[2]);
      if (index < 0) return remember(key, 404, problem(404, 'not_found'));
      item.members.splice(index, 1);
      item.memberCount = Math.max(0, item.memberCount - 1);
      return remember(key, 204, null);
    }
    if (item.memberCount >= 5000 && membersId && request.method === 'POST')
      return remember(key, 409, problem(409, 'collection_full'));
    return remember(key, 404, problem(404, 'not_found'));
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

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the callback.
async function signIn(returnTo = '/en', grant: Partial<Grant> = {}) {
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
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  return { origin, answer, session: cookieValue(answer, session) };
}

let browser: Browser | undefined;
async function open(path: string, options: { sub?: string; javaScript?: boolean } = {}) {
  const auth = options.sub === '' ? undefined : await signIn(path, options.sub ? { sub: options.sub } : {});
  if (options.sub === '') {
    // Signed out: no session cookie.
  } else if (auth) {
    expect([302, 303], 'OpenID callback setup').toContain(auth.answer.status);
    expect(auth.session, 'signed-in session setup').toBeTruthy();
  }
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: options.javaScript !== false,
  });
  if (auth?.session && options.sub !== '')
    await context.addCookies([
      {
        name: session,
        value: auth.session,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScript !== false)
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return { page, access: auth ? accessTokens.at(-1) : undefined, origin };
}

function mainText(page: Page) {
  return page.locator('main').innerText();
}
function memberRow(page: Page, label: string) {
  return page.locator('li[data-member]').filter({ hasText: label });
}
const writes = () => calls.filter((call) => call.method !== 'GET');
// Writes leave the page asynchronously, so a check on what the kernel received waits for it.
async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
const moved = (memberId: string) =>
  until(() => writes().find((call) => call.path.endsWith(`/members/${memberId}:move`)), `a move of ${memberId}`);
const noted = (memberId: string) =>
  until(
    () => writes().find((call) => call.method === 'PATCH' && call.path.endsWith(`/members/${memberId}`)),
    `a note on ${memberId}`,
  );
const removed = (memberId: string) =>
  until(
    () => writes().find((call) => call.method === 'DELETE' && call.path.endsWith(`/members/${memberId}`)),
    `removal of ${memberId}`,
  );

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
  'a signed-in person creates a collection with a title, description and visibility, and lands on it',
  async () => {
    resetShelf();
    const { page, access } = await open('/en/collections/new');
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('New collection');
      const body = await mainText(page);
      expect(body).toContain('Only you can see this collection.');
      expect(body).toContain('Anyone with the link can see this collection.');
      expect(body).toContain('Anyone can see this collection.');
      expect(await page.getByRole('radio').count()).toBe(3);
      const key = await page.locator('input[name="idempotencyKey"]').inputValue();
      expect(key).toMatch(uuid);
      await page.getByRole('textbox', { name: 'Title' }).fill('Night reading');
      await page.getByRole('textbox', { name: 'Description' }).fill('Stories after dark');
      await page.getByRole('radio', { name: /Anyone can see this collection/ }).check();
      await page.getByRole('button', { name: 'Create collection' }).click();
      await page.waitForURL(/\/en\/collections\/[0-9a-f-]{36}$/);
      const createdId = new URL(page.url()).pathname.split('/').at(-1)!;
      const create = writes().find((call) => call.path === '/v1/collections');
      expect(create).toMatchObject({
        method: 'POST',
        authorization: `Bearer ${access}`,
        key,
        body: { title: 'Night reading', description: 'Stories after dark', visibility: 'public' },
      });
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Night reading');
      expect(await mainText(page)).toContain('Stories after dark');
      await page.locator('[data-visibility="public"]').waitFor();
      expect(await page.locator('[data-visibility="public"]').count()).toBe(1);
      expect(shelves.get(createdId)?.title).toBe('Night reading');
    } finally {
      await page.context().close();
    }

    const before = calls.length;
    const signedOut = await fetch(`${await site()}/en/collections/new`, { redirect: 'manual' });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get('location')).toBe('/auth/sign-in?return_to=%2Fen%2Fcollections%2Fnew');
    await signedOut.text();
    expect(calls).toHaveLength(before);
  },
  timeout,
);

test(
  'a private collection is hidden from anonymous readers and opens for its curator after hydration',
  async () => {
    resetShelf();
    shelf.visibility = 'private';
    shelves.set(shelf.id, shelf);

    const anonymous = await open(`/en/collections/${shelf.id}`, { sub: '' });
    try {
      expect(await anonymous.page.getByRole('heading', { name: 'Page not found' }).count()).toBe(1);
    } finally {
      await anonymous.page.context().close();
    }

    resetShelf();
    shelf.visibility = 'private';
    shelves.set(shelf.id, shelf);
    const { page, access } = await open(`/en/collections/${shelf.id}`);
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Night reading');
      await page.locator('[data-visibility="private"]').waitFor();
      await page.getByRole('button', { name: 'More actions' }).waitFor();
      const reads = calls.filter((call) => call.path === `/v1/collections/${shelf.id}`);
      expect(reads).toHaveLength(2);
      expect(reads.map((call) => call.authorization)).toEqual([null, `Bearer ${access}`]);
      const memberReads = calls.filter((call) => call.path === `/v1/collections/${shelf.id}/members`);
      expect(memberReads).toHaveLength(2);
      expect(memberReads.map((call) => call.authorization)).toEqual([null, `Bearer ${access}`]);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the curator edits or deletes their collection, and a stale revision keeps their edit and offers to reload',
  async () => {
    resetShelf();
    const { page, access } = await open(`/en/collections/${shelf.id}`);
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Night reading');
      await page.locator('[data-visibility="public"]').waitFor();
      expect(await page.getByRole('button', { name: 'Follow', exact: true }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Move up' }).count()).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill('Revised night');
      await page.getByRole('textbox', { name: 'Description' }).fill('Revised description');
      await page.getByRole('radio', { name: /Anyone with the link can see this collection/ }).check();
      calls.length = 0;
      await page.getByRole('button', { name: 'Save collection' }).click();
      await page.getByRole('heading', { level: 1, name: 'Revised night' }).waitFor();
      const update = writes().find((call) => call.method === 'PATCH');
      expect(update).toMatchObject({
        path: `/v1/collections/${shelf.id}`,
        authorization: `Bearer ${access}`,
        body: {
          revision: 1,
          title: 'Revised night',
          description: 'Revised description',
          visibility: 'unlisted',
        },
      });
      expect(update?.key).toMatch(uuid);
      expect(shelf).toMatchObject({
        title: 'Revised night',
        description: 'Revised description',
        visibility: 'unlisted',
        revision: 2,
      });
      expect(await page.locator('[data-visibility="unlisted"]').count()).toBe(1);

      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill('Lost title');
      shelf.revision = 3;
      shelf.title = 'Newer night';
      calls.length = 0;
      await page.getByRole('button', { name: 'Save collection' }).click();
      const alert = page.locator('main').getByRole('alert');
      await alert.waitFor();
      expect(await alert.innerText()).toContain('Your changes are still here.');
      expect(await page.getByRole('textbox', { name: 'Title' }).inputValue()).toBe('Lost title');
      expect(await page.getByRole('textbox', { name: 'Description' }).inputValue()).toBe('Revised description');
      const conflict = writes().find((call) => call.method === 'PATCH');
      expect(conflict).toMatchObject({
        path: `/v1/collections/${shelf.id}`,
        body: { revision: 2, title: 'Lost title', description: 'Revised description', visibility: 'unlisted' },
      });
      expect(conflict?.key).toMatch(uuid);
      expect(shelf).toMatchObject({ title: 'Newer night', revision: 3 });
      await page.getByRole('link', { name: 'Load the current version' }).click();
      await page.getByRole('heading', { level: 1, name: 'Newer night' }).waitFor();
      expect(await mainText(page)).not.toContain('Lost title');

      calls.length = 0;
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Delete collection' }).click();
      await page.waitForURL(/\/en\/library\/collections$/);
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('My collections');
      const deletion = writes().find((call) => call.method === 'DELETE' && call.path === `/v1/collections/${shelf.id}`);
      expect(deletion?.query.get('revision')).toBe('3');
      expect(deletion?.authorization).toBe(`Bearer ${access}`);
      expect(deletion?.key).toMatch(uuid);
      expect(shelves.has(shelf.id)).toBe(false);
      expect(await mainText(page)).not.toContain('Revised night');
      expect(await mainText(page)).not.toContain('Newer night');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the curator reorders members by moving one before or after another, edits a note, and removes a member, and without JavaScript the controls are disabled',
  async () => {
    resetShelf();
    const plain = await open(`/en/collections/${shelf.id}`, { javaScript: false });
    try {
      const page = plain.page;
      const order = await mainText(page);
      expect(order.indexOf('Alpha story')).toBeLessThan(order.indexOf('Beta story'));
      expect(order.indexOf('Beta story')).toBeLessThan(order.indexOf('Gamma story'));
      // Personal controls are absent until hydration when JavaScript is disabled.
      expect(await page.getByRole('button', { name: 'More actions' }).count()).toBe(0);
      expect(await page.locator('[data-member] button').count()).toBe(0);
      expect(await page.locator('[data-member] textarea').count()).toBe(0);
      expect(await page.locator('[data-member] input[type="checkbox"]').count()).toBe(0);
      expect(await page.locator('main form').count()).toBe(0);
      expect(await page.locator('main form[method="post" i]').count()).toBe(0);
      expect(writes()).toHaveLength(0);
    } finally {
      await plain.page.context().close();
    }

    resetShelf();
    const scripted = await open(`/en/collections/${shelf.id}`);
    try {
      const page = scripted.page;
      await memberRow(page, 'Gamma story').getByRole('button', { name: 'Move up' }).click();
      let order = await mainText(page);
      expect(order.indexOf('Alpha story')).toBeLessThan(order.indexOf('Gamma story'));
      expect(order.indexOf('Gamma story')).toBeLessThan(order.indexOf('Beta story'));
      expect(await moved(gamma.id)).toMatchObject({
        method: 'POST',
        path: `/v1/collections/${shelf.id}/members/${gamma.id}:move`,
        body: { after: alpha.id },
        authorization: `Bearer ${scripted.access}`,
      });
      expect((await moved(gamma.id)).key).toMatch(uuid);
      expect(shelf.members.map((item) => item.id)).toEqual([alpha.id, gamma.id, beta.id]);

      calls.length = 0;
      await memberRow(page, 'Alpha story').getByRole('button', { name: 'Move down' }).click();
      order = await mainText(page);
      expect(order.indexOf('Gamma story')).toBeLessThan(order.indexOf('Alpha story'));
      expect(order.indexOf('Alpha story')).toBeLessThan(order.indexOf('Beta story'));
      expect(await moved(alpha.id)).toMatchObject({
        path: `/v1/collections/${shelf.id}/members/${alpha.id}:move`,
        body: { after: gamma.id },
      });

      calls.length = 0;
      await memberRow(page, 'Beta story').getByRole('button', { name: 'Move to top' }).click();
      order = await mainText(page);
      expect(order.indexOf('Beta story')).toBeLessThan(order.indexOf('Gamma story'));
      expect((await moved(beta.id)).body).toEqual({ after: null });
      expect(shelf.members.map((item) => item.id)).toEqual([beta.id, gamma.id, alpha.id]);

      calls.length = 0;
      await memberRow(page, 'Beta story').getByRole('textbox', { name: 'Note' }).fill('A margin thought');
      await memberRow(page, 'Beta story').getByRole('button', { name: 'Save note' }).click();
      expect(await noted(beta.id)).toMatchObject({
        path: `/v1/collections/${shelf.id}/members/${beta.id}`,
        body: { note: 'A margin thought' },
      });
      await memberRow(page, 'Beta story').locator('p', { hasText: 'A margin thought' }).waitFor();

      calls.length = 0;
      const row = memberRow(page, 'Alpha story');
      expect(await row.getByRole('button', { name: 'Remove member' }).isDisabled()).toBe(true);
      await row.getByRole('checkbox', { name: 'Remove this member' }).check();
      await row.getByRole('button', { name: 'Remove member' }).click();
      expect((await removed(alpha.id)).key).toMatch(uuid);
      await row.waitFor({ state: 'detached' });
      expect(await mainText(page)).not.toContain('Alpha story');
      expect(shelf.members.map((item) => item.id)).toEqual([beta.id, gamma.id]);
    } finally {
      await scripted.page.context().close();
    }

    resetShelf();
    const dragging = await open(`/en/collections/${shelf.id}`);
    try {
      const page = dragging.page;
      await page
        .locator(`[data-member="${gamma.id}"] [data-drag-handle]`)
        .dragTo(page.locator(`[data-member="${alpha.id}"]`));
      const dragged = await moved(gamma.id);
      expect(dragged).toMatchObject({
        method: 'POST',
        path: `/v1/collections/${shelf.id}/members/${gamma.id}:move`,
        body: { after: null },
      });
      expect(dragged.key).toMatch(uuid);
      const order = await mainText(page);
      expect(order.indexOf('Gamma story')).toBeLessThan(order.indexOf('Alpha story'));
      expect(order.indexOf('Alpha story')).toBeLessThan(order.indexOf('Beta story'));
      expect(shelf.members.map((item) => item.id)).toEqual([gamma.id, alpha.id, beta.id]);
    } finally {
      await dragging.page.context().close();
    }
  },
  timeout,
);

test(
  'a full collection says it holds at most 5000 members',
  async () => {
    resetShelf();
    const origin = await site();
    const response = await fetch(`${origin}/en/collections/${packed.id}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const main = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
    expect(main).toContain('A collection holds at most 5000 members.');
    expect(main).toContain('Packed shelf');
  },
  timeout,
);

test(
  'another person sees no editing controls, and can follow or unfollow a public collection',
  async () => {
    resetShelf();
    shelves.set(shelf.id, shelf);
    const plain = await open(`/en/collections/${shelf.id}`, { sub: 'blake', javaScript: false });
    try {
      expect(await plain.page.getByRole('button', { name: 'Follow', exact: true }).count()).toBe(0);
    } finally {
      await plain.page.context().close();
    }
    resetShelf();
    const { page, access } = await open(`/en/collections/${shelf.id}`, { sub: 'blake' });
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Night reading');
      expect(await page.locator('[data-visibility]').count()).toBe(0);
      for (const name of ['More actions', 'Move up', 'Move down', 'Move to top', 'Save note', 'Remove member']) {
        expect(await page.getByRole('button', { name, exact: true }).count(), name).toBe(0);
      }
      expect(await page.getByRole('menuitem', { name: 'Edit' }).count()).toBe(0);
      expect(await page.getByRole('menuitem', { name: 'Delete' }).count()).toBe(0);
      const followRead = calls.find((call) => call.method === 'GET' && call.path === `/v1/follows/${shelf.id}`);
      expect(followRead).toMatchObject({ view: 'FULL', authorization: `Bearer ${access}` });
      calls.length = 0;
      await page.getByRole('button', { name: 'Follow', exact: true }).click();
      await page.getByRole('button', { name: 'Unfollow', exact: true }).waitFor();
      const followed = writes().find((call) => call.path === `/v1/follows/${shelf.id}`);
      expect(followed).toMatchObject({ method: 'PUT', authorization: `Bearer ${access}` });
      expect(followed?.key).toMatch(uuid);
      expect(await mainText(page)).toContain('Following');
      calls.length = 0;
      await page.getByRole('button', { name: 'Unfollow', exact: true }).click();
      await page.getByRole('button', { name: 'Follow', exact: true }).waitFor();
      const unfollowed = writes().find((call) => call.path === `/v1/follows/${shelf.id}`);
      expect(unfollowed).toMatchObject({ method: 'DELETE', authorization: `Bearer ${access}` });
      expect(unfollowed?.key).toMatch(uuid);
      expect(await page.getByRole('button', { name: 'Unfollow', exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
