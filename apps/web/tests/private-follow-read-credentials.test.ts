import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadMineFollowingPage } from '../src/library/mine-following';
import { loadPrivateFollowCounts } from '../src/library/private-follow-counts';
import type { SessionEnv } from '../src/session/client';

test('one prepared identity reads native Following order and private counts without mutation credentials', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer owner-token');
      expect(request.headers.has('x-csrf-token')).toBe(false);
      expect(request.cache).toBe('no-store');
      return Response.json(
        new URL(request.url).pathname.endsWith('/outgoing')
          ? { followingCount: 2 }
          : {
              follows: ['z', 'a'].map((targetId) => ({
                targetId,
                targetType: 'subject',
                state: 'following',
                reason: 'explicit',
                updatedAt: '2026-11-03T00:00:00Z',
                target: null,
              })),
              next: 'native-next',
            },
      );
    },
  });
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({ status: 'active', subject: 'owner', accessToken: 'owner-token', csrfToken: null }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.test/en/library/following', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  const following = await loadMineFollowingPage(client, request(), env, { cursor: 'native-cursor' });
  expect(following.follows.map((row) => row.targetId)).toEqual(['z', 'a']);
  expect(following.next).toBe('native-next');
  expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('native-cursor');
  expect((await loadPrivateFollowCounts(client, request(), env, {})).outgoing).toEqual({ state: 'ready', count: 2 });
  expect(calls).toHaveLength(2);
});
