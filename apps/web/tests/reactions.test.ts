import { browserSessionToken } from './session-token';
import { afterAll, expect as bunExpect, test } from 'bun:test';

// bun:test has no locator matchers. These two forward to the same checks the assertions name.
function expect(actual: unknown) {
  const base = bunExpect(actual) as unknown as Record<PropertyKey, unknown>;
  const locator = actual as {
    getAttribute?: (name: string, options?: { timeout?: number }) => Promise<string | null>;
    waitFor?: (options?: { state?: 'visible'; timeout?: number }) => Promise<void>;
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'toHaveAttribute' && typeof locator?.getAttribute === 'function') {
        return async (name: string, value: string) => {
          const deadline = Date.now() + 15_000;
          let current: string | null = null;
          while (Date.now() < deadline) {
            try {
              current = await locator.getAttribute!(name, { timeout: 250 });
            } catch {
              current = null;
            }
            if (current === value) return;
            await Bun.sleep(50);
          }
          bunExpect(current).toBe(value);
        };
      }
      if (property === 'toBeVisible' && typeof locator?.waitFor === 'function') {
        return async () => {
          await locator.waitFor!({ state: 'visible', timeout: 15_000 });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
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
const scopes = ['thread:create', 'post:create', 'reaction:set'];

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

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

type ThreadResource = ReturnType<KernelClient['threads']>;
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type ThreadRead = Data<ThreadResource['get']>;
type Posts = Data<ThreadResource['posts']['get']>;
type Snapshot = NonNullable<Posts['posts'][number]['body']>;
type Kind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
type Counts = Partial<Record<Kind, number>>;
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

type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
const calls: Call[] = [];
let refusal: { status: 403 | 422 | 429; code: string } | undefined;
let releaseRefusal: (() => void) | undefined;
let reactionGate: Promise<void> | undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let current = thread(2, 'A shared reading');
let posts: Posts = { posts: [post(12)], next: null };

function problem(status: 403 | 422 | 429, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: status === 429,
    effect_status: 'not_applied',
    request_id: randomUUID(),
  };
}
function reset() {
  calls.length = 0;
  refusal = undefined;
  releaseRefusal = undefined;
  reactionGate = undefined;
  current = thread(2, 'A shared reading');
  current.thread.reactions = { upvote: 4 };
  current.thread.viewerReaction = null;
  posts = {
    posts: [
      { ...post(12), reactions: { sad: 8 }, viewerReaction: null },
      { ...post(13, snapshot('A different reading')), reactions: { like: 2 }, viewerReaction: 'like' },
    ],
    next: null,
  };
}
function holdRefusal() {
  refusal = { status: 403, code: 'forbidden' };
  let settled = false;
  reactionGate = new Promise<void>((resolve) => {
    releaseRefusal = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  return reactionGate;
}

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
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body = request.method === 'PUT' || request.method === 'POST' ? await request.json().catch(() => null) : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    if (request.method === 'GET') {
      if (url.pathname === `/v1/threads/${current.thread.id}`) return json(current);
      if (url.pathname === `/v1/threads/${current.thread.id}/posts`) return json(posts);
    }
    if (url.pathname.endsWith('/reaction') && (request.method === 'PUT' || request.method === 'DELETE')) {
      const gate = reactionGate;
      if (gate) {
        reactionGate = undefined;
        // The optimistic row is already visible. Stay pending until the test releases it.
        await Promise.race([gate, Bun.sleep(15_000)]);
      }
      if (refusal) {
        const failed = refusal;
        return Response.json(problem(failed.status, failed.code), {
          status: failed.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ kind: (body as { kind?: string } | null)?.kind ?? 'like' });
    }
    return Response.json(problem(404, 'not_found'), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    });
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
        if (response.status < 500) {
          const thread = await fetch(`${origin}${threadPath()}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(90_000),
          });
          if (thread.status >= 500) throw new Error(`thread page did not compile:\n${output}`);
          return origin;
        }
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

async function signIn(returnTo = threadPath()) {
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
async function open(
  path: string,
  signedIn = true,
): Promise<{ page: Page; access: string | undefined; origin: string }> {
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
  page.setDefaultNavigationTimeout(120_000);
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return { page, access: auth ? accessTokens.at(-1) : undefined, origin };
}
afterAll(async () => {
  releaseRefusal?.();
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const reactionsOf = (page: Page, index: number) =>
  page.locator('main ol > li').nth(index).getByRole('group', { name: 'Reactions' });
const reactionCalls = () => calls.filter((call) => call.path.endsWith('/reaction'));
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}
function expectReaction(
  call: Call | undefined,
  method: string,
  path: string,
  access: string | undefined,
  body: unknown,
) {
  expect(call?.method).toBe(method);
  expect(call?.path).toBe(path);
  expect(call?.authorization).toBe(`Bearer ${access}`);
  expect(call?.key).toMatch(uuid);
  expect(call?.body).toEqual(body);
}

// Show the thread reaction under the opening post and each reply's own reaction, then replace and clear both.
test(
  'a signed-in member reacts to a thread and a post, replacing and clearing the reaction',
  async () => {
    reset();
    const { page, access, origin } = await open(threadPath());
    const browserPosts: BrowserRequest[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).origin === origin) browserPosts.push(request);
    });
    try {
      const threadReactions = reactionsOf(page, 0);
      const replyReactions = reactionsOf(page, 1);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');
      expect(await threadReactions.getByRole('button', { name: /Sad/ }).count()).toBe(0);
      await expect(replyReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');

      await threadReactions.getByRole('button', { name: 'React', exact: true }).click();
      const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await choices.getByRole('button', { name: 'Like', exact: true }).click();
      await eventually(() => reactionCalls().length === 1);
      expectReaction(reactionCalls()[0], 'PUT', `/v1/threads/${id(2)}/reaction`, access, { kind: 'like' });
      await expect(threadReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'true');

      await choices.getByRole('button', { name: 'Love', exact: true }).click();
      await eventually(() => reactionCalls().length === 2);
      expectReaction(reactionCalls()[1], 'PUT', `/v1/threads/${id(2)}/reaction`, access, { kind: 'love' });
      expect(reactionCalls()[1]!.key).not.toBe(reactionCalls()[0]!.key);
      await expect(threadReactions.getByRole('button', { name: 'Love 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(await threadReactions.getByRole('button', { name: 'Like 1' }).count()).toBe(0);

      await threadReactions.getByRole('button', { name: 'Love 1' }).click();
      await eventually(() => reactionCalls().length === 3);
      expectReaction(reactionCalls()[2], 'DELETE', `/v1/threads/${id(2)}/reaction`, access, null);
      expect(reactionCalls()[2]!.key).not.toBe(reactionCalls()[1]!.key);
      expect(await threadReactions.getByRole('button', { name: 'Love 1' }).count()).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');

      await replyReactions.getByRole('button', { name: 'React', exact: true }).click();
      const replyChoices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await replyChoices.getByRole('button', { name: 'Insightful', exact: true }).click();
      await eventually(() => reactionCalls().length === 4);
      expectReaction(reactionCalls()[3], 'PUT', `/v1/posts/${id(13)}/reaction`, access, { kind: 'insightful' });
      await expect(replyReactions.getByRole('button', { name: 'Insightful 1' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(replyReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');

      await replyReactions.getByRole('button', { name: 'Insightful 1' }).click();
      await eventually(() => reactionCalls().length === 5);
      expectReaction(reactionCalls()[4], 'DELETE', `/v1/posts/${id(13)}/reaction`, access, null);
      expect(new Set(reactionCalls().map((call) => call.key)).size).toBe(5);
      expect(await replyReactions.getByRole('button', { name: 'Insightful 1' }).count()).toBe(0);
      await expect(replyReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');

      expect(browserPosts).toHaveLength(5);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      for (const request of browserPosts) {
        expect(request.headers()['x-csrf-token']).toBe(csrf!);
        expect(request.headers()['content-type']).toContain('application/json');
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Counts stay visible. React is a sign-in link back to this thread, and nothing is sent.
test(
  'a signed-out visitor sees counts and a sign-in link instead of reacting',
  async () => {
    reset();
    calls.length = 0;
    const { page, origin } = await open(threadPath(), false);
    try {
      const threadReactions = reactionsOf(page, 0);
      const replyReactions = reactionsOf(page, 1);
      await expect(threadReactions.getByRole('img', { name: 'Upvote 4' })).toBeVisible();
      await expect(replyReactions.getByRole('img', { name: 'Like 2' })).toBeVisible();
      expect(await threadReactions.getByRole('button').count()).toBe(0);
      expect(await replyReactions.getByRole('button').count()).toBe(0);
      const links = [threadReactions, replyReactions];
      for (const group of links) {
        const link = group.getByRole('link', { name: 'React', exact: true });
        const target = new URL((await link.getAttribute('href'))!, origin);
        expect(`${target.origin}${target.pathname}`).toBe(`${origin}/auth/sign-in`);
        expect(target.searchParams.get('return_to')).toBe(threadPath());
      }
      expect(reactionCalls()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// A refused change returns to the previous counts and names the kernel's reason, including a closed platform.
test(
  'a refused reaction rolls back and says why',
  async () => {
    reset();
    current.thread.reactions = { like: 2, upvote: 4 };
    current.thread.viewerReaction = 'like';
    const held = holdRefusal();
    const { page } = await open(threadPath());
    try {
      const threadReactions = reactionsOf(page, 0);
      await threadReactions.getByRole('button', { name: 'React', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Choose a reaction' })
        .getByRole('button', { name: 'Love', exact: true })
        .click();
      await expect(threadReactions.getByRole('button', { name: 'Love 1' })).toHaveAttribute('aria-pressed', 'true');
      refusal = { status: 403, code: 'forbidden' };
      releaseRefusal?.();
      await held;
      await expect(
        threadReactions.getByRole('status', { name: 'You do not have permission to change this reaction.' }),
      ).toBeVisible();
      await expect(threadReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');
      expect(await threadReactions.getByRole('button', { name: 'Love 1' }).count()).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');

      refusal = { status: 403, code: 'platform_closed' };
      await page
        .getByRole('dialog', { name: 'Choose a reaction' })
        .getByRole('button', { name: 'Upvote', exact: true })
        .click();
      await expect(threadReactions.getByRole('status', { name: 'This part of REZICS is not open yet.' })).toBeVisible();
      expect(
        await threadReactions
          .getByRole('status', { name: 'You do not have permission to change this reaction.' })
          .count(),
      ).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');
      expect(reactionCalls().map((call) => call.path)).toEqual([
        `/v1/threads/${id(2)}/reaction`,
        `/v1/threads/${id(2)}/reaction`,
      ]);
    } finally {
      releaseRefusal?.();
      await page.context().close();
    }
  },
  timeout,
);

// Counts and the viewer's kind ride the thread read and the one post page. A long page adds no reaction read.
test(
  'a thread page reads reactions with its thread and post reads',
  async () => {
    reset();
    current.thread.reactions = { upvote: 9 };
    current.thread.viewerReaction = 'upvote';
    posts = {
      posts: [
        { ...post(12), reactions: { sad: 8 }, viewerReaction: null },
        ...Array.from({ length: 99 }, (_, index) => ({
          ...post(13 + index, snapshot(`Reply ${index}`)),
          reactions: { like: 3 } satisfies Counts,
          viewerReaction: null,
        })),
      ],
      next: null,
    };
    const auth = await signIn(threadPath());
    expect([302, 303]).toContain(auth.answer.status);
    calls.length = 0;
    const response = await fetch(`${auth.origin}${threadPath()}`, {
      headers: { cookie: `${session}=${auth.session}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(
      [`GET /v1/threads/${id(2)}`, `GET /v1/threads/${id(2)}/posts`, 'GET /v1/accounts'].sort(),
    );
    expect(
      calls
        .filter((call) => call.path !== '/v1/accounts')
        .every((call) => call.authorization === `Bearer ${accessTokens.at(-1)}`),
    ).toBe(true);
    expect(calls.find((call) => call.path === '/v1/accounts')?.authorization).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/reaction'))).toBe(false);
    expect(html.match(/data-slot="reactions"/g)?.length).toBe(100);
    expect(html).toContain('Upvote');
    expect(html).toContain('aria-pressed="true"');
  },
  timeout,
);
