import { afterEach, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { type AccountClient, refreshTokens } from '../features/auth/account.ts';
import { accessMaxAge, rewriteCookieHeader } from '../features/auth/cookies.ts';
import { refreshSession } from '../features/auth/refresh.ts';
import { encodeSessionRecord, sessionCookies } from '../features/auth/session-state.ts';
import { proxy } from '../proxy.ts';

const realFetch = globalThis.fetch;
const env = { ...process.env };
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...env }; });

/** A JWT-shaped token naming `sub`; the session layer reads claims, never signatures. */
function token(sub: string, id = crypto.randomUUID()): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ sub, jti: id })}.x`;
}

interface Exchange { body: URLSearchParams }
function account(answer: (exchange: Exchange) => Response | Promise<Response>) {
  const exchanges: Exchange[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const exchange = { body: new URLSearchParams(String(init?.body)) };
    exchanges.push(exchange);
    return answer(exchange);
  }) as typeof fetch;
  const client: AccountClient = { accountOrigin: 'http://account.test', clientId: 'web',
    resource: 'https://main.rezics.test', fetch: fetcher };
  return { client, exchanges, fetcher };
}
const issued = (sub = 'user-1') => Response.json({ access_token: token(sub),
  refresh_token: crypto.randomUUID(), expires_in: 300 });
const jar = (values: Record<string, string>) => ({ get: (name: string) =>
  values[name] === undefined ? undefined : { value: values[name]! } });

test('IAM01: concurrent requests with one refresh token share one Account exchange', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { client, exchanges } = account(async () => { await gate; return issued(); });
  const refreshToken = crypto.randomUUID();
  const pending = Array.from({ length: 6 }, () => refreshTokens(client, refreshToken));
  release();
  const results = await Promise.all(pending);
  expect(exchanges).toHaveLength(1);
  expect(exchanges[0]!.body.get('grant_type')).toBe('refresh_token');
  expect(exchanges[0]!.body.get('refresh_token')).toBe(refreshToken);
  expect(exchanges[0]!.body.get('resource')).toBe('https://main.rezics.test');
  expect(new Set(results.map(result => result.status === 'issued' && result.tokens.accessToken)).size).toBe(1);
});

test('IAM01: a request still carrying the rotated cookie reuses the rotation for 30 s, then asks again', async () => {
  const { client, exchanges } = account(() => issued());
  const refreshToken = crypto.randomUUID();
  let now = 1_000_000;
  const first = await refreshTokens(client, refreshToken, () => now);
  now += 29_000;
  expect(await refreshTokens(client, refreshToken, () => now)).toEqual(first);
  expect(exchanges).toHaveLength(1);
  now += 2_000;
  await refreshTokens(client, refreshToken, () => now);
  expect(exchanges).toHaveLength(2);
});

test('IAM01: an unavailable Account is retried by the next request; a refused grant ends the session', async () => {
  let answer: () => Response = () => new Response('down', { status: 503 });
  const { client, exchanges } = account(() => answer());
  const refreshToken = crypto.randomUUID();
  expect(await refreshTokens(client, refreshToken)).toEqual({ status: 'unavailable' });
  answer = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  expect(await refreshTokens(client, refreshToken)).toEqual({ status: 'rejected' });
  expect(exchanges).toHaveLength(2);
  const failing = account(() => { throw new TypeError('connection refused'); });
  expect(await refreshTokens(failing.client, crypto.randomUUID())).toEqual({ status: 'unavailable' });
});

test('IAM01: refresh runs only when the access cookie is gone and keeps the signed-in user', async () => {
  const { client, exchanges } = account(() => issued('user-1'));
  const user = { id: 'user-1', name: 'Ada', email: 'ada@example.test', image: null };
  const record = encodeSessionRecord({ user, expiresAt: new Date().toISOString() });
  expect(await refreshSession(jar({ rezics_access: 'a', rezics_refresh: 'r' }), client))
    .toEqual({ kind: 'current' });
  expect(await refreshSession(jar({}), client)).toEqual({ kind: 'current' });
  expect(exchanges).toHaveLength(0);
  const refreshed = await refreshSession(jar({ rezics_refresh: crypto.randomUUID(), rezics_session: record }), client);
  expect(refreshed.kind === 'refreshed' && refreshed.user).toEqual(user);
  // A record for someone else is display data only; the token decides who is signed in.
  const other = await refreshSession(jar({ rezics_refresh: crypto.randomUUID(),
    rezics_session: encodeSessionRecord({ user: { ...user, id: 'user-2' }, expiresAt: '2030-01-01T00:00:00Z' }) }), client);
  expect(other.kind === 'refreshed' && other.user).toEqual({ id: 'user-1', name: '', email: '', image: null });
  const opaque = account(() => Response.json({ access_token: 'opaque', expires_in: 300 }));
  expect(await refreshSession(jar({ rezics_refresh: crypto.randomUUID() }), opaque.client)).toEqual({ kind: 'ended' });
});

test('IAM01: session cookies are httpOnly and Lax, the access cookie lapses before the token does', () => {
  expect(accessMaxAge(300)).toBe(270);
  expect(accessMaxAge(60)).toBe(48);
  expect(accessMaxAge(3600)).toBe(270);
  expect(accessMaxAge(Number.NaN)).toBe(270);
  const cookies = sessionCookies('https://web.rezics.test/studio',
    { accessToken: 'a', refreshToken: 'r', expiresIn: 300 },
    { id: 'u', name: 'Ada', email: 'ada@example.test', image: null }, 0);
  expect(cookies.map(cookie => [cookie.name, cookie.options.maxAge])).toEqual([
    ['rezics_access', 270], ['rezics_session', 2_592_000], ['rezics_refresh', 2_592_000]]);
  for (const { options } of cookies) {
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
  }
  const withoutRefresh = sessionCookies('http://127.0.0.1:3000/', { accessToken: 'a',
    refreshToken: null, expiresIn: 300 }, { id: 'u', name: '', email: '', image: null }, 0);
  expect(withoutRefresh.map(cookie => cookie.name)).toEqual(['rezics_access', 'rezics_session']);
  expect(withoutRefresh[0]!.options.secure).toBe(false);
});

test('IAM01: the rewritten Cookie header replaces session cookies and keeps the rest', () => {
  expect(rewriteCookieHeader('rezics_locale=en; rezics_access=old; theme=dark',
    { rezics_access: 'new', rezics_refresh: 'r2', rezics_session: null }))
    .toBe('rezics_locale=en; theme=dark; rezics_access=new; rezics_refresh=r2');
  expect(rewriteCookieHeader(null, { rezics_access: null })).toBe('');
});

function configure(fetcher: typeof fetch) {
  process.env.WEB_OAUTH_CLIENT_ID = 'web';
  process.env.ACCOUNT_ORIGIN = 'http://account.test';
  globalThis.fetch = fetcher;
}

test('IAM01: the proxy refreshes before the page and hands the new session to both the page and the browser', async () => {
  const { fetcher, exchanges } = account(() => issued('user-1'));
  configure(fetcher);
  const refreshToken = crypto.randomUUID();
  const response = await proxy(new NextRequest('http://web.test/studio', { headers: {
    cookie: `rezics_locale=en; rezics_refresh=${refreshToken}` } }));
  expect(exchanges).toHaveLength(1);
  const set = response.headers.getSetCookie();
  expect(set.find(line => line.startsWith('rezics_access='))).toContain('HttpOnly');
  expect(set.find(line => line.startsWith('rezics_refresh='))).not.toContain(refreshToken);
  expect(set.find(line => line.startsWith('rezics_session_key='))).toContain('HttpOnly');
  // Code after the proxy reads the rotated tokens from the forwarded Cookie header.
  const forwarded = response.headers.get('x-middleware-request-cookie') ?? '';
  expect(forwarded).toContain('rezics_locale=en');
  expect(forwarded).toMatch(/rezics_access=[^;]+/);
  expect(forwarded).not.toContain(refreshToken);
});

test('IAM01: a refresh extends the same Main session Agent key', async () => {
  configure(account(() => issued('user-1')).fetcher);
  const key = crypto.randomUUID();
  const response = await proxy(new NextRequest('http://web.test/studio', { headers: {
    cookie: `rezics_refresh=${crypto.randomUUID()}; rezics_session_key=${key}` } }));
  expect(response.headers.getSetCookie().find(line => line.startsWith('rezics_session_key=')))
    .toContain(`rezics_session_key=${key}`);
  expect(response.headers.get('x-middleware-request-cookie')).toContain(`rezics_session_key=${key}`);
});

test('IAM01: a refused refresh signs the browser out cleanly instead of failing the page', async () => {
  configure(account(() => Response.json({ error: 'invalid_grant' }, { status: 400 })).fetcher);
  const response = await proxy(new NextRequest('http://web.test/', { headers: {
    cookie: `rezics_refresh=${crypto.randomUUID()}; rezics_session=x; rezics_subject=y; rezics_session_key=z` } }));
  const set = response.headers.getSetCookie();
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session',
    'rezics_session_key', 'rezics_subject']) {
    expect(set.find(line => line.startsWith(`${name}=`))).toMatch(/Max-Age=0/);
  }
  expect(response.headers.get('x-middleware-request-cookie') ?? '').not.toContain('rezics_');
  // Signed out or current: no Account call and no changes.
  let calls = 0;
  configure((async () => { calls += 1; return issued(); }) as unknown as typeof fetch);
  const untouched = await proxy(new NextRequest('http://web.test/', { headers: {
    cookie: `rezics_access=a; rezics_session_key=${crypto.randomUUID()}` } }));
  expect(calls).toBe(0);
  expect(untouched.headers.getSetCookie()).toEqual([]);
  const migrated = await proxy(new NextRequest('http://web.test/', { headers: {
    cookie: 'rezics_access=a; rezics_subject=old' } }));
  expect(migrated.headers.getSetCookie().some(line => line.startsWith('rezics_session_key='))).toBe(true);
  expect(migrated.headers.getSetCookie().find(line => line.startsWith('rezics_subject=')))
    .toMatch(/Max-Age=0/);
  expect(migrated.headers.get('x-middleware-request-cookie')).toContain('rezics_session_key=');
  expect(migrated.headers.get('x-middleware-request-cookie')).not.toContain('rezics_subject=');
});
