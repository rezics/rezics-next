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
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];
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
const stamp = '2026-04-02T15:04:05.000Z';
const reloadedStamp = '2026-05-01T00:00:00.000Z';
const coverMedia = id(9001);
const messages = (locale: string) =>
  Bun.file(join(app, 'messages', `${locale}.json`)).json() as Promise<Record<string, string>>;

// The documented cover summary of a subject read: the image, its placeholder and its variants.
const coverSummary = {
  media: coverMedia,
  width: 600,
  height: 900,
  placeholder: { thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==', color: '#3a4a73' },
  variants: [
    { format: 'avif', width: 96 },
    { format: 'webp', width: 96 },
    { format: 'webp', width: 192 },
  ],
  focalPoint: null,
  credit: {
    rightsHolder: 'Fixture Press',
    via: { name: 'Fixtures', url: 'https://example.test/' },
    license: 'CC0-1.0',
    obligations: [],
  },
};
function summary(n: number, label: string, withCover: boolean) {
  return {
    id: id(n),
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: label, language: 'en' },
    creativeWork: true,
    cover: withCover ? coverSummary : null,
  };
}
const zebra = summary(11, 'Zebra story', true);
const apple = summary(12, 'Apple story', false);
const hiddenSubjectId = 'unavailable-subject-should-not-appear';

type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
type Entry = {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: typeof zebra | null;
};
const entry = (subjectId: string, state: EntryState, revision: number, subject: Entry['subject']): Entry => ({
  subjectId,
  state,
  revision,
  createdAt: stamp,
  updatedAt: stamp,
  subject,
});
const showcase = (): Entry[] => [
  entry(zebra.id, 'completed', 4, zebra),
  entry(hiddenSubjectId, 'planned', 1, null),
  entry(apple.id, 'planned', 2, apple),
];
let entries = showcase();

const owner = { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' };
const shelfId = id(100);
const shelf = {
  id: shelfId,
  curatorAccountId: 'alice',
  title: 'Night shelf',
  description: null,
  visibility: 'public',
  revision: 1,
  memberCount: 3,
  createdAt: stamp,
  updatedAt: stamp,
  curator: owner,
};
const members = [
  { id: id(301), subjectId: zebra.id, note: 'First note', addedAt: stamp, subject: zebra },
  { id: id(302), subjectId: hiddenSubjectId, note: null, addedAt: stamp, subject: null },
  { id: id(303), subjectId: apple.id, note: null, addedAt: stamp, subject: apple },
];
const follows = [
  {
    targetId: zebra.id,
    targetType: 'subject',
    state: 'following',
    reason: 'explicit',
    updatedAt: stamp,
    target: zebra,
  },
  { targetId: apple.id, targetType: 'subject', state: 'following', reason: 'library', updatedAt: stamp, target: apple },
  {
    targetId: shelfId,
    targetType: 'collection',
    state: 'following',
    reason: 'explicit',
    updatedAt: stamp,
    target: { id: shelfId, type: 'collection', label: 'Night shelf' },
  },
  {
    targetId: hiddenSubjectId,
    targetType: 'subject',
    state: 'following',
    reason: 'explicit',
    updatedAt: stamp,
    target: null,
  },
];
const copies = [
  {
    id: id(401),
    subjectId: zebra.id,
    status: 'owned',
    revision: 1,
    location: 'Study',
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: null,
    subject: zebra,
  },
  {
    id: id(402),
    subjectId: apple.id,
    status: 'ordered',
    revision: 1,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: null,
    subject: apple,
  },
  {
    id: id(403),
    subjectId: hiddenSubjectId,
    status: 'lent',
    revision: 1,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: null,
    subject: null,
  },
];
const sessionId = id(80);
const progress = {
  id: sessionId,
  subjectId: zebra.id,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'page',
  total: '300',
  amount: '12',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 1,
  startedAt: stamp,
  completedAt: null,
  subject: zebra,
};
const publishedLog = {
  id: id(90),
  sessionState: 'active',
  startedAt: stamp,
  completedAt: null,
  note: 'Halfway',
  publishedAt: stamp,
  subject: zebra,
  account: owner,
};

type Call = { method: string; path: string; key: string | null; revision: string | null; body: unknown };
const calls: Call[] = [];
function reset() {
  calls.length = 0;
  entries = showcase();
}
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

// OpenID provider and kernel fake, copied from library-entries.test.ts.
// OpenID provider copied from posting.test.ts; library writes send the website's access token.
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

    if (url.pathname === '/v1/definitions/active') return json({ digest: 'rebuild-1' });
    if (url.pathname === '/v1/definitions/releases/rebuild-1')
      return json({
        digest: 'rebuild-1',
        release: { types: { 'schema:Book': { labels: { en: 'Book', 'zh-Hans': '书籍' } } }, properties: {} },
      });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body = request.method === 'PUT' || request.method === 'POST' ? await request.json().catch(() => null) : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      key: request.headers.get('idempotency-key'),
      revision: url.searchParams.get('revision'),
      body,
    });
    const page = <T>(rows: T[], key: string) => json({ [key]: rows, next: null });
    if (request.method === 'GET') {
      // Collections are public here; a signed-out reader sees them as everyone does.
      if (url.pathname === '/v1/collections') return page([shelf], 'collections');
      if (url.pathname === `/v1/collections/${shelfId}`) return json({ collection: shelf });
      if (url.pathname === `/v1/collections/${shelfId}/members`) return page(members, 'members');
      if (url.pathname === `/v1/publishedLogs/${publishedLog.id}`) return json({ publishedLog });
    }
    // Unknown routes, including the anonymous home read, answer 404; a bearer is required only for personal records.
    if (!/^\/v1\/(libraryEntries|follows|copies|publishedLogs|progressSessions)(\/|$)/.test(url.pathname))
      return json(problem(404, 'not_found'), 404, true);
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (request.method === 'GET') {
      if (url.pathname === '/v1/libraryEntries') {
        const state = url.searchParams.get('state');
        return page(
          entries.filter((item) => !state || item.state === state),
          'libraryEntries',
        );
      }
      if (url.pathname === '/v1/follows') return page(follows, 'follows');
      if (url.pathname === '/v1/copies') return page(copies, 'copies');
      if (url.pathname === '/v1/publishedLogs') return page([publishedLog], 'publishedLogs');
      if (url.pathname === '/v1/progressSessions') return page([progress], 'progressSessions');
      if (url.pathname === `/v1/progressSessions/${sessionId}`) return json({ progressSession: progress });
      if (url.pathname === `/v1/progressSessions/${sessionId}/changes`) return page([], 'changes');
      if (url.pathname === `/v1/progressSessions/${sessionId}/completedUnits`) return page([], 'completedUnits');
    }
    const subjectId = /^\/v1\/libraryEntries\/([^/]+)$/.exec(url.pathname)?.[1];
    const current = entries.find((item) => item.subjectId === decodeURIComponent(subjectId ?? ''));
    if (!current) return json(problem(404, 'not_found'), 404, true);
    if (request.method === 'PUT') {
      const draft = body as { state?: EntryState; revision?: number };
      if (draft.revision !== current.revision || !draft.state) return json(problem(409, 'conflict'), 409, true);
      current.state = draft.state;
      current.revision += 1;
      current.updatedAt = reloadedStamp;
      const { subject: _subject, ...saved } = current;
      return json({ libraryEntry: saved });
    }
    if (request.method === 'DELETE') {
      if (Number(url.searchParams.get('revision')) !== current.revision)
        return json(problem(409, 'conflict'), 409, true);
      entries = entries.filter((item) => item.subjectId !== current.subjectId);
      return new Response(null, { status: 204 });
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

let browser: Browser | undefined;

async function readPage(path: string, cookie?: string) {
  const response = await fetch(`${await site()}${path}`, {
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  return { status: response.status, html: await response.text() };
}
function main(html: string) {
  return /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
}
/** The list items of the page's main content, as markup. */
function rows(html: string) {
  return [...main(html).matchAll(/<li\b[\s\S]*?<\/li>/g)].map((match) => match[0]);
}
function articles(html: string) {
  return [...main(html).matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0]);
}
const covers = (markup: string) => [...markup.matchAll(/data-slot="cover"/g)].length;
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const withTitle = (list: string[], title: string) => list.find((item) => item.includes(title))!;
/** A subject with an image draws it from the site's media route; a subject without one draws its placeholder. */
function expectImage(markup: string) {
  expect(covers(markup), 'one cover').toBe(1);
  expect(markup).toContain(`/media/${coverMedia}/webp-96`);
  expect(markup).toContain(`/media/${coverMedia}/avif-96`);
  expect(markup).not.toContain('data-state="placeholder"');
}
function expectPlaceholder(markup: string) {
  expect(covers(markup), 'one cover').toBe(1);
  expect(markup).toContain('data-state="placeholder"');
  expect(markup).not.toContain('/media/');
}

async function open(path: string, cookie: string, size = { width: 1280, height: 860 }): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
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
  'a library entry shows its cover, title and last update on a card, and as a compact row with the localized type, a status chip and an item menu with its other actions',
  async () => {
    reset();
    const cookie = await alice();
    // The grid: one card per entry, each a cover over its title, linking to the subject.
    const gridPage = await readPage('/en/library', cookie);
    expect(gridPage.status).toBe(200);
    const cards = articles(gridPage.html);
    expect(cards).toHaveLength(3);
    expectImage(withTitle(cards, 'Zebra story'));
    expect(withTitle(cards, 'Zebra story')).toContain('data-ratio="2:3"');
    expect(withTitle(cards, 'Zebra story')).toContain(`href="/en/subjects/${zebra.id}"`);
    expectPlaceholder(withTitle(cards, 'Apple story'));
    expectPlaceholder(withTitle(cards, 'Unavailable'));
    expect(main(gridPage.html)).not.toContain(hiddenSubjectId);

    // The list: Reads work without JavaScript, so the cover, title, type and status are all in the document.
    const page = await readPage('/en/library?layout=list', cookie);
    expect(page.status).toBe(200);
    const list = rows(page.html);
    expect(list).toHaveLength(3);
    const first = withTitle(list, 'Zebra story');
    expectImage(first);
    expect(first).toContain('data-ratio="2:3"');
    expect(first).toContain(`href="/en/subjects/${zebra.id}"`);
    expect(text(first)).toContain('Book');
    expect(text(first)).toContain('Completed');
    expectPlaceholder(withTitle(list, 'Apple story'));
    const hidden = withTitle(list, 'Unavailable');
    expectPlaceholder(hidden);
    expect(hidden).not.toContain(hiddenSubjectId);
    for (const row of list) {
      expect(row).not.toMatch(/<select|<details|<summary/);
      expect(text(row)).not.toContain('Save');
      expect(text(row)).not.toContain('Remove');
    }
    const chinese = await readPage('/zh-Hans/library?layout=list', cookie);
    const own = await messages('zh-Hans');
    expect(text(withTitle(rows(chinese.html), 'Zebra story'))).toContain('书籍');
    expect(text(withTitle(rows(chinese.html), 'Zebra story'))).toContain(own.library_state_completed!);

    const browserPage = await open('/en/library?layout=list', cookie);
    try {
      const row = browserPage.locator('main li').filter({ hasText: 'Zebra story' });
      expect(await row.count()).toBe(1);
      // One compact row.
      expect((await row.boundingBox())!.height).toBeLessThan(120);
      expect(await row.locator('[data-slot="cover"]').count()).toBe(1);
      expect(await row.getByRole('button', { name: 'Save' }).count()).toBe(0);

      // The item menu holds the other actions: copies, reading progress and removal.
      const menu = browserPage.getByRole('menu');
      await row.getByRole('button', { name: 'Actions for Zebra story' }).click();
      await menu.getByRole('menuitem', { name: 'Copies' }).waitFor({ state: 'visible' });
      expect(await menu.getByRole('menuitem', { name: 'Copies' }).count()).toBe(1);
      expect(await menu.getByRole('menuitem', { name: 'Reading progress' }).count()).toBe(1);
      expect(await menu.getByRole('menuitem', { name: 'Remove from library' }).count()).toBe(1);
      await menu.getByRole('menuitem', { name: 'Copies' }).click();
      await browserPage.waitForURL(`**/en/library/copies?subjectId=${zebra.id}`);
      await browserPage.goto(`${await site()}/en/library?layout=list`, { waitUntil: 'networkidle' });
      await browserPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await row.waitFor();

      // Choosing a state saves it: one write, no Save button.
      calls.length = 0;
      await row.getByRole('button', { name: 'Completed' }).click();
      await browserPage.getByRole('menuitemradio', { name: 'Paused' }).click();
      await eventually(() => calls.some((call) => call.method === 'PUT'));
      expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
      expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: `/v1/libraryEntries/${zebra.id}`,
        body: { state: 'paused', revision: 4 },
      });
      expect(calls.find((call) => call.method === 'PUT')!.key).toMatch(uuid);
      await eventually(async () => (await row.getByRole('button', { name: 'Paused' }).count()) === 1);

      // Removal asks first, then sends the revision the row holds.
      calls.length = 0;
      await row.getByRole('button', { name: 'Actions for Zebra story' }).click();
      await browserPage.getByRole('menuitem', { name: 'Remove from library' }).click();
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
      await browserPage.getByRole('alertdialog').getByRole('button', { name: 'Confirm removal', exact: true }).click();
      await eventually(() => calls.some((call) => call.method === 'DELETE'));
      expect(calls.find((call) => call.method === 'DELETE')).toMatchObject({
        path: `/v1/libraryEntries/${zebra.id}`,
        revision: '5',
      });
      await eventually(async () => (await row.count()) === 0);
    } finally {
      await browserPage.context().close();
    }
  },
  timeout,
);

test(
  "collection pages and the collections list show each member's or collection's covers",
  async () => {
    reset();
    const cookie = await alice();
    for (const viewer of [cookie, undefined]) {
      const page = await readPage(`/en/collections/${shelfId}`, viewer);
      expect(page.status).toBe(200);
      const list = rows(page.html);
      expect(list).toHaveLength(3);
      expectImage(withTitle(list, 'Zebra story'));
      expectPlaceholder(withTitle(list, 'Apple story'));
      const hidden = withTitle(list, 'Unavailable');
      expectPlaceholder(hidden);
      expect(hidden).not.toContain(hiddenSubjectId);
      expect(text(withTitle(list, 'Zebra story'))).toContain('Book');
      expect(text(withTitle(list, 'Zebra story'))).toContain('First note');
    }
    // The curator's controls stay on each member.
    const owned = await readPage(`/en/collections/${shelfId}`, cookie);
    expect(text(withTitle(rows(owned.html), 'Zebra story'))).toContain('Move down');

    const mine = await readPage('/en/library/collections', cookie);
    expect(mine.status).toBe(200);
    const shelves = articles(mine.html);
    expect(shelves).toHaveLength(1);
    expectPlaceholder(shelves[0]!);
    expect(shelves[0]).toContain('data-ratio="1:1"');
    expect(text(shelves[0]!)).toContain('Night shelf');
  },
  timeout,
);

test(
  "progress, copies and following pages show each subject's cover and keep their existing behaviour",
  async () => {
    reset();
    const cookie = await alice();

    const copyPage = await readPage('/en/library/copies', cookie);
    expect(copyPage.status).toBe(200);
    const copyList = articles(copyPage.html);
    expect(copyList).toHaveLength(3);
    expectImage(withTitle(copyList, 'Zebra story'));
    expectPlaceholder(withTitle(copyList, 'Apple story'));
    expectPlaceholder(withTitle(copyList, 'Unavailable'));
    expect(withTitle(copyList, 'Zebra story')).toContain('Study');
    expect(text(withTitle(copyList, 'Zebra story'))).toContain('Save');
    expect(text(withTitle(copyList, 'Zebra story'))).toContain('Delete');

    const progressPage = await readPage(`/en/library/progress?subjectId=${zebra.id}`, cookie);
    expect(progressPage.status).toBe(200);
    const sessions = rows(progressPage.html);
    expect(sessions).toHaveLength(1);
    expectImage(sessions[0]!);
    expect(sessions[0]).toContain(`href="/en/library/progress/${sessionId}"`);

    const sessionPage = await readPage(`/en/library/progress/${sessionId}`, cookie);
    expect(sessionPage.status).toBe(200);
    const header = /<header\b[\s\S]*?<\/header>/.exec(main(sessionPage.html))![0];
    expectImage(header);
    expect(text(header)).toContain('Zebra story');
    // The published logs on the same page show the subject's cover too.
    expectImage(withTitle(rows(sessionPage.html), 'Halfway'));

    const followingPage = await readPage('/en/library/following', cookie);
    expect(followingPage.status).toBe(200);
    const followed = articles(followingPage.html);
    expect(followed).toHaveLength(4);
    expectImage(withTitle(followed, 'Zebra story'));
    expectPlaceholder(withTitle(followed, 'Apple story'));
    expectPlaceholder(withTitle(followed, 'Night shelf'));
    expect(withTitle(followed, 'Night shelf')).toContain(`href="/en/collections/${shelfId}"`);
    expectPlaceholder(withTitle(followed, 'Unavailable'));
    for (const card of followed) expect(card).toContain('aria-label="More actions for ');
    expect(main(followingPage.html)).not.toContain(hiddenSubjectId);
  },
  timeout,
);
