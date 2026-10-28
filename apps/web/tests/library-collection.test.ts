import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
const pageLimit = '100';

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
let counter = 0;

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(problem ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const stamp = '2026-04-02T15:04:05.000Z';
const hiddenSubjectId = 'unavailable-subject-should-not-appear';
const deletedAccountId = 'gone-account-should-not-appear';
const owner = { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' };
type Visibility = 'private' | 'unlisted' | 'public';
type Subject = { id: string; label: string; type: string } | null;
type Curator = { id: string; handle: string | null; displayName: string | null } | null;
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
  curator: Curator;
  members: Member[];
};

function member(n: number, subject: Subject, note: string | null, subjectId = subject?.id ?? hiddenSubjectId): Member {
  return { id: id(3000 + n), subjectId, note, addedAt: stamp, subject };
}
function shelf(
  n: number,
  visibility: Visibility,
  title: string,
  members: Member[],
  description: string | null,
  curator: Curator,
  curatorAccountId = curator?.id ?? deletedAccountId,
): Shelf {
  return {
    id: id(n),
    curatorAccountId,
    title,
    description,
    visibility,
    revision: 1,
    memberCount: members.length,
    createdAt: stamp,
    updatedAt: stamp,
    curator,
    members,
  };
}

const night = shelf(
  1,
  'public',
  'Night shelf',
  [
    member(1, { id: id(11), label: 'Zebra story', type: 'book' }, 'First note'),
    member(2, null, '<script>alert(1)</script>'),
    member(3, { id: id(12), label: 'Apple story', type: 'book' }, 'Third note'),
  ],
  '<b>not bold</b> and **not markdown**',
  owner,
);
const quiet = shelf(
  2,
  'unlisted',
  'Quiet shelf',
  [member(4, { id: id(13), label: 'Always Coming Home', type: 'book' }, null)],
  null,
  owner,
);
const locked = shelf(
  5,
  'private',
  'Locked shelf',
  [member(5, { id: id(14), label: 'Hidden story', type: 'book' }, 'Secret note')],
  'A private description',
  owner,
);
const orphan = shelf(
  6,
  'public',
  'Orphan shelf',
  [member(6, { id: id(15), label: 'Orphan story', type: 'book' }, null)],
  null,
  null,
);
const longMembers = Array.from({ length: 101 }, (_, index) => {
  const n = index + 1;
  const label = `Entry ${String(n).padStart(3, '0')}`;
  return member(100 + n, { id: id(5000 + n), label, type: 'book' }, `Note ${String(n).padStart(3, '0')}`);
});
const long = shelf(4, 'public', 'Long shelf', longMembers, 'One hundred and one entries', owner);
const shelves = new Map([night, quiet, locked, orphan, long].map((item) => [item.id, item]));

type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  authorization: string | null;
};
const calls: Call[] = [];
const cursors = new Map<string, { collectionId: string; offset: number }>();
let cursorSerial = 0;
let gateClosed = false;

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
function reset() {
  calls.length = 0;
  gateClosed = false;
  cursors.clear();
  cursorSerial = 0;
}
function pageOf(item: Shelf, cursor: string | null, limit: number) {
  if (cursor === 'stale') return { stale: true as const };
  let offset = 0;
  if (cursor) {
    const saved = cursors.get(cursor);
    if (!saved || saved.collectionId !== item.id) return { stale: true as const };
    offset = saved.offset;
  }
  const slice = item.members.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  let next: string | null = null;
  if (nextOffset < item.members.length) {
    next = `page${++cursorSerial}`;
    cursors.set(next, { collectionId: item.id, offset: nextOffset });
  }
  return { stale: false as const, members: slice, next };
}

// OpenID provider copied from posting.test.ts; collection reads send no token grant.
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
    });
    if (gateClosed) return json(problem(403, 'platform_closed'), 403, true);
    const collectionId = /^\/v1\/collections\/([^/]+)$/.exec(url.pathname)?.[1];
    const membersId = /^\/v1\/collections\/([^/]+)\/members$/.exec(url.pathname)?.[1];
    const item = shelves.get(collectionId ?? membersId ?? '');
    if (request.method !== 'GET' || !item || item.visibility === 'private')
      return json(problem(404, 'not_found'), 404, true);
    const full = url.searchParams.get('view') === 'FULL';
    if (collectionId) {
      const { members: _members, ...value } = item;
      return json({ collection: full ? value : { ...value, curator: undefined } });
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const page = pageOf(item, url.searchParams.get('cursor'), Number.isInteger(limit) && limit > 0 ? limit : 20);
    if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
    return json({
      members: page.members.map((entry) => (full ? entry : { ...entry, subject: undefined })),
      next: page.next,
    });
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

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the session cookie.
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
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  return sessionCookie!;
}

let aliceCookie: Promise<string> | undefined;
let blakeCookie: Promise<string> | undefined;
const alice = () => (aliceCookie ??= signIn('/en', { sub: 'alice' }));
const blake = () => (blakeCookie ??= signIn('/en', { sub: 'blake' }));

async function readPage(path: string, cookie?: string) {
  const response = await fetch(`${await site()}${path}`, {
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  return {
    status: response.status,
    html: await response.text(),
    cache: response.headers.get('cache-control') ?? '',
  };
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
afterAll(() => {
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

test(
  'anyone can read a public or unlisted collection with its curator, description and members in order, paged by cursor',
  async () => {
    reset();
    const anonymous = await readPage(`/en/collections/${night.id}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.cache).toMatch(/\bno-store\b/);
    const nightMain = main(anonymous.html);
    expect(nightMain).toContain('Night shelf');
    expect(nightMain).toContain('&lt;b&gt;not bold&lt;/b&gt; and **not markdown**');
    expect(anonymous.html).not.toContain('<b>not bold</b>');
    expect(nightMain).toContain('Ada Lovelace');
    expect(nightMain).toContain('ada');
    expect(nightMain).toContain('3 members');
    expect(nightMain).toContain(`datetime="${stamp}"`);
    expect(nightMain).not.toContain('data-visibility');
    expect(nightMain.indexOf('Zebra story')).toBeLessThan(nightMain.indexOf('Apple story'));
    expect(nightMain.indexOf('First note')).toBeLessThan(nightMain.indexOf('Third note'));
    expect(nightMain).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(anonymous.html).not.toContain('<script>alert(1)</script>');
    const reads = calls.filter((call) => call.path.startsWith(`/v1/collections/${night.id}`));
    expect(reads.map((call) => call.path).sort()).toEqual(
      [`/v1/collections/${night.id}`, `/v1/collections/${night.id}/members`].sort(),
    );
    expect(reads.every((call) => call.method === 'GET' && call.view === 'FULL' && call.authorization === null)).toBe(
      true,
    );
    expect(reads.find((call) => call.path.endsWith('/members'))?.limit).toBe(pageLimit);

    const ownerPage = await readPage(`/en/collections/${night.id}`, await alice());
    expect(ownerPage.status).toBe(200);
    expect(main(ownerPage.html)).toContain('data-visibility="public"');
    expect(main(ownerPage.html)).toContain('Public');
    const other = await readPage(`/en/collections/${night.id}`, await blake());
    expect(other.status).toBe(200);
    expect(main(other.html)).toContain('Night shelf');
    expect(main(other.html)).not.toContain('data-visibility');

    const unlisted = await readPage(`/ja/collections/${quiet.id}`);
    expect(unlisted.status).toBe(200);
    const quietMain = main(unlisted.html);
    expect(quietMain).toContain('Quiet shelf');
    expect(quietMain).toContain('Always Coming Home');
    expect(quietMain).toContain('Ada Lovelace');
    expect(quietMain).not.toContain('Night shelf');
    expect(quietMain).not.toContain('data-visibility');
    const unlistedOwner = await readPage(`/en/collections/${quiet.id}`, await alice());
    expect(main(unlistedOwner.html)).toContain('data-visibility="unlisted"');
    expect(main(unlistedOwner.html)).toContain('Unlisted');

    const deleted = await readPage(`/en/collections/${orphan.id}`);
    expect(deleted.status).toBe(200);
    expect(main(deleted.html)).toContain('Deleted account');
    expect(deleted.html).not.toContain(deletedAccountId);

    calls.length = 0;
    const first = await readPage(`/en/collections/${long.id}`);
    expect(first.status).toBe(200);
    const firstMain = main(first.html);
    expect(firstMain.indexOf('Entry 001')).toBeLessThan(firstMain.indexOf('Entry 002'));
    expect(firstMain.indexOf('Entry 002')).toBeLessThan(firstMain.indexOf('Entry 100'));
    expect(firstMain).not.toContain('Entry 101');
    expect(firstMain).toContain('101 members');
    const memberRead = calls.find((call) => call.path === `/v1/collections/${long.id}/members`);
    expect(memberRead).toMatchObject({ view: 'FULL', limit: pageLimit, cursor: null });
    const more = links(first.html).find((link) => link.text === 'More');
    expect(more?.href).toContain(`/en/collections/${long.id}`);
    const cursor = new URL(more!.href, 'http://site.test').searchParams.get('cursor');
    expect(cursor).toBeTruthy();
    expect([...cursors.keys()]).toContain(cursor);
    calls.length = 0;
    const second = await readPage(`/en/collections/${long.id}?cursor=${encodeURIComponent(cursor!)}`);
    expect(second.status).toBe(200);
    const secondMain = main(second.html);
    expect(secondMain).toContain('Entry 101');
    expect(secondMain).not.toContain('Entry 001');
    expect(secondMain).toContain('Note 101');
    expect(calls.find((call) => call.path.endsWith('/members'))).toMatchObject({
      view: 'FULL',
      limit: pageLimit,
      cursor,
    });
  },
  timeout,
);

test(
  "members show their subject's label linked to its page, and an unreadable subject shows as unavailable",
  async () => {
    reset();
    const page = await readPage(`/en/collections/${night.id}`);
    expect(page.status).toBe(200);
    const found = links(page.html);
    const zebra = found.find((link) => link.text === 'Zebra story');
    const apple = found.find((link) => link.text === 'Apple story');
    expect(zebra?.href).toBe(`/en/subjects/${id(11)}/${slug('Zebra story')}`);
    expect(apple?.href).toBe(`/en/subjects/${id(12)}/${slug('Apple story')}`);
    // The fake serves no definitions, so the type has no name to show and its raw value stays out.
    expect(main(page.html)).not.toContain('book');
    expect(main(page.html)).toContain('Unavailable');
    expect(page.html).not.toContain(hiddenSubjectId);
    expect(found.some((link) => link.href.includes(hiddenSubjectId) || link.text === hiddenSubjectId)).toBe(false);
  },
  timeout,
);

test(
  'a private collection, or one the viewer may not see, shows the not-found page',
  async () => {
    reset();
    for (const cookie of [undefined, await alice(), await blake()]) {
      calls.length = 0;
      const page = await readPage(`/en/collections/${locked.id}`, cookie);
      expect(page.status).toBe(404);
      expect(page.cache).toMatch(/\bno-store\b/);
      expect(page.html).toContain('Page not found');
      expect(page.html).toContain('The page you requested could not be found.');
      expect(page.html).not.toContain('Locked shelf');
      expect(page.html).not.toContain('Secret note');
      expect(calls.some((call) => call.path === `/v1/collections/${locked.id}`)).toBe(true);
    }
    calls.length = 0;
    const missing = await readPage(`/en/collections/${id(99)}`);
    expect(missing.status).toBe(404);
    expect(missing.html).toContain('Page not found');
    expect(calls.some((call) => call.path === `/v1/collections/${id(99)}`)).toBe(true);
  },
  timeout,
);

test(
  'a stale cursor restarts from the first page',
  async () => {
    reset();
    const page = await readPage(`/en/collections/${night.id}?cursor=stale`);
    expect(page.status).toBe(200);
    const body = main(page.html);
    expect(body).toContain('Night shelf');
    expect(body.indexOf('Zebra story')).toBeLessThan(body.indexOf('Apple story'));
    expect(body).not.toContain('Something went wrong');
    const memberReads = calls.filter((call) => call.path === `/v1/collections/${night.id}/members`);
    expect(memberReads.map((call) => call.cursor)).toEqual(['stale', null]);
    expect(memberReads.every((call) => call.view === 'FULL')).toBe(true);
  },
  timeout,
);

test(
  'a closed collections gate shows the not-open-yet page',
  async () => {
    reset();
    gateClosed = true;
    const english = await readPage(`/en/collections/${night.id}`);
    expect(english.status).toBe(403);
    expect(english.cache).toMatch(/\bno-store\b/);
    expect(english.html).toContain('Not open yet');
    expect(english.html).toContain('This part of REZICS is not open yet.');
    expect(english.html).not.toContain('Night shelf');
    const japanese = await readPage(`/ja/collections/${quiet.id}`);
    expect(japanese.status).toBe(403);
    expect(japanese.html).toContain('まだ公開されていません');
    expect(japanese.html).toContain('REZICSのこの部分は、まだ公開されていません。');
    expect(calls.some((call) => call.path.startsWith('/v1/collections/'))).toBe(true);
  },
  timeout,
);
