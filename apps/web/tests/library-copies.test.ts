import { browserSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
const pageLimit = '100';

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
const accessSubjects = new Map<string, string>();
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
const edition = id(11);
const hiddenSubjectId = 'unavailable-subject-should-not-appear';
const newSubject = id(21);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CopyStatus = 'ordered' | 'owned' | 'lent' | 'disposed';
type Subject = { id: string; label: string; type: string } | null;
type StoredCopy = {
  id: string;
  accountId: string;
  subjectId: string;
  subject: Subject;
  status: CopyStatus;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};
type Draft = {
  subjectId?: string;
  status?: CopyStatus;
  location?: string | null;
  source?: string | null;
  acquiredOn?: string | null;
  disposedOn?: string | null;
  note?: string | null;
  revision?: number;
};

const zebra: Subject = { id: edition, label: 'Zebra story', type: 'book' };
const copies: StoredCopy[] = [];
let serial = 100;
function make(input: Omit<StoredCopy, 'id' | 'revision'> & { revision?: number }): StoredCopy {
  serial += 1;
  return { id: id(serial), revision: input.revision ?? 1, ...input };
}
function seedDefault() {
  copies.length = 0;
  serial = 100;
  copies.push(
    make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: null,
      note: 'First copy',
    }),
    make({
      accountId: 'alice',
      subjectId: hiddenSubjectId,
      subject: null,
      status: 'ordered',
      location: null,
      source: null,
      acquiredOn: null,
      disposedOn: null,
      note: 'Waiting',
    }),
    make({
      accountId: 'blake',
      subjectId: id(12),
      subject: { id: id(12), label: 'Secret story', type: 'book' },
      status: 'owned',
      location: 'Vault',
      source: 'Private',
      acquiredOn: '2030-01-02',
      disposedOn: null,
      note: 'Secret other copy',
    }),
  );
}
seedDefault();

type Call = {
  method: string;
  path: string;
  search: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  revision: string | null;
  body: unknown;
  key: string | null;
  authorization: string | null;
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
function reset() {
  calls.length = 0;
  seedDefault();
}
function wire(copy: StoredCopy, full: boolean) {
  const { accountId: _accountId, subject, ...rest } = copy;
  return full ? { ...rest, subject } : rest;
}
function applyDraft(copy: StoredCopy, draft: Draft) {
  if (draft.status) copy.status = draft.status;
  if ('location' in draft) copy.location = draft.location ?? null;
  if ('source' in draft) copy.source = draft.source ?? null;
  if ('acquiredOn' in draft) copy.acquiredOn = draft.acquiredOn ?? null;
  if ('disposedOn' in draft) copy.disposedOn = draft.disposedOn ?? null;
  if ('note' in draft) copy.note = draft.note ?? null;
  copy.revision += 1;
}

// OpenID provider copied from posting.test.ts; copy routes are the viewer's own library.
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
      accessSubjects.set(access, family.sub);
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

    const token = request.headers.get('authorization') ?? '';
    const accountId = token.startsWith('Bearer ') ? accessSubjects.get(token.slice('Bearer '.length)) : undefined;
    let body: unknown = null;
    if (request.method === 'POST' || request.method === 'PATCH') body = await request.json().catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      revision: url.searchParams.get('revision'),
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    // Home reads POST /v1/pages/$read with no session. Unknown routes answer 404, as posting.test.ts does,
    // so that read is a missing page rather than a 401 that fails the document.
    const copyRoute = url.pathname === '/v1/copies' || /^\/v1\/copies\/([^/]+)$/.test(url.pathname);
    if (!copyRoute) return json(problem(404, 'not_found'), 404, true);
    if (!accountId) return json(problem(401, 'unauthorized'), 401, true);
    const key = request.headers.get('idempotency-key');
    const writing = request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE';
    if (writing && (!key || key.length < 3)) return json(problem(400, 'invalid_request'), 400, true);

    if (request.method === 'GET' && url.pathname === '/v1/copies') {
      const full = url.searchParams.get('view') === 'FULL';
      const subjectId = url.searchParams.get('subjectId');
      const owned = copies.filter(
        (copy) => copy.accountId === accountId && (subjectId === null || copy.subjectId === subjectId),
      );
      return json({ copies: owned.map((copy) => wire(copy, full)), next: null });
    }
    if (request.method === 'POST' && url.pathname === '/v1/copies') {
      const draft = (body ?? {}) as Draft;
      const created = make({
        accountId,
        subjectId: draft.subjectId ?? '',
        subject: copies.find((copy) => copy.subjectId === draft.subjectId)?.subject ?? null,
        status: draft.status ?? 'owned',
        location: draft.location ?? null,
        source: draft.source ?? null,
        acquiredOn: draft.acquiredOn ?? null,
        disposedOn: draft.disposedOn ?? null,
        note: draft.note ?? null,
      });
      copies.push(created);
      return json({ copy: wire(created, false) }, 201);
    }
    const one = /^\/v1\/copies\/([^/]+)$/.exec(url.pathname);
    if (!one) return json(problem(404, 'not_found'), 404, true);
    const current = copies.find((copy) => copy.id === one[1] && copy.accountId === accountId);
    if (!current) return json(problem(404, 'not_found'), 404, true);
    if (request.method === 'GET') {
      const full = url.searchParams.get('view') === 'FULL';
      return json({ copy: wire(current, full) });
    }
    if (request.method === 'PATCH') {
      const draft = (body ?? {}) as Draft;
      if (draft.revision !== current.revision) return json(problem(409, 'conflict'), 409, true);
      applyDraft(current, draft);
      return json({ copy: wire(current, false) });
    }
    if (request.method === 'DELETE') {
      if (url.searchParams.get('revision') !== String(current.revision))
        return json(problem(409, 'conflict'), 409, true);
      const index = copies.findIndex((copy) => copy.id === current.id);
      if (index >= 0) copies.splice(index, 1);
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

async function signIn(returnTo = '/en') {
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
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  const issued = [...accessSubjects.keys()].at(-1);
  expect(issued, 'access token setup').toBeTruthy();
  return { session: sessionCookie!, access: issued! };
}

let browser: Browser | undefined;
async function open(path: string) {
  const auth = await signIn(path);
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
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
  const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return { page, access: auth.access, origin, response };
}
function observe(page: Page) {
  const requests: BrowserRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request);
  });
  return requests;
}
const article = (page: Page, text: string) => page.locator('main article').filter({ hasText: text });
const lists = () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/copies');

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
  'a signed-in person lists their copies and adds one with its status, location, source, dates and note',
  async () => {
    reset();
    const { page, access, origin, response } = await open('/en/library/copies');
    try {
      expect(response?.status()).toBe(200);
      expect(response?.headers()['cache-control'] ?? '').toMatch(/\bno-store\b/);
      const main = page.locator('main');
      expect(await main.getByRole('heading', { level: 1 }).innerText()).toBe('Copies');
      const first = article(page, 'First copy');
      expect(await first.getByRole('link', { name: 'Zebra story' }).getAttribute('href')).toBe(
        `/en/subjects/${edition}`,
      );
      // The fake serves no definitions, so the type has no name to show and its raw value stays out.
      expect(await first.innerText()).not.toContain('book');
      expect(await first.getByLabel('Status').inputValue()).toBe('owned');
      expect(await first.getByLabel('Location').inputValue()).toBe('Study');
      expect(await first.getByLabel('Source').inputValue()).toBe('Bookshop');
      expect(await first.getByLabel('Acquired').inputValue()).toBe('2030-01-01');
      expect(await first.getByLabel('Disposed on').inputValue()).toBe('');
      expect(await first.getByLabel('Note').inputValue()).toBe('First copy');
      const waiting = article(page, 'Waiting');
      expect(await waiting.innerText()).toContain('Unavailable');
      expect(await waiting.getByLabel('Status').inputValue()).toBe('ordered');
      expect(await main.innerHTML()).not.toContain(hiddenSubjectId);
      expect(await main.innerText()).not.toContain('Secret other copy');
      for (const sentence of [
        'You have asked for this copy and do not have it yet.',
        'This copy is with you.',
        'You have lent this copy to someone else.',
        'You no longer have this copy.',
        'The day this copy came to you.',
        'The day you let this copy go.',
      ])
        expect(await main.innerText()).toContain(sentence);
      const reads = lists();
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every(
          (call) =>
            call.view === 'FULL' &&
            call.limit === pageLimit &&
            call.authorization === `Bearer ${access}` &&
            !new URLSearchParams(call.search).has('subjectId'),
        ),
      ).toBe(true);
      expect(calls.filter((call) => call.method === 'GET' && /^\/v1\/copies\/.+/.test(call.path))).toHaveLength(0);

      const add = main.getByRole('form', { name: 'Add a copy' });
      const html = await add.evaluate((element) => element.outerHTML);
      await add.getByLabel('Edition').fill(newSubject);
      await add.getByLabel('Status').selectOption({ label: 'Disposed' });
      await add.getByLabel('Location').fill('Shelf');
      await add.getByLabel('Source').fill('Shop');
      await add.getByLabel('Acquired').fill('2030-02-02');
      await add.getByLabel('Disposed on').fill('2030-02-20');
      await add.getByLabel('Note').fill('Second shelf');
      const requests = observe(page);
      await add.getByRole('button', { name: 'Add copy' }).click();
      const created = article(page, 'Second shelf');
      await created.waitFor({ timeout: 15_000 });
      expect(requests).toHaveLength(1);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      expect(requests[0]!.headers()['x-csrf-token']).toBe(csrf);
      expect(new URL(requests[0]!.url()).origin).toBe(origin);
      const posts = calls.filter((call) => call.method === 'POST' && call.path === '/v1/copies');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.key).toMatch(uuid);
      expect(html).toContain(posts[0]!.key!);
      expect(posts[0]?.authorization).toBe(`Bearer ${access}`);
      expect(posts[0]?.body).toEqual({
        subjectId: newSubject,
        status: 'disposed',
        location: 'Shelf',
        source: 'Shop',
        acquiredOn: '2030-02-02',
        disposedOn: '2030-02-20',
        note: 'Second shelf',
      });
      expect(await created.innerText()).toContain('Unavailable');
      expect(await created.innerText()).toContain('2030-02-02');
      expect(await created.innerText()).toContain('2030-02-20');
      expect(await created.innerText()).not.toContain(newSubject);
      expect(await created.getByLabel('Status').inputValue()).toBe('disposed');
      expect(await created.getByLabel('Location').inputValue()).toBe('Shelf');
      expect(await created.getByLabel('Source').inputValue()).toBe('Shop');
      expect(await created.getByLabel('Note').inputValue()).toBe('Second shelf');

      await page.goto(`${origin}/en/library/copies?subjectId=${encodeURIComponent(edition)}`, {
        waitUntil: 'networkidle',
      });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      expect(await main.innerText()).toContain('First copy');
      expect(await main.innerText()).toContain('Zebra story');
      expect(await main.locator('article').count()).toBe(1);
      expect(await main.innerText()).not.toContain('Waiting');
      expect(await main.innerText()).not.toContain('Second shelf');
      expect(await main.getByRole('form', { name: 'Add a copy' }).getByLabel('Edition').inputValue()).toBe(edition);
      const filtered = lists().at(-1);
      expect(filtered?.view).toBe('FULL');
      expect(filtered?.limit).toBe(pageLimit);
      expect(new URLSearchParams(filtered?.search ?? '').get('subjectId')).toBe(edition);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'two copies of one edition stay separate through edits and deletion',
  async () => {
    copies.length = 0;
    calls.length = 0;
    serial = 200;
    const desk = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      status: 'owned',
      location: 'Desk',
      source: 'Shop',
      acquiredOn: '2030-03-03',
      disposedOn: null,
      note: 'Desk copy',
    });
    const spare = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      status: 'ordered',
      location: 'Box',
      source: 'Gift',
      acquiredOn: null,
      disposedOn: null,
      note: 'Spare copy',
    });
    copies.push(desk, spare);
    const { page, access } = await open('/en/library/copies');
    try {
      expect(await page.locator('main').getByRole('link', { name: 'Zebra story' }).count()).toBe(2);
      const deskArticle = article(page, 'Desk copy');
      const form = deskArticle.locator('form');
      const html = await deskArticle.evaluate((element) => element.outerHTML);
      await form.getByLabel('Status').selectOption({ label: 'Lent' });
      await form.getByLabel('Location').fill('Friend');
      await form.getByLabel('Note').fill('Loan');
      const requests = observe(page);
      await form.getByRole('button', { name: 'Save' }).click();
      const edited = article(page, 'Loan');
      await edited.getByLabel('Note').waitFor({ timeout: 15_000 });
      expect(await edited.getByLabel('Status').inputValue()).toBe('lent');
      expect(await edited.getByLabel('Location').inputValue()).toBe('Friend');
      expect(await edited.getByLabel('Source').inputValue()).toBe('Shop');
      expect(await edited.getByLabel('Acquired').inputValue()).toBe('2030-03-03');
      expect(await edited.getByLabel('Note').inputValue()).toBe('Loan');
      const spareArticle = article(page, 'Spare copy');
      expect(await spareArticle.getByLabel('Status').inputValue()).toBe('ordered');
      expect(await spareArticle.getByLabel('Location').inputValue()).toBe('Box');
      expect(await spareArticle.getByLabel('Source').inputValue()).toBe('Gift');
      expect(await spareArticle.getByLabel('Note').inputValue()).toBe('Spare copy');
      expect(requests).toHaveLength(1);
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.path).toBe(`/v1/copies/${desk.id}`);
      expect(patches[0]?.key).toMatch(uuid);
      expect(html).toContain(patches[0]!.key!);
      expect(patches[0]?.authorization).toBe(`Bearer ${access}`);
      expect(patches[0]?.body).toEqual({
        revision: 1,
        status: 'lent',
        location: 'Friend',
        source: 'Shop',
        acquiredOn: '2030-03-03',
        disposedOn: null,
        note: 'Loan',
      });
      expect(copies.find((copy) => copy.id === desk.id)).toMatchObject({
        status: 'lent',
        location: 'Friend',
        note: 'Loan',
        revision: 2,
      });
      expect(copies.find((copy) => copy.id === spare.id)).toMatchObject({
        status: 'ordered',
        location: 'Box',
        note: 'Spare copy',
        revision: 1,
      });

      await spareArticle.getByRole('button', { name: 'Delete', exact: true }).click();
      await spareArticle.getByRole('alertdialog').waitFor();
      expect(await spareArticle.innerText()).toContain('Delete this copy?');
      await spareArticle.getByRole('button', { name: 'Cancel', exact: true }).click();
      await spareArticle.getByRole('alertdialog').waitFor({ state: 'detached' });
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
      expect(await spareArticle.getByLabel('Note').inputValue()).toBe('Spare copy');

      const deleteHtml = await edited.evaluate((element) => element.outerHTML);
      const deleteRequests = observe(page);
      await edited.getByRole('button', { name: 'Delete', exact: true }).click();
      await edited.getByRole('button', { name: 'Delete this copy', exact: true }).click();
      await edited.waitFor({ state: 'detached', timeout: 15_000 });
      expect(await page.locator('main').getByRole('link', { name: 'Zebra story' }).count()).toBe(1);
      expect(await spareArticle.getByLabel('Note').inputValue()).toBe('Spare copy');
      expect(deleteRequests).toHaveLength(1);
      const deletions = calls.filter((call) => call.method === 'DELETE');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]?.path).toBe(`/v1/copies/${desk.id}`);
      expect(deletions[0]?.revision).toBe('2');
      expect(deletions[0]?.key).toMatch(uuid);
      expect(deleteHtml).toContain(deletions[0]!.key!);
      expect(deletions[0]?.authorization).toBe(`Bearer ${access}`);
      expect(copies.some((copy) => copy.id === desk.id)).toBe(false);
      expect(copies.find((copy) => copy.id === spare.id)?.note).toBe('Spare copy');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a stale revision keeps the edit and explains it',
  async () => {
    copies.length = 0;
    calls.length = 0;
    serial = 300;
    const shelf = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-04-04',
      disposedOn: null,
      note: 'Shelf note',
    });
    copies.push(shelf);
    const { page, access } = await open('/en/library/copies');
    try {
      const card = article(page, 'Shelf note');
      const form = card.locator('form');
      const html = await card.evaluate((element) => element.outerHTML);
      shelf.revision = 5;
      await form.getByLabel('Location').fill('Hall');
      await form.getByLabel('Note').fill('Moved downstairs');
      await form.getByRole('button', { name: 'Save' }).click();
      const alert = card.getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      expect(await alert.innerText()).toContain(
        'This copy changed since you started editing, so this edit was not saved. Your changes are still here.',
      );
      expect(await form.getByLabel('Location').inputValue()).toBe('Hall');
      expect(await form.getByLabel('Note').inputValue()).toBe('Moved downstairs');
      expect(await form.getByLabel('Status').inputValue()).toBe('owned');
      expect(await form.getByLabel('Source').inputValue()).toBe('Bookshop');
      expect(await form.getByLabel('Acquired').inputValue()).toBe('2030-04-04');
      expect(await card.innerText()).toContain('Shelf note');
      expect(await card.innerText()).toContain('Study');
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.path).toBe(`/v1/copies/${shelf.id}`);
      expect(patches[0]?.authorization).toBe(`Bearer ${access}`);
      expect(patches[0]?.key).toMatch(uuid);
      expect(html).toContain(patches[0]!.key!);
      expect(patches[0]?.body).toEqual({
        revision: 1,
        status: 'owned',
        location: 'Hall',
        source: 'Bookshop',
        acquiredOn: '2030-04-04',
        disposedOn: null,
        note: 'Moved downstairs',
      });
      expect(shelf).toMatchObject({ revision: 5, location: 'Study', note: 'Shelf note' });
      expect(copies).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
