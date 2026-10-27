import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = [
  'thread:create',
  'post:create',
  'media:create',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
  'order:create',
  'order:read',
];
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
type KernelCall = { method: string; path: string; body: unknown; authorization: string | null };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const calls: KernelCall[] = [];
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const subjectId = id(3);
const offerId = id(4);
const threadPath = `/en${threadHref({ id: threadId, title: 'A shared reading' })}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const snapshot = (text: string) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text }] }],
  },
});
const firstPost = {
  ...metadata,
  id: id(12),
  threadId,
  boardId,
  authorId: id(90),
  parentId: null,
  revisionId: id(112),
  sha256: 'a'.repeat(64),
  licence: 'LicenseRef-rezics-terms',
  subjectIds: [],
  mediaIds: [],
  availability: 'available',
  body: snapshot('Opening contribution'),
};
let closedReads = false;
let writeRefusal: 'platform_closed' | 'forbidden' | null = null;
let mediaClosed = false;
let checkoutClosed = false;
let accessCount = 0;

function reset() {
  calls.length = 0;
  closedReads = false;
  writeRefusal = null;
  mediaClosed = false;
  checkoutClosed = false;
}

function json(body: unknown, status = 200, problem = false) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...(problem ? { 'content-type': 'application/problem+json' } : {}) },
  });
}

function platformProblem(status = 403, code = 'platform_closed') {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: 'not_applied',
    request_id: randomUUID(),
  };
}

const problemResponse = (code: string) => json(platformProblem(403, code), 403, true);

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const verifyClient = async (form: URLSearchParams) => {
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
      accessCount += 1;
      const access = `access-${accessCount}`;
      const refresh = `refresh-${accessCount}`;
      family.current = refresh;
      families.set(refresh, family);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined)
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
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
      if (!(await verifyClient(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
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
      if (!(await verifyClient(form))) return json({ error: 'invalid_client' }, 401);
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
      authorization: request.headers.get('authorization'),
    });

    if (url.pathname === '/v1/definitions/active') return json({ digest: 'platform-closed-test' });
    if (url.pathname === '/v1/definitions/releases/platform-closed-test')
      return json({ digest: 'platform-closed-test', release: { types: {}, properties: {} } });

    const closedReadPath =
      url.pathname === `/v1/subjects/${subjectId}` ||
      url.pathname === `/v1/boards/${boardId}` ||
      url.pathname === `/v1/boards/${boardId}/threads` ||
      url.pathname === `/v1/threads/${threadId}` ||
      url.pathname === `/v1/threads/${threadId}/posts` ||
      url.pathname === '/v1/subjects:search' ||
      url.pathname === `/v1/offers/${offerId}`;
    if (
      request.method === 'POST' &&
      url.pathname === '/v1/pages:read' &&
      closedReads &&
      body?.target?.subject === subjectId
    )
      return problemResponse('platform_closed');
    if (request.method === 'GET' && closedReadPath && closedReads) return problemResponse('platform_closed');

    if (request.method === 'GET' && url.pathname === `/v1/subjects/${subjectId}`)
      return json({
        subject: {
          id: subjectId,
          type: 'book',
          labels: { en: 'The Example Book', ja: '例の本' },
          descriptions: {},
          aliases: {},
          statements: {},
        },
        related: {},
      });
    if (request.method === 'GET' && url.pathname === `/v1/boards/${boardId}`)
      return json({ board: { ...metadata, id: boardId, title: 'Reading room', availability: 'available' } });
    if (request.method === 'GET' && url.pathname === `/v1/boards/${boardId}/threads`)
      return json({ threads: [], next: null });
    if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}`)
      return json({
        thread: {
          ...metadata,
          id: threadId,
          boardId,
          authorId: id(90),
          licence: 'LicenseRef-rezics-terms',
          subjectIds: [],
          title: 'A shared reading',
          availability: 'available',
          firstPost,
        },
      });
    if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}/posts`)
      return json({ posts: [firstPost], next: null });
    if (request.method === 'GET' && url.pathname === `/v1/offers/${offerId}`)
      return json({
        offer: {
          id: offerId,
          targetSubjectId: subjectId,
          title: 'A field guide to stars',
          currency: 'usd',
          unitAmountMinor: 123456,
          state: 'active',
        },
      });
    if (request.method === 'POST' && url.pathname === '/v1/subjects:search')
      return closedReads
        ? problemResponse('platform_closed')
        : json({ subjects: [], next: null, as_of: new Date().toISOString() });
    if (request.method === 'POST' && url.pathname === '/v1/subjects:facets')
      return closedReads
        ? problemResponse('platform_closed')
        : json({ facets: [], total: { value: 0, relation: 'exact' } });
    if (
      request.method === 'POST' &&
      (url.pathname === '/v1/threads' || url.pathname === `/v1/threads/${threadId}/posts`)
    ) {
      if (writeRefusal) return problemResponse(writeRefusal);
      return json({ error: 'Unexpected open write' }, 500);
    }
    if (request.method === 'POST' && url.pathname === '/v1/media')
      return mediaClosed ? problemResponse('platform_closed') : json({ media: {} }, 201);
    if (request.method === 'POST' && url.pathname === '/v1/orders')
      return checkoutClosed ? problemResponse('platform_closed') : json({ order: {} }, 201);
    return json(platformProblem(404, 'not_found'), 404, true);
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
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
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
      if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);

async function signIn(returnTo: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: 'alice',
    expiresIn: 3600,
  });
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${loginCookie}=${cookieValue(start, loginCookie)}` },
  });
  expect(answer.status, 'OpenID fixture completes sign-in').toBe(303);
  const value = cookieValue(answer, sessionCookie);
  expect(value, 'OpenID fixture creates a session').toBeDefined();
  return value!;
}

let browser: Browser | undefined;
async function open(path: string, signedIn = true): Promise<Page> {
  const value = signedIn ? await signIn(path) : undefined;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  if (value)
    await context.addCookies([
      { name: sessionCookie, value, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const editor = (page: Page) => page.locator('main').getByRole('textbox', { name: /body|本文|返信/i });
const title = (page: Page) => page.getByRole('textbox', { name: /title|タイトル/i });
const send = (page: Page) => page.locator('main').getByRole('button', { name: /send|送信/i });
const closedText = {
  en: { heading: 'Not open yet', message: 'This part of REZICS is not open yet.' },
  ja: { heading: 'まだ公開されていません', message: 'REZICSのこの部分は、まだ公開されていません。' },
};

async function expectClosedPage(path: string, locale: keyof typeof closedText = 'en') {
  const response = await fetch(`${await site()}${path}`);
  const responseHtml = await response.clone().text();
  expect(response.status, path).toBe(403);
  expect(responseHtml).toContain(closedText[locale].heading);
  expect(responseHtml).toContain(closedText[locale].message);
}

// The shared closed page and localized copy are added by the implementation.
test(
  'a closed read renders the localized page in English and Japanese with status 403',
  async () => {
    reset();
    closedReads = true;
    await expectClosedPage(`/en/boards/${boardId}`);
    await expectClosedPage(`/ja/boards/${boardId}`, 'ja');
  },
  timeout,
);

// Every page loader must expose the same closed state, including optional search facets.
test(
  'subject, board, thread, search and offer pages share the closed read page',
  async () => {
    reset();
    closedReads = true;
    for (const path of [
      `/en/subjects/${subjectId}`,
      `/en/boards/${boardId}`,
      threadPath,
      '/en/search?q=stars',
      `/en/offers/${offerId}`,
    ])
      await expectClosedPage(path);
  },
  timeout,
);

// Both write composers keep the browser draft and idempotency key after a platform refusal.
test(
  'a closed thread start or reply keeps its draft and says it is not open yet',
  async () => {
    for (const startThread of [true, false]) {
      reset();
      writeRefusal = 'platform_closed';
      const path = startThread ? `/en/boards/${boardId}/new` : threadPath;
      const page = await open(path);
      try {
        await editor(page).waitFor({ state: 'visible' });
        if (startThread) await title(page).fill('Keep this title');
        await editor(page).fill('Keep this argument');
        const key = await page.locator('input[name="idempotency_key"]').inputValue();
        await send(page).click();
        const alert = page.locator('main').getByRole('alert');
        await alert.waitFor();
        expect(await alert.innerText()).toMatch(/not open yet/i);
        expect(await editor(page).innerText()).toBe('Keep this argument');
        if (startThread) expect(await title(page).inputValue()).toBe('Keep this title');
        expect(await page.locator('input[name="idempotency_key"]').inputValue()).toBe(key);
        expect(calls.filter((call) => call.method === 'POST' && call.path.startsWith('/v1/threads'))).toHaveLength(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Reserve an image from the real editor flow and start checkout from the real offer page.
test(
  'a closed media reservation or checkout start says it is not open yet',
  async () => {
    reset();
    mediaClosed = true;
    const mediaPage = await open(threadPath);
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
        'base64',
      );
      await editor(mediaPage).fill('Keep this sentence');
      await mediaPage.locator('main').getByRole('button', { name: 'Image', exact: true }).click();
      const dialog = mediaPage.getByRole('dialog', { name: 'Image' });
      await dialog
        .getByLabel('Choose image file')
        .setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
      await dialog.getByLabel('Alt text').fill('A chart');
      await dialog.getByRole('button', { name: 'Insert image' }).click();
      const mediaAlert = mediaPage
        .locator('main')
        .getByRole('alert')
        .filter({ hasText: /not open yet/i });
      await mediaAlert.waitFor();
      expect(await mediaAlert.innerText()).toMatch(/not open yet/i);
      expect(calls.some((call) => call.path === '/v1/media')).toBe(true);
      expect(await editor(mediaPage).innerText()).toContain('Keep this sentence');
    } finally {
      await mediaPage.context().close();
    }

    reset();
    checkoutClosed = true;
    const checkoutPage = await open(`/en/offers/${offerId}`);
    try {
      await checkoutPage.getByRole('button', { name: /^buy$/i }).click();
      const alert = checkoutPage.locator('main').getByRole('status');
      await alert.waitFor();
      expect(await alert.innerText()).toMatch(/not open yet/i);
      expect(calls.some((call) => call.path === '/v1/orders')).toBe(true);
    } finally {
      await checkoutPage.context().close();
    }
  },
  timeout,
);

// A normal permission denial remains the existing, distinct message.
test(
  'an ordinary forbidden reply keeps its existing message',
  async () => {
    reset();
    writeRefusal = 'forbidden';
    const page = await open(threadPath);
    try {
      await editor(page).fill('Keep this argument');
      await send(page).click();
      const alert = page.locator('main').getByRole('alert');
      await alert.waitFor();
      expect(await alert.innerText()).toContain('You do not have permission to publish this contribution.');
      expect(await alert.innerText()).not.toMatch(/not open yet/i);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
