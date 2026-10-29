import { browserSessionToken } from './session-token';
import { afterAll, expect } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';
import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
export const pageLimit = '100';

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

export const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
export const edition = id(11);
export const hiddenSubjectId = 'unavailable-subject-should-not-appear';
export const newSubject = id(21);
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CopyStatus = 'ordered' | 'owned' | 'lent' | 'disposed';
type Subject = { id: string; label: string; type: string } | null;
type StoredCopy = {
  id: string;
  accountId: string;
  subjectId: string;
  subject: Subject;
  status: CopyStatus;
  kind?: string;
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

export const zebra: Subject = { id: edition, label: 'Zebra story', type: 'schema:Book' };
export const copies: StoredCopy[] = [];
let serial = 100;
export function setSerial(value: number) {
  serial = value;
}
export function make(input: Omit<StoredCopy, 'id' | 'revision'> & { revision?: number }): StoredCopy {
  serial += 1;
  return { id: id(serial), revision: input.revision ?? 1, ...input };
}
export function seedDefault() {
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
export const calls: Call[] = [];
let refuseNextCopyWrite = false;

export function refuseNextCopyWriteOnce() {
  refuseNextCopyWrite = true;
}

export function problem(status: number, code: string) {
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
export function reset() {
  calls.length = 0;
  refuseNextCopyWrite = false;
  seedDefault();
}
function wire(copy: StoredCopy, full: boolean) {
  const { accountId: _accountId, subject, ...rest } = copy;
  const withKind = { ...rest, kind: copy.kind ?? 'physical' };
  return full ? { ...withKind, subject } : withKind;
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
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['personal_library'] });
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
      if (refuseNextCopyWrite) {
        refuseNextCopyWrite = false;
        return json(problem(422, 'invalid_request'), 422, true);
      }
      const draft = (body ?? {}) as Draft;
      const created = make({
        accountId,
        subjectId: draft.subjectId ?? '',
        subject: copies.find((copy) => copy.subjectId === draft.subjectId)?.subject ?? null,
        status: draft.status ?? 'owned',
        kind: 'physical',
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

export async function signIn(returnTo = '/en') {
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
export async function open(path: string, viewport = { width: 1280, height: 860 }) {
  const auth = await signIn(path);
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport,
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
  const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return { page, access: auth.access, origin, response };
}
export function observe(page: Page) {
  const requests: BrowserRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request);
  });
  return requests;
}
export const article = (page: Page, text: string) =>
  page.locator('main [data-slot="list-row"]').filter({ hasText: text });
export const lists = () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/copies');

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
