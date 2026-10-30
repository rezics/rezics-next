import { afterAll, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';
import { chromium, type Browser, type Page } from 'playwright';
import type { KernelClient } from '@rezics/client';
import fixtures from '../../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../../src/kernel/fake.ts';
import { threadHref } from '../../src/threads/thread-href';
import { startDevServer } from './dev-server';

const clientId = 'rezics-website';
export const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
export const subjectId = fixtures.subjects[0]!.id;
export const subjectPath = `/en/subjects/${subjectId}/${slug(fixtures.subjects[0]!.labels.en!)}`;
export type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
export type SubjectKind = 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
export type SubjectReactionState = {
  calls: Call[];
  counts: Partial<Record<SubjectKind, number>>;
  own: SubjectKind | null;
};
type ThreadResource = ReturnType<KernelClient['threads']>;
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type ThreadRead = Data<ThreadResource['get']>;
export type Posts = Data<ThreadResource['posts']['get']>;
type Snapshot = NonNullable<Posts['posts'][number]['body']>;
type Kind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
export type Counts = Partial<Record<Kind, number>>;
export const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
export const threadPath = (locale = 'en') => `/${locale}${threadHref({ id: id(2), title: 'A shared reading' })}`;
const licence = 'LicenseRef-rezics-terms';
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
export const snapshot = (text: string): Snapshot => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: text ? [{ type: 'text', text }] : [] }],
  },
});
export function post(n: number, body = snapshot('Existing contribution'), threadId = id(2)): Posts['posts'][number] {
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
export function thread(n: number, title: string, body = snapshot('Opening contribution')): ThreadRead {
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

export type ThreadReactionState = {
  calls: Call[];
  refusal: { status: 403 | 422 | 429; code: string } | undefined;
  releaseRefusal: (() => void) | undefined;
  reactionGate: Promise<void> | undefined;
  current: ThreadRead;
  posts: Posts;
};
export async function createSubjectReactionPages(state: SubjectReactionState = { calls: [], counts: {}, own: null }) {
  const scopes = ['reaction:set'];
  const clientKeys = await generateKeyPair('ES256', { extractable: true });
  const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
  const issuerKeys = await generateKeyPair('ES256', { extractable: true });
  const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

  type Grant = { challenge: string; nonce: string; redirectUri: string; scope: string; sub: string; expiresIn: number };
  type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
  const codes = new Map<string, Grant>();
  const families = new Map<string, Family>();
  const assertions = new Set<string>();
  const accessTokens: string[] = [];
  let counter = 0;

  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  const problem = (status: number, code: string) => ({
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: 'not_applicable',
    request_id: randomUUID(),
  });
  // The auth provider and the site dev-server setup follow library-subject-slot.test.ts.
  const fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/turnstile.js')
        return new Response(
          `
        window.turnstile = {
          render(container, options) {
            const verify = document.createElement('button');
            verify.type = 'button'; verify.textContent = 'Verify test challenge';
            verify.onclick = () => options.callback('token-' + crypto.randomUUID());
            container.append(verify);
            return '1';
          },
          reset() {},
          remove(id) {}
        };
      `,
          { headers: { 'content-type': 'text/javascript' } },
        );
      const issuer = `${url.origin}/auth`;
      const tokenEndpoint = `${issuer}/token`;
      const client = async (form: URLSearchParams) => {
        if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
          return false;
        try {
          const { payload, protectedHeader } = await jwtVerify(
            form.get('client_assertion') ?? '',
            clientKeys.publicKey,
            {
              issuer: clientId,
              subject: clientId,
              audience: issuer,
              algorithms: ['ES256'],
              maxTokenAge: '120s',
            },
          );
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
          const code = form.get('code') ?? '';
          const grant = codes.get(code);
          codes.delete(code);
          if (
            !grant ||
            form.get('redirect_uri') !== grant.redirectUri ||
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url') !== grant.challenge
          )
            return json({ error: 'invalid_grant' }, 400);
          return issue({ sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false }, grant.nonce);
        }
        if (form.get('grant_type') === 'refresh_token') {
          const family = families.get(form.get('refresh_token') ?? '');
          if (!family || family.revoked || family.current !== form.get('refresh_token'))
            return json({ error: 'invalid_grant' }, 400);
          return issue(family);
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }
      if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
      if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
      const body =
        request.method === 'GET' || request.method === 'DELETE'
          ? null
          : await request
              .clone()
              .json()
              .catch(() => null);
      state.calls.push({
        method: request.method,
        path: url.pathname,
        body,
        key: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
      });
      const subjectRead = createFakeKernelFetch(fixtures as never);
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${subjectId}`) return subjectRead(request);
      if (request.method === 'POST' && url.pathname === '/v1/pages:read') return subjectRead(request);
      if (url.pathname === `/v1/subjects/${subjectId}/reactions` && request.method === 'GET')
        return json({
          counts: Object.entries(state.counts).map(([kind, count]) => ({ kind, count })),
          watermark: null,
        });
      if (url.pathname === `/v1/subjects/${subjectId}/reaction`) {
        if (request.method === 'GET') {
          if (!request.headers.get('authorization')) return json(problem(401, 'unauthorized'), 401);
          return json({ kind: state.own });
        }
        if (request.method === 'PUT') {
          state.own = (body as { kind: SubjectKind }).kind;
          return json({ kind: state.own });
        }
        if (request.method === 'DELETE') {
          state.own = null;
          return new Response(null, { status: 204 });
        }
      }
      if (url.pathname === '/v1/reports' && request.method === 'POST')
        return json({ reportId: '0192f3a0-6c1e-7b2a-9d4e-0000000000aa' }, 201);
      return json(problem(404, 'not_found'), 404);
    },
  });

  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let started: Promise<string> | undefined;
  function site(): Promise<string> {
    started ??= startDevServer({
      env: {
        KERNEL_ORIGIN: fake.url.origin,
        PUBLIC_ORIGIN: 'https://rezics.test',
        TURNSTILE_SITE_KEY: 'subject-test-key',
        TURNSTILE_SCRIPT_URL: `${fake.url.origin}/turnstile.js`,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
      warmUpPaths: [subjectPath],
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
      ?.split(';')[0]
      ?.slice(name.length + 1);
  async function signIn(returnTo = subjectPath) {
    const origin = await site();
    const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
      redirect: 'manual',
    });
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
    const loginCookie = cookieValue(start, login);
    const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
      redirect: 'manual',
      headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
    });
    expect([302, 303]).toContain(answer.status);
    return { origin, session: cookieValue(answer, session)!, access: accessTokens.at(-1)! };
  }
  let browser: Browser | undefined;
  async function open(
    path: string,
    options: { signedIn?: boolean; javaScript?: boolean; width?: number } = {},
  ): Promise<{ page: Page; access: string | undefined; origin: string }> {
    const { signedIn = true, javaScript = true, width = 1280 } = options;
    const auth = signedIn ? await signIn(path) : undefined;
    const origin = await site();
    browser ??= await chromium.launch();
    const context = await browser.newContext({
      viewport: { width, height: 860 },
      reducedMotion: 'reduce',
      javaScriptEnabled: javaScript,
    });
    if (auth)
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
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(120_000);
    await page.goto(`${origin}${path}`, { waitUntil: javaScript ? 'networkidle' : 'load' });
    if (javaScript) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, access: auth?.access, origin };
  }
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    fake.stop(true);
  });

  return {
    open,
    signIn,
    accessTokens,
    reset(
      next: Partial<Record<SubjectKind, number>> = { like: 6, love: 3, laugh: 2, insightful: 4, sad: 1 },
      selected: SubjectKind | null = null,
    ) {
      state.calls = [];
      state.counts = next;
      state.own = selected;
    },
  };
}

export async function createThreadReactionPages(
  state: ThreadReactionState = {
    calls: [],
    refusal: undefined,
    releaseRefusal: undefined,
    reactionGate: undefined,
    current: thread(2, 'A shared reading'),
    posts: {
      posts: [{ ...post(12), reactions: { like: 9, love: 8, laugh: 7, insightful: 6, sad: 5 }, viewerReaction: 'sad' }],
      next: null,
    },
  },
) {
  const scopes = ['thread:create', 'post:create', 'reaction:set'];
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

  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

  const fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const issuer = `${url.origin}/auth`;
      const tokenEndpoint = `${issuer}/token`;
      const client = async (form: URLSearchParams) => {
        if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
          return false;
        try {
          const { payload, protectedHeader } = await jwtVerify(
            form.get('client_assertion') ?? '',
            clientKeys.publicKey,
            {
              issuer: clientId,
              subject: clientId,
              audience: issuer,
              algorithms: ['ES256'],
              maxTokenAge: '120s',
            },
          );
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
      const body =
        request.method === 'PUT' || request.method === 'POST' ? await request.json().catch(() => null) : null;
      state.calls.push({
        method: request.method,
        path: url.pathname,
        body,
        key: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
      });
      if (request.method === 'GET') {
        if (url.pathname === `/v1/threads/${state.current.thread.id}`) return json(state.current);
        if (url.pathname === `/v1/threads/${state.current.thread.id}/posts`) return json(state.posts);
      }
      if (url.pathname.endsWith('/reaction') && (request.method === 'PUT' || request.method === 'DELETE')) {
        const gate = state.reactionGate;
        if (gate) {
          state.reactionGate = undefined;
          // The optimistic row is already visible. Stay pending until the test releases it.
          await Promise.race([gate, Bun.sleep(15_000)]);
        }
        if (state.refusal) {
          const failed = state.refusal;
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

  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let started: Promise<string> | undefined;
  function site(): Promise<string> {
    started ??= startDevServer({
      env: {
        KERNEL_ORIGIN: fake.url.origin,
        PUBLIC_ORIGIN: 'https://rezics.test',
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
      warmUpPaths: [threadPath()],
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

  async function signIn(returnTo = threadPath()) {
    const origin = await site();
    const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
      redirect: 'manual',
    });
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
    state.releaseRefusal?.();
    await browser?.close();
    await server?.stop();
    fake.stop(true);
  });

  return { open, signIn, accessTokens };
}
