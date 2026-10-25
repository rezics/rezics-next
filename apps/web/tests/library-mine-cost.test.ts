import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadMineCollectionsPage } from '../src/library/mine-collections';
import { loadMineFollowingPage, unfollowFollow } from '../src/library/mine-following';

const scales = [1, 10, 100];
const bound = { D: 1, K: 1, R: 0, A: 0 };
const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const stamp = '2026-10-26T12:00:00.000Z';

test('my collections and following stay within their bound as list size grows', async () => {
  for (const pageKind of ['collections', 'following', 'unfollow'] as const) {
    for (const size of scales) {
      const counts = { D: 0, K: 0, R: 0, A: 0 };
      const paths: string[] = [];
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          counts.K += 1;
          const request = new Request(input, init);
          const url = new URL(request.url);
          paths.push(`${request.method} ${url.pathname}${url.search}`);
          expect(request.headers.get('authorization')).toBe('Bearer page-token');
          if (pageKind === 'unfollow') {
            expect(request.method).toBe('DELETE');
            expect(url.pathname).toBe('/v1/follows/subject-to-unfollow');
            expect(request.headers.get('idempotency-key')).toBe('123e4567-e89b-42d3-a456-426614174000');
            return Response.json({ follow: { targetId: 'subject-to-unfollow', state: 'unfollowed' } });
          }
          expect(request.method).toBe('GET');
          expect(url.searchParams.get('view')).toBe('FULL');
          expect(url.searchParams.get('limit')).toBe('100');
          expect(url.searchParams.get('cursor')).toBeNull();
          if (url.pathname === '/v1/collections') {
            expect(url.searchParams.get('curatorAccountId')).toBe('alice');
            return Response.json({
              collections: Array.from({ length: size }, (_, index) => ({
                id: `collection-${index}`,
                curatorAccountId: 'alice',
                title: `Collection ${index}`,
                description: null,
                visibility: (['private', 'public', 'unlisted'] as const)[index % 3]!,
                revision: 1,
                memberCount: index,
                createdAt: stamp,
                updatedAt: stamp,
                curator: { id: 'alice', handle: 'ada', displayName: 'Ada' },
              })),
              next: null,
            });
          }
          if (url.pathname === '/v1/follows')
            return Response.json({
              follows: Array.from({ length: size }, (_, index) => ({
                targetId: `subject-${index}`,
                targetType: 'subject',
                state: 'following',
                reason: 'explicit',
                updatedAt: stamp,
                target: { id: `subject-${index}`, type: 'book', label: `Subject ${index}` },
              })),
              next: null,
            });
          throw new Error(`unexpected kernel request ${request.method} ${url.pathname}`);
        }) as typeof fetch,
      });
      const session = {
        async credential() {
          counts.D += 1;
          return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken };
        },
        async signedIn() {
          counts.D += 1;
          return { signedIn: true, subject: 'alice', csrfToken };
        },
      };
      const sessions = {
        idFromName: (name: string) => name,
        get: () => session,
      } as unknown as DurableObjectNamespace<SessionStore>;
      const env = {
        SITE_ORIGINS: 'https://site.example.test',
        AUTH_ISSUER: 'https://auth.example.test',
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'openid',
        WEBSITE_CLIENT_ID: 'rezics-web-cost',
        WEBSITE_CLIENT_KEY: 'unused-by-this-read',
        SESSIONS: sessions,
      } as Partial<SessionEnv>;
      const request = new Request(`https://site.example.test/en/library/${pageKind}`, {
        method: pageKind === 'unfollow' ? 'POST' : 'GET',
        headers: {
          cookie: `__Host-rezics_session=${sessionId}`,
          ...(pageKind === 'unfollow' ? { origin: 'https://site.example.test', 'x-csrf-token': csrfToken } : {}),
        },
      });
      if (pageKind === 'collections') {
        const page = await loadMineCollectionsPage(client, request, env, {});
        expect(page.signedIn).toBe(true);
        expect(page.collections).toHaveLength(size);
      } else if (pageKind === 'following') {
        const page = await loadMineFollowingPage(client, request, env, {});
        expect(page.signedIn).toBe(true);
        expect(page.follows).toHaveLength(size);
      } else {
        expect(
          await unfollowFollow(client, request, env, {
            targetId: 'subject-to-unfollow',
            idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
          }),
        ).toBe(true);
      }
      expect(paths).toHaveLength(1);
      expect(counts).toEqual(bound);
    }
  }
});
