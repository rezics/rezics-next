import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { loadSubjectLibraryCollections, loadSubjectLibrarySlot } from '../src/library/subject-slot.ts';
import type { SessionEnv } from '../src/session/client.ts';
import type { SessionStore } from '../src/session/store.ts';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const sessionId = 'a'.repeat(43);
const sizes = [1, 10, 100];
const stamp = '2026-04-02T15:04:05.000Z';

test('subject library slot stays within its bound as its collections grow', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
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
        expect(request.method).toBe('GET');
        expect(url.searchParams.get('view')).toBe('FULL');
        if (url.pathname === `/v1/libraryEntries/${subjectId}`)
          return Response.json({
            libraryEntry: {
              subjectId,
              state: 'planned',
              revision: 1,
              createdAt: stamp,
              updatedAt: stamp,
              subject: { id: subjectId, type: 'book', label: 'Cost subject' },
            },
          });
        if (url.pathname === `/v1/subjects/${subjectId}/collections`) {
          expect(url.searchParams.get('limit')).toBe('20');
          expect(url.searchParams.get('cursor')).toBeNull();
          const limit = Number(url.searchParams.get('limit') ?? '20');
          return Response.json({
            collections: Array.from({ length: Math.min(size, limit) }, (_, index) => ({
              id: `public-${index}`,
              curatorAccountId: `curator-${index}`,
              title: `Public ${index}`,
              multiplicity: index + 1,
              curator: { id: `curator-${index}`, handle: `user-${index}`, displayName: `User ${index}` },
            })),
            count: { value: size, exact: true },
            next: size > limit ? 'opaque-next' : null,
          });
        }
        if (url.pathname === '/v1/collections') {
          expect(url.searchParams.get('limit')).toBe('20');
          expect(url.searchParams.get('cursor')).toBeNull();
          const limit = Number(url.searchParams.get('limit') ?? '20');
          return Response.json({
            collections: Array.from({ length: Math.min(size, limit) }, (_, index) => ({
              id: `mine-${index}`,
              curatorAccountId: 'owner',
              membershipKind: 'curated',
              title: `Mine ${index}`,
              description: null,
              visibility: 'private',
              revision: 1,
              memberCount: 0,
              createdAt: stamp,
              updatedAt: stamp,
              curator: { id: 'owner', handle: 'reader', displayName: 'Reader' },
            })),
            next: size > limit ? 'opaque-next' : null,
          });
        }
        throw new Error(`unexpected kernel request: ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    }),
  );

  for (const scale of sizes) {
    size = scale;
    for (const scenario of [
      { signedIn: true, pickerOpen: false },
      { signedIn: true, pickerOpen: true },
      { signedIn: false, pickerOpen: false },
    ]) {
      counts.D = 0;
      counts.K = 0;
      counts.R = 0;
      counts.A = 0;
      const stub = {
        async credential() {
          counts.D += 1;
          return scenario.signedIn
            ? { status: 'active', subject: 'owner', accessToken: 'access-token', csrfToken: 'csrf-token' }
            : { status: 'absent' };
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
      const request = new Request('https://site.example.test/en/subjects/subject', {
        headers: scenario.signedIn ? { cookie: `__Host-rezics_session=${sessionId}` } : {},
      });
      const data = await loadSubjectLibrarySlot(client, request, env, subjectId);
      expect(data.publicCollections).toHaveLength(Math.min(scale, 20));
      expect(data.publicCollectionsCount).toEqual({ kind: 'exact', value: scale });
      expect(data.collections).toBeNull();
      if (scenario.signedIn) {
        expect(counts).toEqual({ D: 1, K: 2, R: 0, A: 0 });
        if (scenario.pickerOpen) {
          const collectionPage = await loadSubjectLibraryCollections(client, new Request(request), env);
          expect(collectionPage.state).toBe('loaded');
          expect(collectionPage.collections).toHaveLength(Math.min(scale, 20));
          expect(collectionPage.next).toBe(scale > 20 ? 'opaque-next' : null);
          expect(counts).toEqual({ D: 2, K: 3, R: 0, A: 0 });
        }
      } else {
        expect(counts).toEqual({ D: 0, K: 1, R: 0, A: 0 });
      }
    }
  }
});
