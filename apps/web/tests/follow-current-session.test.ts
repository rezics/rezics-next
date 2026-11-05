import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadFollowState, writeFollowRecord } from '../src/library/follow-records';
import { loadMineFollowingPage, unfollowFollow } from '../src/library/mine-following';
import type { SessionEnv } from '../src/session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../src/session/request';

const origin = 'https://site.example.test';
const csrfToken = 'A'.repeat(22);
const targetId = 'original-target';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';

function request(method = 'GET'): Request {
  return new Request(`${origin}/en/library/following`, {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin,
      'x-csrf-token': csrfToken,
    },
  });
}

function session() {
  const current = { status: 'active' as 'active' | 'absent' | 'unavailable', token: 'cached-viewer', calls: 0 };
  const env: Partial<SessionEnv> = {
    SITE_ORIGINS: origin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://kernel.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused-by-credential-preparation',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          current.calls++;
          return current.status === 'active'
            ? { status: 'active', accessToken: current.token, subject: 'owner', csrfToken }
            : { status: current.status, csrfToken };
        },
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  return { current, env };
}

test('Following refuses an actually stale prepared session before any child read or write and preserves preparation failures', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ follows: [], next: null, follow: { state: 'unfollowed' } });
    },
  });
  const { current, env } = session();
  const cached = request();
  const input = { targetId, idempotencyKey, following: false };
  expect(await prepareSession(cached, env)).toBe(false);
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  expect(sessionSubject(cached)).toBe('owner');

  // The real preparation now returns true; its Request WeakMaps still contain the earlier identity.
  current.status = 'absent';
  expect(await loadMineFollowingPage(client, cached, env, { cursor: 'private-cursor' })).toEqual({
    signedIn: false,
    follows: [],
    next: null,
  });
  expect(await unfollowFollow(client, cached, env, input)).toBe(false);
  expect(await loadFollowState(client, cached, env, targetId)).toEqual({ state: 'signed-out' });
  expect(await writeFollowRecord(client, cached, env, input)).toEqual({ ok: false, reason: 'unauthorized' });
  expect(current.calls).toBe(5);
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  expect(sessionSubject(cached)).toBe('owner');
  expect(calls).toHaveLength(0);

  current.status = 'unavailable';
  const unavailable = { problem: { status: 502, code: 'dependency_unavailable' } };
  await expect(loadMineFollowingPage(client, cached, env, {})).rejects.toMatchObject(unavailable);
  await expect(unfollowFollow(client, cached, env, input)).rejects.toMatchObject(unavailable);
  expect(await loadFollowState(client, cached, env, targetId)).toEqual({ state: 'unavailable' });
  expect(await writeFollowRecord(client, cached, env, input)).toEqual({ ok: false, reason: 'unavailable' });

  // Unsafe cookie requests retain the actual session CSRF/origin refusal rather than becoming signed out.
  current.status = 'active';
  const unsafe = request('POST');
  expect(await prepareSession(unsafe, env)).toBe(false);
  current.status = 'absent';
  const forbidden = { problem: { status: 403, code: 'forbidden' } };
  await expect(unfollowFollow(client, unsafe, env, input)).rejects.toMatchObject(forbidden);
  expect(await writeFollowRecord(client, unsafe, env, input)).toEqual({ ok: false, reason: 'forbidden' });
  current.status = 'active';
  unsafe.headers.set('x-csrf-token', 'B'.repeat(22));
  await expect(unfollowFollow(client, unsafe, env, input)).rejects.toMatchObject(forbidden);
  unsafe.headers.set('x-csrf-token', csrfToken);
  unsafe.headers.set('origin', 'https://other.example.test');
  await expect(unfollowFollow(client, unsafe, env, input)).rejects.toMatchObject(forbidden);
  expect(calls).toHaveLength(0);
});

test('healthy Following preserves current authorization, restrictive bounded reads and exact original write identity', async () => {
  const calls: Request[] = [];
  const staleCursor = 'signed/old+cursor=';
  const nextCursor = 'signed/next+cursor=';
  let alwaysStale = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === '/v1/follows' && call.method === 'GET') {
        if (alwaysStale || url.searchParams.get('cursor') === staleCursor)
          return Response.json({ code: 'stale_cursor' }, { status: 409 });
        return Response.json({
          follows: [
            {
              targetId,
              targetType: 'subject',
              state: 'following',
              reason: 'explicit',
              target: { id: 'current-canonical-target', type: 'Book', label: { value: '本', language: 'ja' } },
            },
            { targetId: 'hidden-space', targetType: 'space', state: 'following', reason: 'membership', target: null },
          ],
          next: nextCursor,
        });
      }
      if (url.pathname === `/v1/follows/${targetId}`)
        return Response.json({ follow: { targetId, state: call.method === 'DELETE' ? 'unfollowed' : 'following' } });
      throw new Error(`Unexpected child request: ${call.method} ${url}`);
    },
  });
  const { current, env } = session();
  const cached = request();
  expect(await prepareSession(cached, env)).toBe(false);
  current.token = 'current-list-viewer';
  const page = await loadMineFollowingPage(client, cached, env, { cursor: staleCursor });
  expect(page.signedIn).toBe(true);
  expect(page.next).toBe(nextCursor);
  expect(page.follows.map(({ targetId, targetType, reason }) => [targetId, targetType, reason])).toEqual([
    [targetId, 'subject', 'explicit'],
    ['hidden-space', 'space', 'membership'],
  ]);
  expect(page.follows[0]?.target).toMatchObject({
    id: 'current-canonical-target',
    label: { value: '本', language: 'ja' },
    labelLanguage: 'ja',
  });
  expect(page.follows[1]?.target).toBeNull();
  expect(page.follows.every((follow) => !('followerCount' in follow))).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
    { view: 'FULL', limit: '100', cursor: staleCursor },
    { view: 'FULL', limit: '100' },
  ]);
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-list-viewer')).toBe(true);

  // No cookie is a valid explicit-Authorization path, not a refused preparation.
  const explicit = new Request(`${origin}/action`, { headers: { authorization: 'Bearer explicit-viewer' } });
  const preparations = current.calls;
  expect(await loadFollowState(client, explicit, env, targetId)).toEqual({ state: 'ready', following: true });
  expect(Object.fromEntries(new URL(calls[2]!.url).searchParams)).toEqual({ view: 'BASIC' });
  expect(calls[2]!.headers.get('authorization')).toBe('Bearer explicit-viewer');
  const selected = page.follows[0]!;
  const input = { targetId: selected.targetId, idempotencyKey: selected.idempotencyKey };
  expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  current.token = 'current-delete-viewer';
  expect(await unfollowFollow(client, request('POST'), env, input)).toBe(true);
  const explicitWrite = new Request(explicit, { method: 'POST' });
  expect(await unfollowFollow(client, explicitWrite, env, input)).toBe(true);
  expect(await writeFollowRecord(client, explicitWrite, env, { ...input, following: false })).toEqual({
    ok: true,
    following: false,
  });
  expect(
    calls
      .slice(3)
      .map((call) => [
        call.method,
        new URL(call.url).pathname,
        call.headers.get('idempotency-key'),
        call.headers.get('authorization'),
      ]),
  ).toEqual([
    ['DELETE', `/v1/follows/${targetId}`, JSON.stringify(input.idempotencyKey), 'Bearer current-delete-viewer'],
    ['DELETE', `/v1/follows/${targetId}`, JSON.stringify(input.idempotencyKey), 'Bearer explicit-viewer'],
    ['DELETE', `/v1/follows/${targetId}`, JSON.stringify(input.idempotencyKey), 'Bearer explicit-viewer'],
  ]);
  expect(current.calls).toBe(preparations + 1);
  expect(calls).toHaveLength(6);

  alwaysStale = true;
  const beforeRetry = calls.length;
  await expect(loadMineFollowingPage(client, request(), env, { cursor: staleCursor })).rejects.toThrow('stale_cursor');
  expect(calls.length - beforeRetry).toBe(2);
  expect(
    calls
      .filter((call) => call.method === 'GET')
      .every((call) => call.cache === 'no-store' && call.redirect === 'manual'),
  ).toBe(true);
});
