import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];
const sectionLimit = '12';
const tabLimit = '48';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
const newerStamp = '2026-04-02T15:04:05.000Z';
const middleStamp = '2026-03-01T08:00:00.000Z';
const olderStamp = '2026-01-15T12:30:00.000Z';
const reloadedStamp = '2026-05-01T00:00:00.000Z';
const hiddenSubjectId = 'unavailable-subject-should-not-appear';
type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
type Subject = { id: string; label: string; type: string } | null;
type Entry = {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: Subject;
};

function entry(subjectId: string, state: EntryState, revision: number, updatedAt: string, subject: Subject): Entry {
  return { subjectId, state, revision, createdAt: updatedAt, updatedAt, subject };
}
function showcase(): Entry[] {
  return [
    entry(id(11), 'completed', 4, newerStamp, { id: id(11), label: 'Zebra story', type: 'book' }),
    entry(hiddenSubjectId, 'planned', 1, middleStamp, null),
    entry(id(12), 'planned', 2, olderStamp, { id: id(12), label: 'Apple story', type: 'book' }),
  ];
}
function byNewest(left: Entry, right: Entry) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return left.subjectId < right.subjectId ? -1 : 1;
}
function longLibrary(): Entry[] {
  return Array.from({ length: 101 }, (_, index) => {
    const n = index + 1;
    const updatedAt = new Date(Date.UTC(2026, 3, 2, 15, 4, 5) - n * 60_000).toISOString();
    const label = `Entry ${String(n).padStart(3, '0')}`;
    return entry(id(5000 + n), 'planned', 1, updatedAt, { id: id(5000 + n), label, type: 'book' });
  });
}

let entries = showcase();
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  state: string | null;
  revision: string | null;
  body: unknown;
  key: string | null;
  authorization: string | null;
};
const calls: Call[] = [];
const cursors = new Map<string, { filter: string; offset: number }>();
let cursorSerial = 0;

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
  cursors.clear();
  cursorSerial = 0;
  entries = showcase();
}
function diverge(subjectId: string, state: EntryState) {
  const entry = entries.find((item) => item.subjectId === subjectId);
  if (!entry) throw new Error(`missing ${subjectId}`);
  entry.state = state;
  entry.revision += 5;
  entry.updatedAt = reloadedStamp;
}
function pageOf(cursor: string | null, limit: number, filter: string) {
  if (cursor === 'stale') return { stale: true as const };
  const filtered = entries.filter((item) => (filter ? item.state === filter : true)).sort(byNewest);
  let offset = 0;
  if (cursor) {
    const saved = cursors.get(cursor);
    if (!saved || saved.filter !== filter) return { stale: true as const };
    offset = saved.offset;
  }
  const slice = filtered.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  let next: string | null = null;
  if (nextOffset < filtered.length) {
    next = `page${++cursorSerial}`;
    cursors.set(next, { filter, offset: nextOffset });
  }
  return { stale: false as const, entries: slice, next };
}
function viewOf(item: Entry, full: boolean) {
  return full ? item : { ...item, subject: undefined };
}

// OpenID provider copied from posting.test.ts; library writes send the website's access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['personal_library', 'collections'] });
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
    // Unknown /v1 routes, including the anonymous home `pages:read`, answer 404. A bearer is required only for Library.
    const subjectId = /^\/v1\/libraryEntries\/([^/]+)$/.exec(url.pathname)?.[1];
    if (url.pathname !== '/v1/libraryEntries' && !subjectId) return json(problem(404, 'not_found'), 404, true);
    const body = request.method === 'PUT' || request.method === 'POST' ? await request.json() : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      state: url.searchParams.get('state'),
      revision: url.searchParams.get('revision'),
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (url.pathname === '/v1/libraryEntries' && request.method === 'GET') {
      const rawLimit = Number(url.searchParams.get('limit') ?? 20);
      const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
      const page = pageOf(url.searchParams.get('cursor'), limit, url.searchParams.get('state') ?? '');
      if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
      const full = url.searchParams.get('view') === 'FULL';
      return json({ libraryEntries: page.entries.map((item) => viewOf(item, full)), next: page.next });
    }
    if (!subjectId) return json(problem(404, 'not_found'), 404, true);
    const decodedId = decodeURIComponent(subjectId);
    const current = entries.find((item) => item.subjectId === decodedId);
    if (!current) return json(problem(404, 'not_found'), 404, true);
    if (request.method === 'GET') {
      const full = url.searchParams.get('view') === 'FULL';
      return json({ libraryEntry: viewOf(current, full) });
    }
    if (!request.headers.get('idempotency-key')) return json(problem(400, 'invalid_request'), 400, true);
    if (request.method === 'PUT') {
      const draft = body as { state?: EntryState; revision?: number };
      if (draft.revision !== current.revision || !draft.state) return json(problem(409, 'conflict'), 409, true);
      current.state = draft.state;
      current.revision += 1;
      current.updatedAt = '2026-04-03T00:00:00.000Z';
      return json({
        libraryEntry: {
          subjectId: current.subjectId,
          state: current.state,
          revision: current.revision,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        },
      });
    }
    if (request.method === 'DELETE') {
      const revision = Number(url.searchParams.get('revision'));
      if (revision !== current.revision) return json(problem(409, 'conflict'), 409, true);
      entries = entries.filter((item) => item.subjectId !== current.subjectId);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    return json(problem(404, 'not_found'), 404, true);
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
let aliceAccess = '';
const alice = async () => {
  if (!aliceCookie) {
    const pending = signIn('/en', { sub: 'alice' });
    aliceCookie = pending;
    await pending;
    aliceAccess = accessTokens.at(-1) ?? '';
  }
  return aliceCookie;
};

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
function linksIn(html: string) {
  const found: { href: string; text: string; current: boolean }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(match[1] ?? '')?.[1]?.replaceAll('&amp;', '&');
    if (!href) continue;
    found.push({
      href,
      text: match[2]!.replace(/<[^>]+>/g, '').trim(),
      current: /aria-current="page"/.test(match[1] ?? ''),
    });
  }
  return found;
}
function links(html: string) {
  return linksIn(main(html));
}
function visible(html: string) {
  return main(html)
    .replace(/<input\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
}
function formatInstant(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}
function shortDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}
function libraryReads() {
  return calls.filter((call) => call.method === 'GET' && call.path === '/v1/libraryEntries');
}
let browser: Browser | undefined;
async function open(path: string, cookie: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}
async function accountMenuHtml(path: string, cookie: string): Promise<string> {
  const page = await open(path, cookie);
  try {
    await page.locator('#account-menu input[name="csrf_token"]').waitFor({ state: 'attached' });
    return await page.locator('#account-menu').innerHTML();
  } finally {
    await page.context().close();
  }
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await check()).toBe(true);
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
  'a signed-in person sees their library newest first, filtered by state, paged',
  async () => {
    reset();
    const cookie = await alice();
    const page = await readPage('/en/library', cookie);
    expect(page.status).toBe(200);
    expect(page.cache).toMatch(/\bno-store\b/);
    const body = main(page.html);
    expect(body).toContain('Library');
    // The All tab has a section per status that holds entries, each newest first: Planned, then Completed.
    expect(body.indexOf('Unavailable')).toBeLessThan(body.indexOf('Apple story'));
    expect(body.indexOf('Apple story')).toBeLessThan(body.indexOf('Zebra story'));
    // The fake serves no definitions, so the type has no name to show and its raw value stays out.
    expect(body).not.toContain('book');
    expect(body).toContain(`dateTime="${newerStamp}"`);
    expect(body).toContain(shortDate(newerStamp, 'en'));
    expect(body).toContain(shortDate(middleStamp, 'en'));
    expect(body).toContain(shortDate(olderStamp, 'en'));
    expect(visible(page.html)).toContain('Unavailable');
    expect(visible(page.html)).not.toContain(hiddenSubjectId);
    const found = links(page.html);
    expect(found.find((link) => link.text === 'Zebra story')?.href).toBe(
      `/en/subjects/${id(11)}/${slug('Zebra story')}`,
    );
    expect(found.find((link) => link.text === 'Apple story')?.href).toBe(
      `/en/subjects/${id(12)}/${slug('Apple story')}`,
    );
    expect(found.some((link) => link.href.includes(hiddenSubjectId) || link.text === hiddenSubjectId)).toBe(false);
    const tab = (text: string) => found.find((link) => link.text === text);
    expect(tab('All')).toMatchObject({ href: '/en/library', current: true });
    expect(tab('Planned')?.href).toBe('/en/library?state=planned');
    expect(tab('In progress')?.href).toBe('/en/library?state=in_progress');
    expect(tab('Completed')?.href).toBe('/en/library?state=completed');
    expect(tab('Paused')?.href).toBe('/en/library?state=paused');
    expect(tab('Dropped')?.href).toBe('/en/library?state=dropped');
    expect(tab('Planned')?.current).toBe(false);
    // One read per status, each of the first twelve entries.
    const reads = libraryReads();
    expect(reads).toHaveLength(5);
    expect(reads.map((read) => read.state).sort()).toEqual([
      'completed',
      'dropped',
      'in_progress',
      'paused',
      'planned',
    ]);
    for (const read of reads)
      expect(read).toMatchObject({
        method: 'GET',
        path: '/v1/libraryEntries',
        view: 'FULL',
        limit: sectionLimit,
        cursor: null,
        authorization: `Bearer ${aliceAccess}`,
      });

    calls.length = 0;
    const completed = await readPage('/en/library?state=completed', cookie);
    expect(completed.status).toBe(200);
    const completedMain = main(completed.html);
    expect(completedMain).toContain('Zebra story');
    expect(completedMain).not.toContain('Apple story');
    expect(completedMain).not.toContain('Unavailable');
    expect(links(completed.html).find((link) => link.text === 'Completed')).toMatchObject({
      href: '/en/library?state=completed',
      current: true,
    });
    expect(libraryReads()).toHaveLength(1);
    expect(libraryReads()[0]).toMatchObject({
      view: 'FULL',
      limit: tabLimit,
      cursor: null,
      state: 'completed',
      authorization: `Bearer ${aliceAccess}`,
    });

    calls.length = 0;
    const planned = await readPage('/en/library?state=planned', cookie);
    const plannedMain = main(planned.html);
    expect(plannedMain).not.toContain('Zebra story');
    expect(plannedMain.indexOf('Unavailable')).toBeLessThan(plannedMain.indexOf('Apple story'));
    expect(links(planned.html).find((link) => link.text === 'Planned')?.current).toBe(true);

    calls.length = 0;
    const empty = await readPage('/en/library?state=in_progress', cookie);
    expect(main(empty.html)).toContain('Nothing in In progress yet');
    expect(main(empty.html)).not.toContain('Zebra story');
    expect(libraryReads()[0]?.state).toBe('in_progress');

    const japanese = await readPage('/ja/library', cookie);
    expect(japanese.status).toBe(200);
    const japaneseMain = main(japanese.html);
    expect(japaneseMain).toContain('ライブラリ');
    expect(japaneseMain).toContain('完了');
    expect(japaneseMain).toContain(shortDate(newerStamp, 'ja'));
    expect(japaneseMain.indexOf('Apple story')).toBeLessThan(japaneseMain.indexOf('Zebra story'));

    calls.length = 0;
    entries = longLibrary();
    const first = await readPage('/en/library?state=planned', cookie);
    expect(first.status).toBe(200);
    const firstMain = main(first.html);
    expect(firstMain.indexOf('Entry 001')).toBeLessThan(firstMain.indexOf('Entry 002'));
    expect(firstMain.indexOf('Entry 002')).toBeLessThan(firstMain.indexOf('Entry 048'));
    expect(firstMain).not.toContain('Entry 049');
    const firstRead = libraryReads()[0];
    expect(firstRead).toMatchObject({ view: 'FULL', limit: tabLimit, cursor: null, state: 'planned' });
    const more = links(first.html).find((link) => link.text === 'More');
    expect(more?.href).toContain('/en/library?');
    expect(new URL(more!.href, 'http://site.test').searchParams.get('state')).toBe('planned');
    const cursor = new URL(more!.href, 'http://site.test').searchParams.get('cursor');
    expect(cursor).toBeTruthy();
    expect([...cursors.keys()]).toContain(cursor);
    calls.length = 0;
    const second = await readPage(more!.href, cookie);
    expect(second.status).toBe(200);
    const secondMain = main(second.html);
    expect(secondMain).toContain('Entry 049');
    expect(secondMain).not.toContain('Entry 001');
    expect(libraryReads()[0]).toMatchObject({ view: 'FULL', limit: tabLimit, cursor, state: 'planned' });
  },
  timeout,
);

test(
  "a person changes an entry's state or removes it, and a stale revision is explained",
  async () => {
    reset();
    const page = await open('/en/library', await alice());
    try {
      const zebra = page.locator('main article').filter({ hasText: 'Zebra story' });
      expect(await zebra.count()).toBe(1);
      const choose = async (title: string, name: string) => {
        await page.getByRole('button', { name: `Actions for ${title}` }).click();
        await page.getByRole('menuitem', { name: 'Change status' }).click();
        await page.getByRole('menuitemradio', { name: name, exact: true }).click();
        // The menu stays open after a choice; Escape closes the submenu, then the menu.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.getByRole('menu').first().waitFor({ state: 'detached' });
      };
      calls.length = 0;
      await choose('Zebra story', 'Paused');
      await eventually(() => calls.some((call) => call.method === 'PUT'));
      const put = calls.find((call) => call.method === 'PUT');
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([put]);
      expect(put).toMatchObject({
        method: 'PUT',
        path: `/v1/libraryEntries/${id(11)}`,
        authorization: `Bearer ${aliceAccess}`,
        body: { state: 'paused', revision: 4 },
      });
      const key = put!.key!;
      expect(key).toMatch(uuid);
      // The card, in the Completed section, now says where the entry went.
      await eventually(async () => (await zebra.innerText()).includes('Paused'));

      diverge(id(11), 'dropped');
      calls.length = 0;
      await choose('Zebra story', 'Completed');
      await eventually(() =>
        calls.some((call) => call.method === 'GET' && call.path === `/v1/libraryEntries/${id(11)}`),
      );
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT /v1/libraryEntries/${id(11)}`,
        `GET /v1/libraryEntries/${id(11)}`,
      ]);
      expect(calls[0]).toMatchObject({
        authorization: `Bearer ${aliceAccess}`,
        body: { state: 'completed', revision: 5 },
      });
      // Each answered write takes a fresh idempotency key.
      expect(calls[0]!.key).toMatch(uuid);
      expect(calls[0]!.key).not.toBe(key);
      expect(calls[1]).toMatchObject({ view: 'FULL', authorization: `Bearer ${aliceAccess}` });
      expect(entries.find((item) => item.subjectId === id(11))).toMatchObject({
        state: 'dropped',
        revision: 10,
        updatedAt: reloadedStamp,
      });
      await eventually(async () => (await zebra.innerText()).includes('Dropped'));
      expect(await zebra.locator('time').getAttribute('datetime')).toBe(reloadedStamp);
      expect(await zebra.getByRole('status').innerText()).toBe('This entry changed elsewhere.');

      const apple = page.locator('main article').filter({ hasText: 'Apple story' });
      expect(await apple.count()).toBe(1);
      calls.length = 0;
      await page.getByRole('button', { name: 'Actions for Apple story' }).click();
      await page.getByRole('menuitem', { name: 'Remove from library', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm removal', exact: true }).click();
      await eventually(() => calls.some((call) => call.method === 'DELETE'));
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE /v1/libraryEntries/${id(12)}`]);
      expect(calls[0]).toMatchObject({ revision: '2', authorization: `Bearer ${aliceAccess}` });
      expect(calls[0]!.key).toMatch(uuid);
      await eventually(async () => (await apple.count()) === 0);
      expect(await page.locator('main article').filter({ hasText: 'Zebra story' }).count()).toBe(1);
      expect(await page.locator('main').innerText()).toContain('Unavailable');
      expect(entries.some((item) => item.subjectId === id(12))).toBe(false);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the account menu links to the library',
  async () => {
    reset();
    const cookie = await alice();
    const english = await readPage('/en/library', cookie);
    expect(english.status).toBe(200);
    const menu = await accountMenuHtml('/en/library', cookie);
    const menuLinks = linksIn(menu);
    expect(menuLinks.find((link) => link.text === 'Library')?.href).toBe('/en/library');
    expect(menuLinks.find((link) => link.text === 'Collections')?.href).toBe('/en/collections');
    expect(menuLinks.find((link) => link.text === 'Following')?.href).toBe('/en/following');
    const tabs = /<nav\b[^>]*aria-label="States"[^>]*>([\s\S]*?)<\/nav>/.exec(main(english.html))?.[1] ?? '';
    const tabLinks = linksIn(tabs);
    expect(tabLinks.find((link) => link.text === 'All')).toMatchObject({ href: '/en/library', current: true });
    expect(tabLinks.find((link) => link.text === 'Collections')?.href).toBe('/en/library/collections');

    const japanese = await readPage('/ja/library', cookie);
    expect(japanese.status).toBe(200);
    const japaneseMenu = await accountMenuHtml('/ja/library', cookie);
    const japaneseLinks = linksIn(japaneseMenu);
    expect(japaneseLinks.find((link) => link.text === 'ライブラリ')?.href).toBe('/ja/library');
    expect(japaneseLinks.find((link) => link.text === 'コレクション')?.href).toBe('/ja/collections');
    expect(japaneseLinks.find((link) => link.text === 'フォロー中')?.href).toBe('/ja/following');
    const japaneseTabs = /<nav\b[^>]*aria-label="状態"[^>]*>([\s\S]*?)<\/nav>/.exec(main(japanese.html))?.[1] ?? '';
    const japaneseTabLinks = linksIn(japaneseTabs);
    expect(japaneseTabLinks.find((link) => link.text === 'すべて')).toMatchObject({
      href: '/ja/library',
      current: true,
    });
    expect(japaneseTabLinks.find((link) => link.text === 'コレクション')?.href).toBe('/ja/library/collections');
  },
  timeout,
);

test(
  'signed out, the library offers sign-in',
  async () => {
    reset();
    const page = await readPage('/en/library');
    expect(page.status).toBe(200);
    expect(page.cache).toMatch(/\bno-store\b/);
    const body = main(page.html);
    expect(body).toContain('Library');
    expect(body).not.toContain('Zebra story');
    expect(body).not.toContain('Your library is empty.');
    const signInLink = links(page.html).find((link) => link.text === 'Sign in to see your library.');
    expect(signInLink?.href).toBe('/auth/sign-in?return_to=%2Fen%2Flibrary');
    expect(calls.some((call) => call.path.startsWith('/v1/libraryEntries'))).toBe(false);

    const japanese = await readPage('/ja/library');
    expect(japanese.status).toBe(200);
    const japaneseLink = links(japanese.html).find(
      (link) => link.text === 'ライブラリを見るにはサインインしてください。',
    );
    expect(japaneseLink?.href).toBe('/auth/sign-in?return_to=%2Fja%2Flibrary');
    expect(main(japanese.html)).not.toContain('Zebra story');
  },
  timeout,
);
