import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

import { chromium, type Browser, type Page } from 'playwright';
import type { KernelClient } from '@rezics/client';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = [
  'thread:create',
  'post:create',
  'media:create',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
];

// A 1×1 PNG. The reply records this file's natural width and height.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
const subjects = new Map<string, string>();
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
type MediaRefusal = 'type' | 'size' | 'rate' | 'reject';
let refusal: MediaRefusal | undefined;
type Reservation = {
  id: string;
  state: 'reserved' | 'uploaded' | 'available' | 'rejected';
  byteCount: number;
  mediaType: string;
  sha256: string | null;
  containerId: string;
  uploaderId: string;
  key: string;
  reservationRequestId: string;
  polls: number;
};
const reservations = new Map<string, Reservation>();

function contentId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
function mediaProblem(status: number, code: string, headers: Record<string, string> = {}) {
  return Response.json(
    {
      type: `https://rezics.com/problems/${code}`,
      title: code,
      status,
      code,
      retryable: status === 429,
      effect_status: 'not_applied',
      request_id: randomUUID(),
    },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}
function reset() {
  calls.length = 0;
  refusal = undefined;
  reservations.clear();
  current = thread(2, 'A shared reading');
  posts = { posts: [post(12)], next: null };
}

// OpenID provider copied from posting.test.ts; tokens grant posting and media scopes.
// The media routes follow the content media API exercised by media.test.ts and media-reserve.test.ts.
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
      subjects.set(access, family.sub);
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
    const mediaMatch = /^\/v1\/media(?:\/([^/:]+)(?::(complete))?)?$/.exec(url.pathname);
    if (mediaMatch) {
      const sub = subjects.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (!sub) return mediaProblem(401, 'authentication_required');
      if (!mediaMatch[1] && request.method === 'POST') {
        if (!request.headers.get('idempotency-key')) return mediaProblem(400, 'invalid_request');
        if (refusal === 'type') return mediaProblem(415, 'invalid_request');
        if (refusal === 'size') return mediaProblem(413, 'invalid_request');
        if (refusal === 'rate') return mediaProblem(429, 'rate_limited', { 'retry-after': '7' });
        const input = body as { containerId?: string; mediaType?: string; byteCount?: number; sha256?: string };
        const mediaId = contentId();
        const media: Reservation = {
          id: mediaId,
          state: 'reserved',
          byteCount: input.byteCount ?? 0,
          mediaType: input.mediaType ?? 'application/octet-stream',
          sha256: input.sha256 ?? null,
          containerId: input.containerId ?? '',
          uploaderId: sub,
          key: `m/${mediaId}/original`,
          reservationRequestId: randomUUID(),
          polls: 0,
        };
        reservations.set(mediaId, media);
        return Response.json({ media }, { status: 201, headers: { location: `/v1/media/${mediaId}` } });
      }
      const entry = reservations.get(mediaMatch[1] ?? '');
      if (!entry || entry.uploaderId !== sub) return mediaProblem(404, 'not_found');
      if (mediaMatch[2] === 'complete' && request.method === 'POST') {
        if (!request.headers.get('idempotency-key')) return mediaProblem(400, 'invalid_request');
        const sent = body as { byteCount?: number; sha256?: string; containerId?: string };
        if (sent.byteCount !== entry.byteCount || sent.containerId !== entry.containerId)
          return mediaProblem(400, 'invalid_request');
        if (entry.sha256 !== null && sent.sha256 !== entry.sha256) return mediaProblem(400, 'invalid_request');
        entry.state = 'uploaded';
        if (typeof sent.sha256 === 'string') entry.sha256 = sent.sha256;
        return Response.json({ media: { id: entry.id, state: 'uploaded' } });
      }
      if (request.method === 'GET') {
        if (entry.state === 'uploaded') {
          entry.polls += 1;
          if (refusal === 'reject') entry.state = 'rejected';
          else if (entry.polls >= 2) entry.state = 'available';
        }
        return Response.json({ media: entry });
      }
      return mediaProblem(404, 'not_found');
    }
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

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);
// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the callback.
async function signIn(returnTo = '/ja') {
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
  return { origin, answer, session: cookieValue(answer, session) };
}

let browser: Browser | undefined;
// Browser context and hydration steps copied from the existing browser tests.
async function open(path: string, coarse = false): Promise<{ page: Page; access: string | undefined }> {
  const auth = await signIn(path);
  expect([302, 303], 'OpenID callback setup').toContain(auth.answer.status);
  expect(auth.session, 'signed-in session setup').toBeTruthy();
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: coarse ? { width: 390, height: 844 } : { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    hasTouch: coarse,
    isMobile: coarse,
    javaScriptEnabled: true,
  });
  if (coarse)
    await context.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (query.includes('pointer: coarse')) {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => true,
          } as MediaQueryList;
        }
        return original(query);
      };
    });
  await context.addCookies([
    {
      name: session,
      value: auth.session!,
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
  return { page, access: accessTokens.at(-1) };
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

const editor = (page: Page) => page.locator('main .ProseMirror[contenteditable="true"]');
const send = (page: Page) => page.locator('main').getByRole('button', { name: /send|publish|post|送信|投稿/i });
async function readyEditor(page: Page) {
  await editor(page).waitFor({ state: 'visible', timeout: 30_000 });
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}
type MediaHop = { method: string; url: string; type: string };
function watchMedia(page: Page) {
  const hops: MediaHop[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/media' || url.pathname.startsWith('/media/'))
      hops.push({ method: request.method(), url: request.url(), type: request.headers()['content-type'] ?? '' });
  });
  return hops;
}
async function chooseImage(page: Page, alt: string) {
  await page.locator('main').getByRole('button', { name: 'Image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Image' });
  await dialog.getByLabel('Choose image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  await dialog.getByLabel('Alt text').fill(alt);
  await dialog.getByRole('button', { name: 'Insert image' }).click();
}

// Choose a PNG through the image command, then send the reply with that media id and alt text.
test(
  'a member adds an image to a reply, which uploads through the site and is sent with its media id',
  async () => {
    reset();
    const { page, access } = await open(threadPath());
    const hops = watchMedia(page);
    try {
      await readyEditor(page);
      await editor(page).fill('See this chart');
      expect(await send(page).isEnabled()).toBe(true);
      await chooseImage(page, 'A reading chart');
      await page.getByRole('status', { name: 'Uploading image' }).waitFor();
      expect(await send(page).isDisabled(), 'send waits for the upload').toBe(true);
      await page.getByRole('img', { name: 'A reading chart' }).waitFor();
      expect(await send(page).isEnabled()).toBe(true);
      await eventually(() => hops.filter((hop) => hop.method === 'GET').length >= 2);
      const origin = new URL(page.url()).origin;
      expect(hops.every((hop) => new URL(hop.url).origin === origin)).toBe(true);
      expect(hops.map((hop) => hop.method)).toEqual(['POST', 'PUT', 'GET', 'GET']);
      expect(hops[0]!.url).toMatch(/\/media$/);
      expect(hops[1]!.type).toContain('image/png');
      expect(hops[1]!.url).toBe(`${origin}/media/${[...reservations.values()].at(-1)!.id}`);
      const reserve = calls.find((call) => call.method === 'POST' && call.path === '/v1/media');
      expect(reserve).toMatchObject({ authorization: `Bearer ${access}` });
      expect(reserve!.body).toEqual({
        containerId: id(2),
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: png.byteLength,
      });
      const complete = calls.find((call) => call.path.endsWith(':complete'));
      expect(complete!.body).toMatchObject({ containerId: id(2), byteCount: png.byteLength });
      expect(
        calls.filter((call) => call.method === 'GET' && call.path.startsWith('/v1/media/')).length,
      ).toBeGreaterThanOrEqual(3);
      await send(page).click();
      await eventually(() =>
        calls.some((call) => call.method === 'POST' && call.path === `/v1/threads/${id(2)}/posts`),
      );
      const sent = calls.find((call) => call.method === 'POST' && call.path === `/v1/threads/${id(2)}/posts`)!;
      const media = [...reservations.values()].at(-1)!;
      expect(sent.body).toMatchObject({ mediaIds: [media.id], licence });
      const document = JSON.stringify((sent.body as { body: unknown }).body);
      expect(document).toContain('A reading chart');
      expect(document).toContain(media.id);
      expect(document).toContain('"width":1');
      expect(document).toContain('"height":1');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// A reservation refusal, a 429 and a rejected object each drop the image and explain why.
test(
  'a refused or rejected upload removes the image and says why',
  async () => {
    for (const [mode, pattern] of [
      ['type', /not accepted/i],
      ['size', /too large/i],
      ['rate', /wait[\s\S]*7|7[\s\S]*(?:second|秒)/i],
      ['reject', /reject/i],
    ] as const) {
      reset();
      refusal = mode;
      const { page } = await open(threadPath());
      try {
        await readyEditor(page);
        await editor(page).fill('Keep this sentence');
        await chooseImage(page, 'Chart of the river');
        const reason = page.locator('main').getByRole('alert').filter({ hasText: pattern });
        await reason.waitFor();
        expect(await reason.innerText()).toMatch(pattern);
        expect(await page.getByRole('img', { name: 'Chart of the river' }).count()).toBe(0);
        await send(page).click();
        await eventually(() =>
          calls.some((call) => call.method === 'POST' && call.path === `/v1/threads/${id(2)}/posts`),
        );
        const sent = calls.find((call) => call.method === 'POST' && call.path === `/v1/threads/${id(2)}/posts`)!;
        const document = JSON.stringify(sent.body);
        expect(document).toContain('Keep this sentence');
        expect(document).not.toContain('Chart of the river');
        expect((sent.body as { mediaIds?: string[] }).mediaIds ?? []).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Slash options, a selection command and the touch bar use the page locale.
test(
  "the editor's menus, commands and touch bar are labelled in the page's locale",
  async () => {
    reset();
    const { page } = await open(threadPath('ja'));
    try {
      await readyEditor(page);
      await editor(page).click();
      await page.keyboard.type('言葉');
      await page.keyboard.press('Control+A');
      const selection = page.getByRole('toolbar', { name: '文字の書式' });
      await selection.waitFor();
      expect(await selection.getByRole('button', { name: '太字' }).count()).toBe(1);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await editor(page).press('/');
      const menu = page.getByRole('listbox', { name: 'ブロックを挿入' });
      await menu.waitFor();
      const options = await menu.getByRole('option').allInnerTexts();
      expect(options).toContain('見出し1');
      expect(options).toContain('箇条書き');
      expect(options).toContain('画像');
      expect(options).toContain('表');
      expect(options).not.toContain('Heading 1');
    } finally {
      await page.context().close();
    }

    const coarse = await open(threadPath('ja'), true);
    try {
      await readyEditor(coarse.page);
      await editor(coarse.page).click();
      const bar = coarse.page.getByRole('toolbar', { name: '書式ツールバー' });
      await bar.waitFor();
      expect(await bar.getByRole('button', { name: '太字' }).count()).toBe(1);
      expect(await bar.getByRole('button', { name: 'ブロック' }).count()).toBe(1);
      expect(await bar.getByRole('button', { name: '元に戻す' }).count()).toBe(1);
      await bar.getByRole('button', { name: 'ブロック' }).click();
      await coarse.page.getByRole('button', { name: '見出し1' }).waitFor();
      expect(await coarse.page.getByRole('button', { name: '画像' }).count()).toBe(1);
    } finally {
      await coarse.page.context().close();
    }
  },
  timeout,
);
