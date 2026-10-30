import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadMineFollowingPage, unfollowFollow } from '../src/library/mine-following';

const siteOrigin = 'https://site.example.test';
const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const stamp = '2026-10-30T07:00:00.000Z';

function signedInSession() {
  return {
    async credential() {
      return { status: 'active', subject: 'alice', accessToken: 'alice-page-token', csrfToken };
    },
    async signedIn() {
      return { signedIn: true, subject: 'alice', csrfToken };
    },
  };
}

function sessionEnv(): Partial<SessionEnv> {
  const session = signedInSession();
  const sessions = {
    idFromName: (name: string) => name,
    get: () => session,
  } as unknown as DurableObjectNamespace<SessionStore>;

  return {
    SITE_ORIGINS: siteOrigin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-following-test',
    WEBSITE_CLIENT_KEY: 'unused-by-the-session-read',
    SESSIONS: sessions,
  };
}

function pageRequest(path: string, method = 'GET', unsafe = false): Request {
  return new Request(`${siteOrigin}${path}`, {
    method,
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(unsafe ? { origin: siteOrigin, 'x-csrf-token': csrfToken } : {}),
    },
  });
}

test('Following reads only each requested FULL page and maps embedded targets without exposing totals', async () => {
  const requests: { method: string; path: string; cursor: string | null }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, cursor: url.searchParams.get('cursor') });
      expect(url.pathname).toBe('/v1/follows');
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer alice-page-token');
      expect(url.searchParams.get('view')).toBe('FULL');
      expect(url.searchParams.get('limit')).toBe('100');

      if (url.searchParams.get('cursor') === null)
        return Response.json({
          follows: [
            {
              targetId: 'subject-1',
              targetType: 'subject',
              state: 'following',
              reason: 'explicit',
              updatedAt: stamp,
              target: {
                id: 'subject-1',
                type: 'schema:Book',
                types: ['schema:Book'],
                label: { value: 'Embedded book title', language: 'en' },
                creativeWork: true,
                cover: null,
              },
            },
            {
              targetId: 'collection-1',
              targetType: 'collection',
              state: 'following',
              reason: 'explicit',
              updatedAt: stamp,
              target: { id: 'collection-1', type: 'collection', label: 'Embedded collection title' },
            },
          ],
          next: 'cursor-page-two',
        });

      expect(url.searchParams.get('cursor')).toBe('cursor-page-two');
      return Response.json({
        follows: [
          {
            targetId: 'space-1',
            targetType: 'space',
            state: 'following',
            reason: 'membership',
            updatedAt: stamp,
            target: { id: 'space-1', type: 'space', label: 'Embedded space title' },
          },
          {
            targetId: 'erased-subject',
            targetType: 'subject',
            state: 'following',
            reason: 'explicit',
            updatedAt: stamp,
            target: null,
          },
        ],
        next: null,
      });
    }) as typeof fetch,
  });
  const env = sessionEnv();

  const first = await loadMineFollowingPage(client, pageRequest('/en/library/following'), env, {});
  expect(first.signedIn).toBe(true);
  expect(first.follows.map(({ targetId, targetType }) => [targetId, targetType])).toEqual([
    ['subject-1', 'subject'],
    ['collection-1', 'collection'],
  ]);
  expect(first.follows[0]?.target?.label).toEqual({ value: 'Embedded book title', language: 'en' });
  expect(first.follows[1]?.target?.label).toBe('Embedded collection title');
  expect(first.next).toBe('cursor-page-two');

  const second = await loadMineFollowingPage(client, pageRequest('/en/library/following?cursor=cursor-page-two'), env, {
    cursor: first.next ?? undefined,
  });
  expect(second.signedIn).toBe(true);
  expect(second.follows.map(({ targetId, targetType }) => [targetId, targetType])).toEqual([
    ['space-1', 'space'],
    ['erased-subject', 'subject'],
  ]);
  expect(second.follows[0]?.target?.label).toBe('Embedded space title');
  expect(second.follows[1]?.target).toBeNull();
  expect(second.next).toBeNull();
  expect(requests).toEqual([
    { method: 'GET', path: '/v1/follows', cursor: null },
    { method: 'GET', path: '/v1/follows', cursor: 'cursor-page-two' },
  ]);
  expect([...first.follows, ...second.follows].every((follow) => !('followerCount' in follow))).toBe(true);
});

test('signed-out Following returns an empty private view without reading the native list', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => {
      throw new Error('signed-out Following must not read native follows');
    }) as typeof fetch,
  });

  const page = await loadMineFollowingPage(client, new Request(`${siteOrigin}/en/library/following`), {}, {});

  expect(page).toEqual({ signedIn: false, follows: [], next: null });
});

test('unfollow sends one authenticated native delete for the selected target', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ follow: { targetId: 'collection-1', state: 'unfollowed' } });
    }) as typeof fetch,
  });

  const ok = await unfollowFollow(client, pageRequest('/en/library/following', 'POST', true), sessionEnv(), {
    targetId: 'collection-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });

  expect(ok).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe('DELETE');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/follows/collection-1');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer alice-page-token');
  expect(requests[0]?.headers.get('idempotency-key')).toBe('123e4567-e89b-42d3-a456-426614174000');
});
