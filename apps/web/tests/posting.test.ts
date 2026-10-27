import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';
import type { KernelClient } from '@rezics/client';
import { hasDocumentContent } from '@rezics/document';
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
type ThreadCreated = Data<KernelClient['threads']['post']>;
type PostCreated = Data<ThreadResource['posts']['post']>;
type Problem = NonNullable<Awaited<ReturnType<ThreadResource['posts']['post']>>['error']>['value'];
type Snapshot = NonNullable<Posts['posts'][number]['body']>;
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardPath = (locale = 'en') => `/${locale}/boards/${id(1)}`;
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
let posts: Posts = { posts: [post(12)], next: null };
type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
const calls: Call[] = [];
let refusal: 403 | 422 | 429 | 503 | undefined;
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
  current = thread(2, 'A shared reading');
  posts = { posts: [post(12)], next: null };
}

// OpenID provider copied from session.test.ts; tokens grant the website's posting scopes.
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
    if (
      request.method === 'POST' &&
      (url.pathname === '/v1/threads' || url.pathname === `/v1/threads/${id(2)}/posts`)
    ) {
      if (refusal)
        return Response.json(problem(refusal), {
          status: refusal,
          headers: { 'content-type': 'application/problem+json', ...(refusal === 429 ? { 'Retry-After': '2' } : {}) },
        });
      if (url.pathname === '/v1/threads') {
        const draft = body as Parameters<KernelClient['threads']['post']>[0];
        current = thread(3, draft.title, draft.body);
        posts = { posts: [current.thread.firstPost], next: null };
        const result: ThreadCreated = { thread: current.thread };
        return Response.json(result, { status: 201, headers: { Location: `/v1/threads/${id(3)}` } });
      }
      const draft = body as Parameters<ThreadResource['posts']['post']>[0];
      const result: PostCreated = { post: post(20 + posts.posts.length, draft.body) };
      posts.posts.push(result.post);
      return json(result, 201);
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
// Page reads use POST too, including the home-page probe that starts the dev server.
const writes = () => calls.filter((call) => call.method === 'POST' && call.path !== '/v1/pages:read');
const editor = (page: Page) => page.locator('main').getByRole('textbox', { name: /body|reply|content|本文|返信/i });
const title = (page: Page) => page.getByRole('textbox', { name: /title|タイトル/i });
const send = (page: Page) => page.locator('main').getByRole('button', { name: /send|publish|post|送信|投稿/i });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function labelledEditor(page: Page) {
  expect(await editor(page).count(), 'a visibly labelled rich-text composer is present').toBe(1);
  expect(await editor(page).getAttribute('contenteditable')).toBe('true');
  // An accessible name alone is insufficient: the label must also be visible on the page.
  const label = await editor(page).evaluate((element) => {
    const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
    return (
      ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ||
      element.getAttribute('aria-label') ||
      ''
    );
  });
  expect(label.trim()).not.toBe('');
  expect(await page.locator('main').innerText()).toContain(label.trim());
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}
function observe(page: Page) {
  const requests: BrowserRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request);
  });
  return requests;
}
async function checkWrite(
  page: Page,
  access: string | undefined,
  html: string,
  request: BrowserRequest,
  call: Call,
  path: string,
  text: string,
  threadTitle?: string,
) {
  expect(call).toMatchObject({ method: 'POST', path, authorization: `Bearer ${access}` });
  expect(call.key).toMatch(uuid);
  expect(html, 'the page renders the key before submission').toContain(call.key!);
  const draft = call.body as { body: Snapshot };
  expect(draft.body).toMatchObject({ version: 'rezics-document-v1', profile: 'blocks' });
  expect(hasDocumentContent(draft.body)).toBe(true);
  expect(JSON.stringify(draft.body.doc)).toContain(text);
  expect(call.body).toEqual({
    body: draft.body,
    licence,
    ...(threadTitle === undefined
      ? {}
      : { boardId: id(1), title: threadTitle, subjectIds: [], visibility: 'published' }),
  });
  expect(new URL(request.url()).origin).toBe(await site());
  expect(request.headers()['content-type']).toContain('application/json');
  expect(request.postDataJSON()).toMatchObject({ body: draft.body });
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(csrf).toBeTruthy();
  expect(request.headers()['x-csrf-token']).toBe(csrf!);
}

// Add the board's new-thread link, labelled composer, CSRF write and locale-preserving redirect to turn this into test(...).
test(
  'a signed-in member starts a thread from its board and lands on it',
  async () => {
    reset();
    const { page, access } = await open(boardPath('ja'));
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Reading room');
      const start = page.locator('main').getByRole('link', { name: /new thread|start.*thread|スレッド/ });
      expect(await start.count(), 'the board offers a new thread').toBe(1);
      expect(await start.getAttribute('href')).toBe(`${boardPath('ja')}/new`);
      await start.click();
      await page.waitForURL(`${await site()}${boardPath('ja')}/new`);
      await hydrated(page);
      await labelledEditor(page);
      expect(await title(page).count()).toBe(1);
      await title(page).fill('Reading together');
      await editor(page).fill('The opening argument');
      const html = await page.content();
      const requests = observe(page);
      await send(page).click();
      await page.waitForURL(`${await site()}/ja${threadHref({ id: id(3), title: 'Reading together' })}`);
      expect(writes()).toHaveLength(1);
      expect(requests).toHaveLength(1);
      await checkWrite(
        page,
        access,
        html,
        requests[0]!,
        writes()[0]!,
        '/v1/threads',
        'The opening argument',
        'Reading together',
      );
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Reading together');
      expect(await page.locator('main').innerText()).toContain('The opening argument');
      await page.goto(`${await site()}${boardPath('ja')}/new`, { waitUntil: 'networkidle' });
      await hydrated(page);
      await title(page).fill('Another reading');
      await editor(page).fill('A new opening');
      const nextHtml = await page.content();
      await send(page).click();
      await eventually(() => writes().length === 2);
      expect(writes()[1]!.key).toMatch(uuid);
      expect(writes()[1]!.key).not.toBe(writes()[0]!.key);
      expect(nextHtml).toContain(writes()[1]!.key!);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Add the reply composer, authenticated post write and rendered reply with a fresh draft to turn this into test(...).
test(
  'a signed-in member replies to a thread and sees the reply',
  async () => {
    reset();
    const { page, access } = await open(threadPath());
    try {
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('A shared reading');
      await labelledEditor(page);
      await editor(page).fill('A different interpretation');
      const html = await page.content();
      const requests = observe(page);
      await send(page).click();
      await page.locator('main li').filter({ hasText: 'A different interpretation' }).waitFor();
      await eventually(() => writes().length === 1);
      expect(writes()).toHaveLength(1);
      expect(requests).toHaveLength(1);
      await checkWrite(
        page,
        access,
        html,
        requests[0]!,
        writes()[0]!,
        `/v1/threads/${id(2)}/posts`,
        'A different interpretation',
      );
      expect(await page.locator('main li').filter({ hasText: 'A different interpretation' }).count()).toBe(1);
      expect((await editor(page).innerText()).trim()).toBe('');
      expect(await send(page).isDisabled()).toBe(true);
      const nextHtml = await page.content();
      await editor(page).fill('Another contribution');
      await send(page).click();
      await eventually(() => writes().length === 2);
      expect(writes()[1]!.key).toMatch(uuid);
      expect(writes()[1]!.key).not.toBe(writes()[0]!.key);
      expect(nextHtml).toContain(writes()[1]!.key!);
      expect(new URL(page.url()).pathname).toBe(threadPath());
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Offer contextual sign-in on boards and threads with return_to and no composer to turn this into test(...).
test(
  'a signed-out visitor is offered sign-in instead of a composer',
  async () => {
    reset();
    for (const locale of ['en', 'ja'])
      for (const path of [boardPath(locale), threadPath(locale)]) {
        const { page } = await open(path, false);
        try {
          const signIn = page.locator('main').getByRole('link', { name: /sign in|ログイン|サインイン/i });
          expect(await signIn.count(), 'the content offers sign-in in place of posting').toBe(1);
          const target = new URL((await signIn.getAttribute('href'))!, await site());
          expect(`${target.origin}${target.pathname}`).toBe(`${await site()}/auth/sign-in`);
          expect(target.searchParams.get('return_to')).toBe(path);
          expect(await editor(page).count()).toBe(0);
          expect(await send(page).count()).toBe(0);
          expect(await page.locator(`main a[href="${boardPath(locale)}/new"]`).count()).toBe(0);
          expect(writes()).toHaveLength(0);
        } finally {
          await page.context().close();
        }
      }
  },
  timeout,
);

// Disable send for blank titles and content-free blocks snapshots in both composers to turn this into test(...).
test(
  'an empty draft cannot be sent',
  async () => {
    reset();
    for (const newThread of [false, true]) {
      const { page } = await open(newThread ? `${boardPath()}/new` : threadPath());
      try {
        await labelledEditor(page);
        expect(hasDocumentContent(snapshot(''))).toBe(false);
        expect(hasDocumentContent(snapshot('   '))).toBe(false);
        expect(await send(page).isDisabled()).toBe(true);
        if (newThread) {
          await editor(page).fill('A body without a title');
          expect(await send(page).isDisabled()).toBe(true);
          await title(page).fill('   ');
          expect(await send(page).isDisabled()).toBe(true);
          await title(page).fill('A title');
          expect(await send(page).isEnabled()).toBe(true);
        }
        await editor(page).fill('   ');
        expect(await send(page).isDisabled()).toBe(true);
        await editor(page).fill('');
        expect(await send(page).isDisabled()).toBe(true);
        await editor(page).press('Enter');
        expect(await send(page).isDisabled()).toBe(true);
        await editor(page).fill('A real contribution');
        expect(await send(page).isEnabled()).toBe(true);
        expect(writes()).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Preserve drafts and keys on localized kernel refusals and rotate the key after success to turn this into test(...).
test(
  'a refused write keeps the draft, says why and retries with the same idempotency key',
  async () => {
    for (const locale of ['en', 'ja'])
      for (const newThread of [false, true])
        for (const status of [403, 422, 429, 503] as const) {
          reset();
          refusal = status;
          const path = newThread ? `${boardPath(locale)}/new` : threadPath(locale);
          const { page, access } = await open(path);
          try {
            await labelledEditor(page);
            if (newThread) await title(page).fill('Keep this title');
            await editor(page).fill('Keep this argument');
            const html = await page.content();
            const requests = observe(page);
            await send(page).click();
            const reason = page.locator('main').getByRole('alert');
            await reason.waitFor();
            const patterns =
              locale === 'en'
                ? {
                    403: /permission|not allowed|forbidden/i,
                    422: /invalid|validation/i,
                    429: /too fast|wait|too many/i,
                    503: /unavailable|try again/i,
                  }
                : {
                    403: /権限|許可/,
                    422: /無効|入力|検証|正しく/,
                    429: /待|しばらく|頻繁|多すぎ/,
                    503: /利用|使用|再試行/,
                  };
            expect(await reason.innerText()).toMatch(patterns[status]);
            if (status === 429) expect(await reason.innerText()).toMatch(/2/);
            expect(await editor(page).innerText()).toBe('Keep this argument');
            if (newThread) expect(await title(page).inputValue()).toBe('Keep this title');
            expect(new URL(page.url()).pathname).toBe(path);
            expect(writes()).toHaveLength(1);
            await checkWrite(
              page,
              access,
              html,
              requests[0]!,
              writes()[0]!,
              newThread ? '/v1/threads' : `/v1/threads/${id(2)}/posts`,
              'Keep this argument',
              newThread ? 'Keep this title' : undefined,
            );
            refusal = undefined;
            const retry = page.locator('main').getByRole('button', { name: /retry|try again|再試行|もう一度/i });
            await retry.click();
            await eventually(() => writes().length === 2);
            expect(writes()[1]).toEqual(writes()[0]);
            expect(requests).toHaveLength(2);
            expect(requests[1]!.headers()['x-csrf-token']).toBe(requests[0]!.headers()['x-csrf-token']);
            if (newThread) {
              await page.waitForURL(`${await site()}/${locale}${threadHref({ id: id(3), title: 'Keep this title' })}`);
            } else {
              await eventually(() => posts.posts.length === 2);
              await page.locator('main li').filter({ hasText: 'Keep this argument' }).waitFor();
              expect((await editor(page).innerText()).trim()).toBe('');
              expect(await reason.count()).toBe(0);
              const freshHtml = await page.content();
              await editor(page).fill('A fresh draft');
              await send(page).click();
              await eventually(() => writes().length === 3);
              expect(writes()[2]!.key).toMatch(uuid);
              expect(writes()[2]!.key).not.toBe(writes()[0]!.key);
              expect(freshHtml).toContain(writes()[2]!.key!);
            }
          } finally {
            refusal = undefined;
            await page.context().close();
          }
        }
  },
  timeout,
);
