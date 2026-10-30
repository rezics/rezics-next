import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import {
  createCollectionRecord,
  deleteCollectionRecord,
  followCollectionRecord,
  moveCollectionMemberRecord,
  removeCollectionMemberRecord,
  unfollowCollectionRecord,
  updateCollectionRecord,
  updateMemberNoteRecord,
} from '../src/library/collection-records.ts';
import { loadEditableCollectionPage } from '../src/library/collection-load.ts';
import type { SessionEnv } from '../src/session/client.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
const sizes = [1, 10, 100];
const collectionId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const memberId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const stamp = '2026-04-02T15:04:05.000Z';
const site = 'https://site.example.test';

type Counts = { D: number; K: number; R: number; A: number };

test('collection editing stays within its bound as the collection grows', async () => {
  const counts: Counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  let curator = 'owner';
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
          expect(request.headers.get('authorization')).toBe('Bearer access-token');
          if (unrelated.some((id) => url.pathname.includes(id)))
            throw new Error(`unrelated id was read at scale ${size}`);
          if (request.method !== 'GET') expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
          if (request.method === 'POST' && url.pathname === '/v1/collections') {
            return Response.json({ collection: { id: collectionId } }, { status: 201 });
          }
          if (request.method === 'PATCH' && url.pathname === `/v1/collections/${collectionId}`) {
            expect(await request.json()).toMatchObject({ revision: 1 });
            return Response.json({ collection: { id: collectionId, revision: 2 } });
          }
          if (request.method === 'DELETE' && url.pathname === `/v1/collections/${collectionId}`) {
            expect(url.searchParams.get('revision')).toBe('1');
            return new Response(null, { status: 204 });
          }
          if (url.pathname === `/v1/collections/${collectionId}/members/${memberId}:move`) {
            return Response.json({ member: { id: memberId, subjectId: 'subject', note: null, addedAt: stamp } });
          }
          if (request.method === 'PATCH' && url.pathname === `/v1/collections/${collectionId}/members/${memberId}`) {
            return Response.json({ member: { id: memberId, subjectId: 'subject', note: 'note', addedAt: stamp } });
          }
          if (request.method === 'DELETE' && url.pathname === `/v1/collections/${collectionId}/members/${memberId}`) {
            expect(url.searchParams.get('revision')).toBe('1');
            expect(request.body).toBeNull();
            return new Response(null, { status: 204 });
          }
          if (request.method === 'GET' && url.pathname === `/v1/collections/${collectionId}`) {
            expect(url.searchParams.get('view')).toBe('FULL');
            return Response.json({
              collection: {
                id: collectionId,
                curatorAccountId: curator,
                title: 'Cost shelf',
                description: null,
                visibility: 'public',
                revision: 1,
                memberCount: size,
                createdAt: stamp,
                updatedAt: stamp,
                curator: { id: curator, handle: 'ada', displayName: 'Ada' },
              },
            });
          }
          if (request.method === 'GET' && url.pathname === `/v1/collections/${collectionId}/members`) {
            expect(url.searchParams.get('view')).toBe('FULL');
            expect(url.searchParams.get('limit')).toBe('100');
            return Response.json({
              members: Array.from({ length: size }, (_, index) => ({
                id: `member-${index}`,
                subjectId: `subject-${index}`,
                note: null,
                addedAt: stamp,
                subject: { id: `subject-${index}`, type: 'book', label: `Label ${index}` },
              })),
              next: null,
            });
          }
          if (url.pathname === `/v1/follows/${collectionId}`) {
            if (request.method === 'GET') expect(url.searchParams.get('view')).toBe('FULL');
            return Response.json({
              follow: {
                targetId: collectionId,
                targetType: 'collection',
                state: request.method === 'DELETE' ? 'unfollowed' : 'following',
                reason: 'explicit',
                updatedAt: stamp,
              },
            });
          }
          throw new Error(`unexpected kernel call ${request.method} ${url.pathname}`);
        } finally {
          pending -= 1;
        }
      }) as typeof fetch,
    }),
  );
  const stub = {
    async signedIn() {
      counts.D += 1;
      return { signedIn: true, subject: 'viewer', csrfToken: csrf };
    },
    async credential() {
      counts.D += 1;
      return { status: 'active' as const, subject: 'viewer', accessToken: 'access-token', csrfToken: csrf };
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
  const env = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-cost',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: { idFromName: (id: string) => id, get: () => stub } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;

  // A write is a server-function POST with the session cookie, the site origin and the CSRF header.
  const write = () =>
    new Request(`${site}/_serverFn/collection`, {
      method: 'POST',
      headers: { cookie: `__Host-rezics_session=${sessionId}`, origin: site, 'x-csrf-token': csrf },
    });
  const page = () =>
    new Request(`${site}/en/collections/${collectionId}`, {
      headers: { cookie: `__Host-rezics_session=${sessionId}` },
    });

  const writes: { path: string; run: () => Promise<unknown>; id: string }[] = [
    {
      path: 'POST /v1/collections',
      id: collectionId,
      run: () =>
        createCollectionRecord(client, write(), env, {
          title: 'Cost shelf',
          description: 'Plain text',
          visibility: 'public',
          idempotencyKey,
        }),
    },
    {
      path: `PATCH /v1/collections/${collectionId}`,
      id: collectionId,
      run: () =>
        updateCollectionRecord(client, write(), env, {
          collectionId,
          revision: 1,
          title: 'Cost shelf',
          description: 'Plain text',
          visibility: 'public',
          idempotencyKey,
        }),
    },
    {
      path: `DELETE /v1/collections/${collectionId}?revision=1`,
      id: collectionId,
      run: () => deleteCollectionRecord(client, write(), env, { collectionId, revision: 1, idempotencyKey }),
    },
    {
      path: `POST /v1/collections/${collectionId}/members/${memberId}:move`,
      id: memberId,
      run: () =>
        moveCollectionMemberRecord(client, write(), env, {
          collectionId,
          memberId,
          after: '0192f3a0-6c1e-7b2a-9d4e-000000000022',
          idempotencyKey,
        }),
    },
    {
      path: `PATCH /v1/collections/${collectionId}/members/${memberId}`,
      id: memberId,
      run: () =>
        updateMemberNoteRecord(client, write(), env, { collectionId, memberId, note: 'A note', idempotencyKey }),
    },
    {
      path: `DELETE /v1/collections/${collectionId}/members/${memberId}?revision=1`,
      id: memberId,
      run: () =>
        removeCollectionMemberRecord(client, write(), env, { collectionId, memberId, revision: 1, idempotencyKey }),
    },
    {
      path: `PUT /v1/follows/${collectionId}`,
      id: collectionId,
      run: () => followCollectionRecord(client, write(), env, { collectionId, idempotencyKey }),
    },
    {
      path: `DELETE /v1/follows/${collectionId}`,
      id: collectionId,
      run: () => unfollowCollectionRecord(client, write(), env, { collectionId, idempotencyKey }),
    },
  ];

  const reset = (scale: number) => {
    size = scale;
    counts.D = counts.K = counts.R = counts.A = 0;
    pending = 0;
    maxPending = 0;
    paths.length = 0;
    unrelated.length = 0;
    unrelated.push(...Array.from({ length: scale }, (_, index) => `unrelated-${scale}-${index}`));
  };

  for (const scale of sizes) {
    // Each change is one kernel write after the session read, whatever the collection holds.
    for (const operation of writes) {
      reset(scale);
      expect(await operation.run()).toEqual({ ok: true, id: operation.id });
      expect(paths).toEqual([operation.path]);
      expect(counts).toEqual({ D: 1, K: 1, R: 0, A: 0 });
      expect(maxPending).toBe(1);
    }

    // The follow state is one kernel read next to the page's own two, and the curator needs none.
    reset(scale);
    curator = 'someone-else';
    const viewed = await loadEditableCollectionPage(client, page(), env, { id: collectionId });
    expect(viewed.following).toBe(true);
    expect(viewed.members).toHaveLength(scale);
    expect(paths.filter((path) => path.startsWith('GET /v1/follows/'))).toEqual([
      `GET /v1/follows/${collectionId}?view=FULL`,
    ]);
    expect(paths).toHaveLength(3);
    expect(counts).toEqual({ D: 1, K: 3, R: 0, A: 0 });

    reset(scale);
    curator = 'viewer';
    const owned = await loadEditableCollectionPage(client, page(), env, { id: collectionId });
    expect(owned.following).toBeNull();
    expect(paths.some((path) => path.startsWith('GET /v1/follows/'))).toBe(false);
    expect(counts).toEqual({ D: 1, K: 2, R: 0, A: 0 });
  }
});
