import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['thread:create', 'post:create', 'post:erase'];
const [websiteKeys, issuerKeys] = await Promise.all([
  generateKeyPair('ES256', { extractable: true }),
  generateKeyPair('ES256', { extractable: true }),
]);
const websiteKey = { ...(await exportJWK(websiteKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

const id = (number: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(number).padStart(12, '0')}`;
const authorId = id(1);
const boardId = id(2);
const threadId = id(3);
const openingId = id(10);
const replyId = id(11);
const withheldId = id(12);
const deletedId = id(13);
const expiredId = id(14);
const decisionId = id(15);
const createdAt = '2026-10-01T12:00:00.000Z';
const body = (text: string) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text }] }],
  },
});

type FixturePost = {
  route: number;
  visibility: 'published';
  securityRevision: string;
  createdAt: string;
  id: string;
  threadId: string;
  boardId: string;
  authorId: string;
  parentId: null;
  revisionId: string;
  sha256: string | null;
  licence: string;
  subjectIds: string[];
  mediaIds: string[];
  availability: 'available' | 'erased' | 'withheld';
  removed?: true;
  body: ReturnType<typeof body> | null;
  restorableUntil?: string;
  decisionId?: string;
};

function post(postId: string, text: string): FixturePost {
  return {
    route: 0,
    visibility: 'published',
    securityRevision: '1',
    createdAt,
    id: postId,
    threadId,
    boardId,
    authorId,
    parentId: null,
    revisionId: id(Number(postId.slice(-2)) + 100),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body: body(text),
  };
}

const originals = new Map<string, FixturePost>();
let currentPosts = new Map<string, FixturePost>();
let currentTitle = 'A close reading';
let restoreConflict = false;
const writes: { method: string; path: string; key: string | null; authorization: string | null }[] = [];
const accessSubjects = new Map<string, string>();
let lastAccessToken = '';
let tokenSequence = 0;
const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; sub: string }>();

const json = (value: unknown, status = 200, problem = false) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(problem ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

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

function reset(mode: 'discussion' | 'deleted' | 'withheld' | 'visual' = 'discussion') {
  const opening = post(openingId, 'Opening post by Mira');
  const reply = post(replyId, 'A reply by Mira');
  const values = [opening, reply];
  if (mode === 'deleted' || mode === 'visual') {
    const restorable: FixturePost = {
      ...post(deletedId, 'Restorable post body'),
      availability: 'erased',
      removed: true,
      body: null,
      sha256: null,
      restorableUntil: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const expired: FixturePost = {
      ...post(expiredId, 'Expired post body'),
      availability: 'erased',
      removed: true,
      body: null,
      sha256: null,
      restorableUntil: new Date(Date.now() - 1_000).toISOString(),
    };
    values.push(restorable, expired);
  }
  if (mode === 'withheld' || mode === 'visual')
    values.push({
      ...post(withheldId, 'Private notice text'),
      availability: 'withheld',
      removed: true,
      body: null,
      sha256: null,
      decisionId,
    });
  originals.clear();
  currentPosts = new Map(values.map((value) => [value.id, value]));
  for (const value of values) {
    if (value.availability === 'available') originals.set(value.id, value);
  }
  currentTitle = 'A close reading';
  restoreConflict = false;
  writes.length = 0;
}

reset();

function actor(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return accessSubjects.get(authorization.slice('Bearer '.length)) ?? null;
}

function authorProfile() {
  return {
    id: authorId,
    kind: 'actor',
    handle: 'mira',
    displayName: 'Mira Example',
    state: 'active',
    automated: false,
    operatorId: null,
  };
}

const board = {
  board: {
    route: 0,
    visibility: 'published',
    securityRevision: '1',
    createdAt,
    id: boardId,
    title: 'Reading room',
    availability: 'available',
    realmId: null,
  },
};

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
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
      const code = form.get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code);
      const verifier = form.get('code_verifier') ?? '';
      if (
        form.get('grant_type') !== 'authorization_code' ||
        !grant ||
        form.get('redirect_uri') !== grant.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
      )
        return json({ error: 'invalid_grant' }, 400);
      tokenSequence += 1;
      lastAccessToken = `access-${tokenSequence}`;
      accessSubjects.set(lastAccessToken, grant.sub);
      const idToken = await new SignJWT({ nonce: grant.nonce })
        .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
        .setIssuer(issuer)
        .setSubject(grant.sub)
        .setAudience(clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(issuerKeys.privateKey);
      return json({
        access_token: lastAccessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${tokenSequence}`,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
        id_token: idToken,
      });
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });

    const authorization = request.headers.get('authorization');
    const key = request.headers.get('idempotency-key');
    if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname, key, authorization });

    if (request.method === 'GET' && url.pathname === `/v1/boards/${boardId}`) return json(board);
    if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}`) {
      const opening = currentPosts.get(openingId)!;
      return json({
        thread: {
          route: 0,
          visibility: 'published',
          securityRevision: '1',
          createdAt,
          id: threadId,
          boardId,
          authorId,
          licence: 'CC-BY-4.0',
          subjectIds: [],
          title: currentTitle,
          availability: 'available',
          firstPost: opening,
        },
      });
    }
    if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}/posts`)
      return json({ posts: [...currentPosts.values()], next: null });
    if (request.method === 'GET' && url.pathname === '/v1/accounts')
      return json({
        accounts: url.searchParams.get('ids')?.split(',').includes(authorId) ? [authorProfile()] : [],
        next: null,
      });
    if (request.method === 'GET' && /\/v1\/(?:posts|threads)\/[^/]+\/reaction$/.test(url.pathname))
      return json({ kind: null });

    const postId = /^\/v1\/posts\/([^/:]+)$/.exec(url.pathname)?.[1];
    const restoreId = /^\/v1\/posts\/([^/:]+):restore$/.exec(url.pathname)?.[1];
    if (!actor(request) || actor(request) !== authorId) return json(problem(401, 'unauthorized'), 401, true);
    if (request.method === 'DELETE' && postId && currentPosts.has(postId)) {
      const current = currentPosts.get(postId)!;
      currentPosts.set(postId, {
        ...current,
        availability: 'erased',
        removed: true,
        body: null,
        sha256: null,
        restorableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
      if (postId === openingId) currentTitle = null;
      return new Response(null, { status: 204 });
    }
    if (request.method === 'POST' && restoreId && currentPosts.has(restoreId)) {
      if (restoreConflict) return json(problem(409, 'conflict'), 409, true);
      const restored = originals.get(restoreId);
      if (restored) currentPosts.set(restoreId, restored);
      if (restoreId === openingId) currentTitle = 'A close reading';
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
let browser: Browser | undefined;

async function site(): Promise<string> {
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
        WEBSITE_CLIENT_KEY: JSON.stringify(websiteKey),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: ['openid', 'offline_access', ...scopes].join(' '),
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/@vite/client`, { signal: AbortSignal.timeout(60_000) });
        if (response.ok) return origin;
        throw new Error(`Vite answered ${response.status} while starting:\n${await response.text()}`);
      } catch {
        // The Vite server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

function cookieValue(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);
}

async function signIn(path: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(path)}`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location')!);
  const params = location.searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    sub: authorId,
  });
  const login = cookieValue(start, loginCookie);
  const callback = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: login ? { cookie: `${loginCookie}=${login}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(callback.status);
  const session = cookieValue(callback, sessionCookie);
  expect(session, 'signed-in session setup').toBeTruthy();
  return { origin, session: session!, access: lastAccessToken };
}

async function open(path: string, options: { width?: number } = {}) {
  const auth = await signIn(path);
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
  await context.addCookies([
    {
      name: sessionCookie,
      value: auth.session,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${auth.origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.locator('main').getByRole('button', { name: 'More actions' }).first().waitFor({ state: 'visible' });
  return { page, access: auth.access };
}

async function eventually(read: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  expect(await read(), label).toBe(true);
}

async function deleteFromMenu(page: Page, postId: string) {
  const slot = page.locator(`#post-${postId}`);
  await slot.getByRole('button', { name: 'More actions' }).click();
  await page.getByText('Delete', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete content', exact: true }).click();
  await slot.locator('[data-slot="tombstone"]').waitFor({ state: 'visible' });
  return slot;
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
  'an author deletes a post in place and Undo restores it with exactly two kernel writes',
  async () => {
    reset();
    const { page, access } = await open(`/en/threads/${threadId}/a-close-reading`, { width: 390 });
    const slot = page.locator(`#post-${replyId}`);
    try {
      expect(access).toBeTruthy();
      const before = await slot.boundingBox();
      writes.length = 0;
      await deleteFromMenu(page, replyId);
      await eventually(
        () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'More actions'),
        'focus returned to the post actions trigger',
      );
      expect(await slot.innerText()).toContain('This post was deleted.');
      expect(await slot.innerText()).not.toContain('A reply by Mira');
      const after = await slot.boundingBox();
      expect(after?.height ?? 0).toBeGreaterThanOrEqual((before?.height ?? 0) - 1);
      await page.getByText('Post deleted', { exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await eventually(async () => (await slot.innerText()).includes('A reply by Mira'), 'post restore');
      expect(await slot.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(writes.map(({ method, path }) => [method, path])).toEqual([
        ['DELETE', `/v1/posts/${replyId}`],
        ['POST', `/v1/posts/${replyId}:restore`],
      ]);
      expect(writes.every((write) => write.authorization === `Bearer ${access}`)).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'an erased post is a Tombstone and its author can restore only before the deadline',
  async () => {
    reset('deleted');
    const { page } = await open(`/en/threads/${threadId}/a-close-reading`);
    try {
      const active = page.locator(`#post-${deletedId} [data-slot="tombstone"]`);
      const expired = page.locator(`#post-${expiredId} [data-slot="tombstone"]`);
      await active.waitFor({ state: 'visible' });
      await expired.waitFor({ state: 'visible' });
      expect(
        await page.locator(`#post-${deletedId}`).getByRole('button', { name: 'Restore', exact: true }).count(),
      ).toBe(1);
      expect(
        await page.locator(`#post-${expiredId}`).getByRole('button', { name: 'Restore', exact: true }).count(),
      ).toBe(0);
      expect(await page.locator(`#post-${deletedId}`).innerText()).toContain('This post was deleted.');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a withheld post keeps its author and time, replaces the body, and links its author to the decision',
  async () => {
    reset('withheld');
    const { page } = await open(`/en/threads/${threadId}/a-close-reading`);
    try {
      const slot = page.locator(`#post-${withheldId}`);
      expect(await slot.innerText()).toContain('Mira Example');
      expect(await slot.locator('time').getAttribute('datetime')).toBe(createdAt);
      expect(await slot.locator('[data-slot="withheld"]').innerText()).toContain('Withheld');
      expect(await slot.innerText()).not.toContain('Private notice text');
      expect(await slot.getByRole('link', { name: 'View moderation decision' }).getAttribute('href')).toBe(
        `/moderation/decisions/${decisionId}`,
      );
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a restore conflict explains that a newer review took the slot and keeps the Tombstone',
  async () => {
    reset();
    const { page } = await open(`/en/threads/${threadId}/a-close-reading`);
    const slot = page.locator(`#post-${replyId}`);
    try {
      writes.length = 0;
      await deleteFromMenu(page, replyId);
      restoreConflict = true;
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'A newer review took this slot.' }).waitFor({ state: 'visible' });
      expect(await slot.locator('[data-slot="tombstone"]').count()).toBe(1);
      expect(await slot.innerText()).not.toContain('A reply by Mira');
      expect(writes.map(({ method, path }) => [method, path])).toEqual([
        ['DELETE', `/v1/posts/${replyId}`],
        ['POST', `/v1/posts/${replyId}:restore`],
      ]);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'deleting the opening post keeps its thread and replies while removing the title',
  async () => {
    reset();
    const { page } = await open(`/en/threads/${threadId}/a-close-reading`, { width: 1280 });
    try {
      expect(await page.getByRole('heading', { level: 1, name: 'A close reading' }).count()).toBe(1);
      await deleteFromMenu(page, openingId);
      expect(await page.locator(`#post-${openingId} [data-slot="tombstone"]`).count()).toBe(1);
      expect(await page.locator(`#post-${replyId}`).innerText()).toContain('A reply by Mira');
      expect(await page.getByRole('heading', { level: 1, name: 'A close reading' }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'deleted, withheld, and restored posts fit English and Simplified Chinese layouts at phone and desktop widths',
  async () => {
    const screenshots = join(app, '../..', '.temp', 'post-delete-visuals');
    mkdirSync(screenshots, { recursive: true });
    for (const locale of ['en', 'zh-Hans'] as const) {
      for (const width of [390, 1280] as const) {
        reset('visual');
        const { page } = await open(`/${locale}/threads/${threadId}/a-close-reading`, { width });
        const slot = page.locator(`#post-${replyId}`);
        try {
          writes.length = 0;
          await deleteFromMenu(page, replyId);
          await page.getByRole('button', { name: 'Undo', exact: true }).click();
          await eventually(async () => (await slot.innerText()).includes('A reply by Mira'), 'restored post');
          expect(await page.locator(`#post-${deletedId} [data-slot="tombstone"]`).count()).toBe(1);
          expect(await page.locator(`#post-${withheldId} [data-slot="withheld"]`).count()).toBe(1);
          const dimensions = await page.evaluate(() => ({
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
          }));
          expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
          expect(writes.map(({ method, path }) => [method, path])).toEqual([
            ['DELETE', `/v1/posts/${replyId}`],
            ['POST', `/v1/posts/${replyId}:restore`],
          ]);
          await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`), fullPage: true });
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);
