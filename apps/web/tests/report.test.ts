import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';
import type { KernelClient } from '@rezics/client';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['thread:create', 'post:create'];

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
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

type BoardResource = ReturnType<KernelClient['boards']>;
type ThreadResource = ReturnType<KernelClient['threads']>;
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type BoardRead = Data<BoardResource['get']>;
type ThreadRead = Data<ThreadResource['get']>;
type Threads = Data<BoardResource['threads']['get']>;
type Posts = Data<ThreadResource['posts']['get']>;
type Problem = NonNullable<Awaited<ReturnType<ThreadResource['posts']['post']>>['error']>['value'];
type Snapshot = NonNullable<Posts['posts'][number]['body']>;
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const threadPath = (locale = 'en') => `/${locale}${threadHref({ id: id(2), title: 'A shared reading' })}`;
const licence = 'LicenseRef-rezics-terms';
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const snapshot = (text: string): Snapshot => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: text ? [{ type: 'text', text }] : [] }],
  },
});
function post(n: number, body = snapshot('Existing contribution'), threadId = id(2)): Posts['posts'][number] {
  return {
    ...metadata,
    id: id(n),
    threadId,
    boardId: id(1),
    authorId: id(90),
    parentId: null,
    revisionId: id(n + 100),
    sha256: 'a'.repeat(64),
    licence,
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body,
  };
}
function thread(n: number, title: string, body = snapshot('Opening contribution')): ThreadRead {
  return {
    thread: {
      ...metadata,
      id: id(n),
      boardId: id(1),
      authorId: id(90),
      licence,
      subjectIds: [],
      title,
      availability: 'available',
      firstPost: post(n + 10, body, id(n)),
    },
  };
}
const board: BoardRead = { board: { ...metadata, id: id(1), title: 'Reading room', availability: 'available' } };
let current = thread(2, 'A shared reading');
let posts: Posts = { posts: [post(12), post(13)], next: null };
type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
const calls: Call[] = [];
let refusal: 403 | 422 | 429 | 503 | undefined;
let closed = false;
let scriptLoads = 0;
function problem(status: 403 | 422 | 429 | 503 | 404): Problem {
  const code = (
    {
      403: 'forbidden',
      422: 'validation',
      429: 'rate_limited',
      503: 'dependency_unavailable',
      404: 'not_found',
    } as const
  )[status];
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: status === 429 || status === 503,
    effect_status: 'not_applied',
    request_id: randomUUID(),
  };
}
function reset() {
  calls.length = 0;
  refusal = undefined;
  closed = false;
  current = thread(2, 'A shared reading');
  posts = { posts: [post(12), post(13)], next: null };
}

// OpenID provider copied from session.test.ts; tokens grant the website's posting scopes.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/turnstile.js') {
      scriptLoads += 1;
      return new Response(
        `
        let next = 0;
        const widgets = new Map();
        window.turnstile = {
          render(container, options) {
            const id = String(++next);
            container.dataset.sitekey = options.sitekey;
            container.dataset.language = options.language;
            const verify = document.createElement('button');
            verify.type = 'button'; verify.textContent = 'Verify test challenge';
            verify.onclick = () => options.callback('token-' + crypto.randomUUID());
            const expire = document.createElement('button');
            expire.type = 'button'; expire.textContent = 'Expire test challenge';
            expire.onclick = () => options['expired-callback']();
            container.append(verify, expire);
            widgets.set(id, {container, options});
            return id;
          },
          reset(id) { widgets.get(id).options['expired-callback'](); },
          remove(id) { widgets.get(id)?.container.replaceChildren(); widgets.delete(id); }
        };
      `,
        { headers: { 'content-type': 'text/javascript' } },
      );
    }
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
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    if (request.method === 'GET') {
      if (url.pathname === `/v1/boards/${id(1)}`) return json(board);
      if (url.pathname === `/v1/boards/${id(1)}/threads`) {
        const page: Threads = { threads: [current.thread], next: null };
        return json(page);
      }
      if (url.pathname === `/v1/threads/${current.thread.id}`) return json(current);
      if (url.pathname === `/v1/threads/${current.thread.id}/posts`) return json(posts);
    }
    if (request.method === 'POST' && url.pathname === '/v1/reports') {
      if (refusal)
        return Response.json(
          {
            ...problem(refusal),
            code: closed ? 'platform_closed' : problem(refusal).code,
            title: 'UNTRUSTED KERNEL TEXT',
            detail: 'UNTRUSTED KERNEL TEXT',
          },
          {
            status: refusal,
            headers: { 'content-type': 'application/problem+json', ...(refusal === 429 ? { 'Retry-After': '2' } : {}) },
          },
        );
      return json({ reportId: id(500) }, 201);
    }
    return Response.json(problem(404), { status: 404, headers: { 'content-type': 'application/problem+json' } });
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
        TURNSTILE_SITE_KEY: 'report-test-key',
        TURNSTILE_SCRIPT_URL: `${fake.url.origin}/turnstile.js`,
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
        const response = await fetch(`${origin}${threadPath()}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
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

let browser: Browser | undefined;
// Browser context and hydration steps copied from the existing browser tests.
async function open(path: string, signedIn = true): Promise<{ page: Page; access: string | undefined }> {
  const auth = signedIn ? await signIn(path) : undefined;
  if (auth) {
    expect([302, 303], 'OpenID callback setup').toContain(auth.answer.status);
    expect(auth.session, 'signed-in session setup').toBeTruthy();
  }
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
  if (auth?.session)
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
  await hydrated(page);
  return { page, access: auth ? accessTokens.at(-1) : undefined };
}
async function hydrated(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});
const writes = () => calls.filter((call) => call.method === 'POST');
const submit = (page: Page) => page.getByRole('button', { name: 'Submit report', exact: true });
const details = (page: Page) => page.getByRole('textbox', { name: 'Additional details' });
async function report(page: Page, index = 1) {
  await page.getByRole('button', { name: 'More actions', exact: true }).nth(index).click();
  await page.getByRole('menuitem', { name: 'Report', exact: true }).click();
  await page.getByRole('dialog', { name: 'Report this content', exact: true }).waitFor();
}
async function verify(page: Page) {
  await page.getByRole('button', { name: 'Verify test challenge', exact: true }).click();
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}

test(
  'a reader reports a post from the more-actions menu with a reason, verification and details',
  async () => {
    for (const signedIn of [false, true]) {
      reset();
      const { page, access } = await open(threadPath(), signedIn);
      try {
        const loads = scriptLoads;
        expect(await page.locator('script[src*="turnstile"]').count()).toBe(0);
        await report(page);
        await page.getByRole('radio', { name: 'Spam', exact: true }).check();
        await details(page).fill('Repeated unsolicited advertisements');
        await verify(page);
        expect(await page.locator('[data-sitekey="report-test-key"][data-language="en"]').count()).toBe(1);
        await submit(page).click();
        await page.getByRole('status', { name: 'Thank you for your report.', exact: true }).waitFor();
        expect(writes()).toHaveLength(1);
        expect(writes()[0]).toMatchObject({ path: '/v1/reports', authorization: signedIn ? `Bearer ${access}` : null });
        expect(writes()[0]!.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(writes()[0]!.body).toEqual({
          target: { kind: 'post', id: id(13) },
          revisionId: id(113),
          reason: 'spam',
          evidence: 'Repeated unsolicited advertisements',
          botToken: expect.stringMatching(/^token-/),
        });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await report(page, 0);
        await page.getByRole('radio', { name: 'Off topic', exact: true }).check();
        await verify(page);
        await submit(page).click();
        await eventually(() => writes().length === 2);
        expect(writes()[1]!.body).toMatchObject({ target: { kind: 'thread', id: id(2) }, reason: 'off_topic' });
        expect(scriptLoads - loads).toBe(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a report cannot be sent before verification',
  async () => {
    reset();
    const { page } = await open(threadPath(), false);
    try {
      await report(page);
      await page.getByRole('radio', { name: 'Spam', exact: true }).check();
      expect(await submit(page).isDisabled()).toBe(true);
      expect(writes()).toHaveLength(0);
      await verify(page);
      expect(await submit(page).isEnabled()).toBe(true);
      await page.getByRole('button', { name: 'Expire test challenge' }).click();
      expect(await submit(page).isDisabled()).toBe(true);
      expect(writes()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'illegal and other reasons require details of at most 4096 characters',
  async () => {
    reset();
    const { page } = await open(threadPath(), false);
    try {
      await report(page);
      await verify(page);
      for (const reason of ['Illegal activity', 'Other']) {
        await details(page).fill('');
        await page.getByRole('radio', { name: reason, exact: true }).check();
        expect(await submit(page).isDisabled()).toBe(true);
        await details(page).fill('   ');
        expect(await submit(page).isDisabled()).toBe(true);
        expect(await details(page).getAttribute('maxlength')).toBe('4096');
        await details(page).fill('x'.repeat(4096));
        expect(await submit(page).isEnabled()).toBe(true);
      }
      await submit(page).click();
      await eventually(() => writes().length === 1);
      expect(writes()[0]!.body).toMatchObject({ reason: 'other', evidence: 'x'.repeat(4096) });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a refused report keeps the input, says why and retries with the same idempotency key',
  async () => {
    for (const [status, gate, message] of [
      [403, false, 'You do not have permission to report this content.'],
      [422, false, 'Review the reason and details, then try again.'],
      [429, false, 'Wait 2 seconds before sending this report again.'],
      [503, false, 'Reports are temporarily unavailable. Please try again.'],
      [403, true, 'This part of REZICS is not open yet.'],
    ] as const) {
      reset();
      refusal = status;
      closed = gate;
      const { page } = await open(threadPath(), false);
      try {
        await report(page);
        await page.getByRole('radio', { name: 'Other', exact: true }).check();
        await details(page).fill('Keep my report');
        await verify(page);
        await submit(page).click();
        await page.getByRole('alert').filter({ hasText: message }).waitFor();
        expect(await details(page).inputValue()).toBe('Keep my report');
        expect(await page.getByRole('radio', { name: 'Other', exact: true }).isChecked()).toBe(true);
        expect(await page.getByRole('dialog').innerText()).not.toContain('UNTRUSTED KERNEL TEXT');
        expect(await submit(page).isDisabled()).toBe(true);
        refusal = undefined;
        await verify(page);
        await submit(page).click();
        await page.getByRole('status', { name: 'Thank you for your report.', exact: true }).waitFor();
        expect(writes()).toHaveLength(2);
        expect(writes()[1]!.key).toBe(writes()[0]!.key);
        const first = writes()[0]!.body as Record<string, unknown>;
        const second = writes()[1]!.body as Record<string, unknown>;
        expect(second).toEqual({ ...first, botToken: second.botToken });
        expect(second.botToken).not.toBe(first.botToken);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "the author's own post offers no report",
  async () => {
    reset();
    posts.posts[1]!.authorId = 'alice';
    const { page } = await open(threadPath());
    try {
      await page.getByRole('button', { name: 'More actions', exact: true }).nth(1).click();
      await page.getByRole('menuitem', { name: 'Copy link', exact: true }).waitFor();
      expect(await page.getByRole('menuitem', { name: 'Copy link', exact: true }).count()).toBe(1);
      expect(await page.getByRole('menuitem', { name: 'Report', exact: true }).count()).toBe(0);
      expect(writes()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
