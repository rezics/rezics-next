import { startDevServer } from './support/dev-server.ts';
import { readSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

import { chromium, type Browser, type Page } from 'playwright';
import type { BoardPageResponse, KernelClient, ReadingPageResponse } from '@rezics/client';
import { documentText, fromPlainText } from '@rezics/document';
import { boardOpeningCard, boardOpeningExample } from '../src/threads/board-opening-fixtures';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';

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

type ThreadResource = ReturnType<KernelClient['threads']>;
type CreateDraft = Parameters<KernelClient['threads']['post']>[0];
type Thread = ReturnType<typeof boardOpeningCard>['thread'];
type Problem = NonNullable<Awaited<ReturnType<ThreadResource['posts']['post']>>['error']>['value'];

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardPath = () => `/en/boards/${id(1)}`;
const licence = 'LicenseRef-rezics-terms';
const boardExample = boardOpeningExample('sparse', 0);
const board = { ...boardExample.board, realmId: null, community: null };
const existingCard = boardOpeningCard(0);
const existing = { ...existingCard.thread, title: 'A shared reading' };
const threads = new Map<string, Thread>();
const createdThreadKeys = new Map<string, string>();

function recordThread(threadId: string, draft: Pick<CreateDraft, 'title' | 'body' | 'mediaIds'>): Thread {
  const opening = existingCard.thread.firstPost;
  if (opening.availability !== 'available') throw new Error('The opening post fixture must be available');
  const thread: Thread = {
    ...existing,
    id: threadId,
    title: draft.title,
    licence,
    firstPost: {
      ...opening,
      id: id(13),
      threadId,
      licence,
      mediaIds: draft.mediaIds ?? [],
      body: draft.body,
    },
  };
  threads.set(threadId, thread);
  return thread;
}

function boardPage(member: boolean): BoardPageResponse {
  return {
    ...boardExample,
    board,
    threads: [...threads.values()].map((thread) => ({
      ...existingCard,
      thread,
      target: { kind: 'thread', id: thread.id, boardId: thread.boardId },
      interaction: { ...existingCard.interaction, target: { kind: 'thread', id: thread.id } },
    })),
    next: null,
    rankRefreshedAt: null,
    viewer: { participation: member ? 'allowed' : 'sign-in' },
    actions: { createThread: member ? 'allowed' : 'sign-in' },
  };
}

function readingPage(thread: Thread, member: string | undefined): ReadingPageResponse {
  const page = authoredReadingPage(thread);
  if (member) page.viewer = { kind: 'account', id: member };
  return page;
}

function readKey(request: Request): string | null {
  const header = request.headers.get('idempotency-key');
  if (!header) return null;
  const key: unknown = JSON.parse(header);
  return typeof key === 'string' ? key : null;
}

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
const futureThreads = new Map<string, string>();

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
  futureThreads.clear();
  createdThreadKeys.clear();
  threads.clear();
  threads.set(existing.id, existing);
}

function reservedContainer(input: { containerId?: string; newThread?: { idempotencyKey?: string } }): string {
  if (typeof input.containerId === 'string') return input.containerId;
  const key = input.newThread?.idempotencyKey;
  if (typeof key !== 'string') return '';
  const known = futureThreads.get(key);
  if (known) return known;
  const created = contentId();
  futureThreads.set(key, created);
  return created;
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
    const sub = subjects.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    const mediaMatch = /^\/v1\/media(?:\/([^/:]+)(?::(complete))?)?$/.exec(url.pathname);
    if (mediaMatch) {
      if (!sub) return mediaProblem(401, 'authentication_required');
      if (!mediaMatch[1] && request.method === 'POST') {
        if (!request.headers.get('idempotency-key')) return mediaProblem(400, 'invalid_request');
        if (refusal === 'type') return mediaProblem(415, 'invalid_request');
        if (refusal === 'size') return mediaProblem(413, 'invalid_request');
        if (refusal === 'rate') return mediaProblem(429, 'rate_limited', { 'retry-after': '7' });
        const input = body as {
          containerId?: string;
          mediaType?: string;
          byteCount?: number;
          sha256?: string;
          newThread?: { idempotencyKey?: string };
        };
        if (input.newThread && threads.has(futureThreads.get(input.newThread.idempotencyKey ?? '') ?? ''))
          return mediaProblem(409, 'conflict');
        if (input.containerId && !threads.has(input.containerId)) return mediaProblem(403, 'forbidden');
        const mediaId = contentId();
        const media: Reservation = {
          id: mediaId,
          state: 'reserved',
          byteCount: input.byteCount ?? 0,
          mediaType: input.mediaType ?? 'application/octet-stream',
          sha256: input.sha256 ?? null,
          containerId: reservedContainer(input),
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
      if (url.pathname === `/v1/boards/${board.id}`) return json({ board });
      if (url.pathname === `/v1/boards/${board.id}/page`) return json(boardPage(Boolean(sub)));
      const reading = /^\/v1\/threads\/([^/]+)(\/reading-page)?$/.exec(url.pathname);
      const thread = reading && threads.get(reading[1]!);
      if (thread) return json(reading[2] ? readingPage(thread, sub) : { thread });
    }
    if (request.method === 'POST' && url.pathname === '/v1/threads') {
      if (!sub) return mediaProblem(401, 'authentication_required');
      const key = readKey(request);
      if (!key) return mediaProblem(400, 'invalid_request');
      const draft = body as CreateDraft;
      const threadId = reservedContainer({ newThread: { idempotencyKey: key } });
      if (
        draft.mediaIds?.some((id) => {
          const media = reservations.get(id);
          return media?.state !== 'available' || media.containerId !== threadId || media.uploaderId !== sub;
        })
      )
        return mediaProblem(409, 'media_unavailable');
      const previous = createdThreadKeys.get(key);
      const thread = previous ? threads.get(previous)! : recordThread(threadId, draft);
      createdThreadKeys.set(key, thread.id);
      return Response.json({ thread }, { status: 201, headers: { Location: `/v1/threads/${thread.id}` } });
    }
    return Response.json(problem(404), { status: 404, headers: { 'content-type': 'application/problem+json' } });
  },
});

// The documented command, pointed at the fake through the environment it reads in development.
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
    },
    warmUpPaths: [],
    exclusive: true,
  }).then((running) => {
    server = running;
    return running.origin;
  });
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
  expect(params.get('scope')?.split(' ').sort()).toEqual(['openid', 'offline_access', ...scopes].sort());
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: existing.authorId,
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
  await server?.stop();
});

const editor = (page: Page) => page.locator('main .ProseMirror[contenteditable="true"]');
const send = (page: Page) => page.locator('main').getByRole('button', { name: 'Send', exact: true });
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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const title = (page: Page) => page.getByRole('textbox', { name: 'Title' });
const draftKey = (page: Page) => page.locator('input[name="idempotency_key"]');
const mediaPosts = () => calls.filter((call) => call.method === 'POST' && call.path === '/v1/media');

async function member() {
  const auth = await signIn('/en');
  expect([302, 303], 'OpenID callback setup').toContain(auth.answer.status);
  expect(auth.session, 'signed-in session setup').toBeTruthy();
  const page = await fetch(`${auth.origin}/en`, { headers: { cookie: `${session}=${auth.session}` } });
  expect(page.status).toBe(200);
  const csrf = await readSessionToken(auth.origin, `${session}=${auth.session}`);
  expect(csrf).toBeDefined();
  return {
    origin: auth.origin,
    headers: { cookie: `${session}=${auth.session}`, origin: auth.origin, 'X-CSRF-Token': csrf! },
  };
}

function futureReservation(idempotencyKey = randomUUID(), sha256?: string) {
  return {
    newThread: { boardId: id(1), idempotencyKey },
    purpose: 'post-image' as const,
    mediaType: 'image/png' as const,
    byteCount: 4,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

// Choose a PNG on the opening draft, then create the thread with that media id.
test(
  "a member adds an image to a new thread's opening post, and the thread is created with its media id",
  async () => {
    reset();
    const { page, access } = await open(boardPath());
    const hops = watchMedia(page);
    const transfer = Promise.withResolvers<void>();
    try {
      await page.getByRole('link', { name: 'Start a new thread' }).click();
      await readyEditor(page);
      await title(page).fill('A charted reading');
      await editor(page).fill('See this chart');
      const key = await draftKey(page).inputValue();
      expect(key).toMatch(uuid);
      expect(await send(page).isEnabled()).toBe(true);
      await page.route('**/media/*', async (route) => {
        if (route.request().method() === 'PUT') await transfer.promise;
        await route.continue();
      });
      await chooseImage(page, 'A reading chart');
      await page
        .getByRole('group', { name: 'A reading chart' })
        .getByText('Uploading image…', { exact: true })
        .waitFor();
      expect(await send(page).isDisabled(), 'send waits for the upload').toBe(true);
      transfer.resolve();
      await page.getByRole('img', { name: 'A reading chart' }).waitFor();
      expect(await send(page).isEnabled()).toBe(true);
      await eventually(() => hops.filter((hop) => hop.method === 'GET').length >= 2);
      const origin = new URL(page.url()).origin;
      expect(hops.every((hop) => new URL(hop.url).origin === origin)).toBe(true);
      expect(hops.map((hop) => hop.method)).toEqual(['POST', 'PUT', 'GET', 'GET']);
      expect(hops[0]!.url).toMatch(/\/media$/);
      expect(hops[1]!.type).toContain('image/png');
      const media = [...reservations.values()].at(-1)!;
      expect(hops[1]!.url).toBe(`${origin}/media/${media.id}`);
      const reserve = mediaPosts().at(-1);
      expect(reserve).toMatchObject({ authorization: `Bearer ${access}` });
      expect(reserve!.body).toEqual({
        newThread: { boardId: id(1), idempotencyKey: key },
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: png.byteLength,
      });
      const complete = calls.find((call) => call.path.endsWith(':complete'));
      expect(complete).toMatchObject({
        path: `/v1/media/${media.id}:complete`,
        authorization: `Bearer ${access}`,
        body: {
          containerId: media.containerId,
          byteCount: png.byteLength,
          sha256: createHash('sha256').update(png).digest('hex'),
        },
      });
      expect(
        calls.filter((call) => call.method === 'GET' && call.path.startsWith('/v1/media/')).length,
      ).toBeGreaterThanOrEqual(3);
      await send(page).click();
      await eventually(() => calls.some((call) => call.method === 'POST' && call.path === '/v1/threads'));
      const sent = calls.find((call) => call.method === 'POST' && call.path === '/v1/threads')!;
      expect(sent.key).toBe(JSON.stringify(key));
      expect(sent).toMatchObject({ authorization: `Bearer ${access}` });
      expect(Object.keys(sent.body as object).sort()).toEqual([
        'boardId',
        'body',
        'licence',
        'mediaIds',
        'subjectIds',
        'title',
        'visibility',
      ]);
      expect(sent.body).toMatchObject({
        boardId: id(1),
        title: 'A charted reading',
        licence,
        subjectIds: [],
        visibility: 'published',
        mediaIds: [media.id],
      });
      const draft = sent.body as CreateDraft;
      expect(documentText(draft.body)).toContain('See this chart');
      expect(draft.body.doc.content?.filter((node) => node.type === 'image')).toEqual([
        expect.objectContaining({
          attrs: expect.objectContaining({ src: media.id, alt: 'A reading chart', width: 1, height: 1 }),
        }),
      ]);
      await page.waitForURL(`**/en/threads/${media.containerId}/a-charted-reading`);
      await page.getByRole('heading', { name: 'A charted reading', exact: true }).waitFor();
      await page.getByText('See this chart', { exact: true }).waitFor();
      expect(calls).toContainEqual(expect.objectContaining({ method: 'GET', path: `/v1/boards/${board.id}/page` }));
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'GET', path: `/v1/threads/${media.containerId}/reading-page` }),
      );
      expect(threads.get(media.containerId)?.firstPost).toMatchObject({
        availability: 'available',
        mediaIds: [media.id],
      });
    } finally {
      transfer.resolve();
      await page.context().close();
    }
  },
  timeout,
);

// The reserve route forwards exactly one future-thread target and rejects every other shape before the kernel.
test(
  "the site's reservation accepts a future thread in place of a container, and nothing else",
  async () => {
    reset();
    const alice = await member();
    const sha256 = 'ab'.repeat(32);
    const posted = futureReservation(randomUUID(), sha256);
    const before = mediaPosts().length;
    const accepted = await fetch(`${alice.origin}/media`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: JSON.stringify(posted),
      redirect: 'manual',
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    expect(mediaPosts().length - before).toBe(1);
    expect(mediaPosts().at(-1)).toMatchObject({ method: 'POST', path: '/v1/media', body: posted });
    const hostile = [
      { ...posted, containerId: id(2) },
      { purpose: 'post-image', mediaType: 'image/png', byteCount: 4 },
      { ...posted, note: 'no' },
      { ...posted, newThread: { ...posted.newThread, extra: true } },
      { ...posted, newThread: { boardId: id(1), idempotencyKey: 'not-a-uuid' } },
      { ...posted, newThread: { boardId: randomUUID(), idempotencyKey: randomUUID() } },
      { ...posted, newThread: { boardId: id(1).toUpperCase(), idempotencyKey: randomUUID() } },
      { ...posted, newThread: { boardId: id(1) } },
      { ...posted, newThread: { idempotencyKey: randomUUID() } },
      { ...posted, newThread: null },
      { ...posted, newThread: [] },
      { ...posted, newThread: 'thread' },
      { ...posted, mediaType: 'image/svg+xml' },
      { ...posted, purpose: 'avatar' },
      { ...posted, byteCount: 1.5 },
      { ...posted, byteCount: 0 },
      { ...posted, byteCount: -1 },
      { ...posted, sha256: 'AB'.repeat(32) },
      { ...posted, uploaderId: 'alice' },
      null,
      [],
    ];
    for (const body of hostile) {
      const at = calls.length;
      const response = await fetch(`${alice.origin}/media`, {
        method: 'POST',
        headers: { ...alice.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'invalid_request', status: 400 });
      expect(calls.length).toBe(at);
    }
  },
  timeout,
);

// The key rendered when the editor opens is the reservation's future-thread key and the creation key.
test(
  'the draft keeps one idempotency key for its uploads and its creation',
  async () => {
    reset();
    const { page, access } = await open(`${boardPath()}/new`);
    try {
      await readyEditor(page);
      const html = await page.content();
      const key = await draftKey(page).inputValue();
      expect(key).toMatch(uuid);
      expect(html).toContain(key);
      await title(page).fill('Opening chart');
      await editor(page).fill('Two charts belong on the opening post');
      await chooseImage(page, 'First chart');
      await page.getByRole('img', { name: 'First chart' }).waitFor();
      await chooseImage(page, 'Second chart');
      await page.getByRole('img', { name: 'Second chart' }).waitFor();
      const reserves = mediaPosts();
      expect(reserves).toHaveLength(2);
      for (const reserve of reserves) {
        expect(reserve).toMatchObject({ authorization: `Bearer ${access}` });
        expect(reserve.body).toEqual({
          newThread: { boardId: id(1), idempotencyKey: key },
          purpose: 'post-image',
          mediaType: 'image/png',
          byteCount: png.byteLength,
        });
      }
      expect(await draftKey(page).inputValue()).toBe(key);
      await send(page).click();
      await eventually(() => calls.some((call) => call.method === 'POST' && call.path === '/v1/threads'));
      const sent = calls.find((call) => call.method === 'POST' && call.path === '/v1/threads')!;
      expect(sent.key).toBe(JSON.stringify(key));
      const ids = [...reservations.values()].map((media) => media.id).sort();
      expect(ids).toHaveLength(2);
      expect([...(sent.body as { mediaIds: string[] }).mediaIds].sort()).toEqual(ids);
      expect(sent.authorization).toBe(`Bearer ${access}`);
      const threadId = futureThreads.get(key);
      expect([...reservations.values()].map((media) => media.containerId)).toEqual([threadId, threadId]);
      await page.waitForURL(`**/en/threads/${threadId}/opening-chart`);
      await page.getByRole('heading', { name: 'Opening chart', exact: true }).waitFor();
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a reservation for a thread that already exists is retried with that thread',
  async () => {
    reset();
    const { page, access } = await open(`${boardPath()}/new`);
    try {
      await readyEditor(page);
      await title(page).fill('Already opened');
      await editor(page).fill('The first chart stays');
      const key = await draftKey(page).inputValue();
      await chooseImage(page, 'First chart');
      await page.getByRole('img', { name: 'First chart' }).waitFor();
      const first = [...reservations.values()].at(-1)!;
      const alreadyCreated = recordThread(first.containerId, {
        title: 'Already opened',
        body: fromPlainText('The first chart stays', 'blocks'),
      });
      const before = mediaPosts().length;
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/media') && response.status() === 409),
        chooseImage(page, 'Second chart'),
      ]);
      await page.getByRole('img', { name: 'Second chart' }).waitFor();
      const added = mediaPosts().slice(before);
      expect(added).toHaveLength(2);
      expect(added[0]!.key).not.toBe(added[1]!.key);
      expect(added[0]).toMatchObject({ authorization: `Bearer ${access}` });
      expect(added[0]!.body).toEqual({
        newThread: { boardId: id(1), idempotencyKey: key },
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: png.byteLength,
      });
      expect(added[1]).toMatchObject({ authorization: `Bearer ${access}` });
      expect(added[1]!.body).toEqual({
        containerId: first.containerId,
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: png.byteLength,
      });
      expect(await draftKey(page).inputValue()).toBe(key);
      expect(reservations.size).toBe(2);
      const second = [...reservations.values()].at(-1)!;
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({
        containerId: alreadyCreated.id,
        uploaderId: first.uploaderId,
        state: 'available',
      });
      expect(threads.get(alreadyCreated.id)).toEqual(alreadyCreated);
      expect(calls.filter((call) => call.method === 'POST' && call.path === '/v1/threads')).toEqual([]);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
