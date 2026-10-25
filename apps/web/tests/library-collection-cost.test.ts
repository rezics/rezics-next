import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { loadCollectionPage } from '../src/library/reads.ts';
import type { SessionEnv } from '../src/session/client.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const sizes = [1, 10, 100];
const bound = { D: 1, K: 2, R: 0, A: 0 };
const collectionId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const stamp = '2026-04-02T15:04:05.000Z';

test('collection page stays within its bound as its member page grows', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  let pending = 0;
  let maxPending = 0;
  const paths: string[] = [];
  const unrelated: string[] = [];
  const client = withPlatformClosedRecognition(
    createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith('/auth/')) {
          counts.A += 1;
          return new Response(null, { status: 404 });
        }
        counts.K += 1;
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        await Promise.resolve();
        try {
          paths.push(`${request.method} ${url.pathname}${url.search}`);
          expect(request.headers.get('authorization')).toBeNull();
          if (unrelated.some((id) => url.pathname === `/v1/collections/${id}`)) {
            return Response.json({
              collection: {
                id: url.pathname.split('/').at(-1),
                curatorAccountId: 'someone-else',
                title: 'Other shelf',
                description: null,
                visibility: 'public',
                revision: 1,
                memberCount: 0,
                createdAt: stamp,
                updatedAt: stamp,
                curator: null,
              },
            });
          }
          if (url.pathname === `/v1/collections/${collectionId}`) {
            expect(url.searchParams.get('view')).toBe('FULL');
            expect(request.method).toBe('GET');
            return Response.json({
              collection: {
                id: collectionId,
                curatorAccountId: 'owner',
                title: 'Cost shelf',
                description: 'Plain text',
                visibility: 'public',
                revision: 1,
                memberCount: size,
                createdAt: stamp,
                updatedAt: stamp,
                curator: { id: 'owner', handle: 'ada', displayName: 'Ada' },
              },
            });
          }
          if (url.pathname === `/v1/collections/${collectionId}/members`) {
            expect(request.method).toBe('GET');
            expect(url.searchParams.get('view')).toBe('FULL');
            expect(url.searchParams.get('limit')).toBe('100');
            expect(url.searchParams.get('cursor')).toBeNull();
            return Response.json({
              members: Array.from({ length: size }, (_, index) => ({
                id: `member-${index}`,
                subjectId: `subject-${index}`,
                note: `note-${index}`,
                addedAt: stamp,
                subject: { id: `subject-${index}`, type: 'book', label: `Label ${index}` },
              })),
              next: null,
            });
          }
          throw new Error(`unexpected kernel read ${url.pathname}`);
        } finally {
          pending -= 1;
        }
      }) as typeof fetch,
    }),
  );

  for (const scale of sizes) {
    size = scale;
    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    pending = 0;
    maxPending = 0;
    paths.length = 0;
    unrelated.length = 0;
    unrelated.push(...Array.from({ length: scale }, (_, index) => `unrelated-${scale}-${index}`));
    const stub = {
      async signedIn() {
        counts.D += 1;
        return { signedIn: true, subject: 'owner', csrfToken: 'csrf' };
      },
      async credential() {
        counts.D += 1;
        return null;
      },
      async create() {
        counts.D += 1;
        return undefined;
      },
      async takeLogin() {
        counts.D += 1;
        return undefined;
      },
      async end() {
        counts.D += 1;
        return undefined;
      },
    };
    const sessions = {
      idFromName: (id: string) => id,
      get: () => stub,
    } as unknown as DurableObjectNamespace<SessionStore>;
    const env = {
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'rezics-web-cost',
      WEBSITE_CLIENT_KEY: 'unused-by-this-read',
      SESSIONS: sessions,
    } as Partial<SessionEnv>;
    const request = new Request(`https://site.example.test/en/collections/${collectionId}`, {
      headers: { cookie: `__Host-rezics_session=${sessionId}` },
    });
    const page = await loadCollectionPage(client, request, env, { id: collectionId });
    expect(unrelated).toHaveLength(scale);
    expect(page.members).toHaveLength(scale);
    expect(paths.some((path) => path.includes('/subjects/') || unrelated.some((id) => path.includes(id)))).toBe(false);
    expect(paths.map((path) => path.split('?')[0]).sort()).toEqual(
      [`GET /v1/collections/${collectionId}`, `GET /v1/collections/${collectionId}/members`].sort(),
    );
    expect(counts).toEqual(bound);
    expect(maxPending).toBe(2);
  }
});
