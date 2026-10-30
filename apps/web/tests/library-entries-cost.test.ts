import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import {
  changePersonalLibraryEntry,
  loadPersonalLibrary,
  removePersonalLibraryEntry,
} from '../src/library/entries-read.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const sizes = [5, 500];
const bound = { D: 1, K: 1, R: 0, A: 0 };
// A library page reads one bounded owner page at every collection scale.
const overviewBound = { D: 1, K: 1, R: 0, A: 0 };
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const stamp = '2026-04-02T15:04:05.000Z';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const csrf = newCsrfToken();

test('personal library view and state change stay within their bounds as entries grow', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  let tab = false;
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
        paths.push(`${request.method} ${url.pathname}${url.search}`);
        expect(request.headers.get('authorization')).toBe('Bearer fresh-token');
        expect(unrelated.some((id) => url.pathname.includes(id))).toBe(false);
        if (url.pathname === '/v1/libraryEntries' && request.method === 'GET') {
          expect(url.searchParams.get('view')).toBe('FULL');
          expect(url.searchParams.get('cursor')).toBeNull();
          const state = url.searchParams.get('state');
          expect(state).toBe(tab ? 'planned' : null);
          expect(url.searchParams.get('limit')).toBe('100');
          const limit = 100;
          return Response.json({
            libraryEntries: Array.from({ length: Math.min(size, limit) }, (_, index) => ({
              subjectId: `subject-${index}`,
              state,
              revision: 1,
              createdAt: stamp,
              updatedAt: stamp,
              subject: { id: `subject-${index}`, type: 'book', label: `Label ${index}` },
            })),
            next: null,
          });
        }
        if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'PUT') {
          expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
          expect(await request.json()).toEqual({ state: 'paused', revision: 3 });
          return Response.json({
            libraryEntry: {
              subjectId,
              state: 'paused',
              revision: 4,
              createdAt: stamp,
              updatedAt: stamp,
            },
          });
        }
        if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'DELETE') {
          expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
          expect(url.searchParams.get('revision')).toBe('3');
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected kernel call ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    }),
  );
  const stub = {
    async signedIn() {
      counts.D += 1;
      return { signedIn: true, subject: 'reader', csrfToken: csrf };
    },
    async credential() {
      counts.D += 1;
      return { status: 'active' as const, subject: 'reader', accessToken: 'fresh-token', csrfToken: csrf };
    },
    async create() {
      counts.D += 1;
    },
    async takeLogin() {
      counts.D += 1;
    },
    async end() {
      counts.D += 1;
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
    SITE_ORIGINS: 'https://site.example.test',
    SESSIONS: sessions,
    MEDIA: Object.fromEntries(
      ['get', 'head', 'put', 'delete', 'list'].map((method) => [
        method,
        () => {
          counts.R += 1;
        },
      ]),
    ),
  } as Partial<SessionEnv>;

  for (const scale of sizes) {
    size = scale;
    unrelated.length = 0;
    unrelated.push(...Array.from({ length: scale }, (_, index) => `unrelated-${scale}-${index}`));
    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    paths.length = 0;
    const view = await loadPersonalLibrary(
      client,
      new Request('https://site.example.test/en/library', {
        headers: { cookie: `__Host-rezics_session=${sessionId}` },
      }),
      env,
      {},
    );
    expect(unrelated).toHaveLength(scale);
    if (!view.signedIn) throw new Error('expected a signed-in library');
    if (view.state !== undefined) throw new Error('expected all tracked entries');
    expect(view.entries).toHaveLength(Math.min(scale, 100));
    expect(paths.map((path) => path.split('?')[0])).toEqual(['GET /v1/libraryEntries']);
    expect(paths.some((path) => path.includes('/subjects/') || unrelated.some((id) => path.includes(id)))).toBe(false);
    expect(counts).toEqual(overviewBound);

    tab = true;
    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    paths.length = 0;
    const planned = await loadPersonalLibrary(
      client,
      new Request('https://site.example.test/en/library?state=planned', {
        headers: { cookie: `__Host-rezics_session=${sessionId}` },
      }),
      env,
      { state: 'planned' },
    );
    tab = false;
    if (!planned.signedIn || planned.state !== 'planned') throw new Error('expected the planned filter');
    expect(planned.entries).toHaveLength(Math.min(scale, 100));
    expect(paths.map((path) => path.split('?')[0])).toEqual(['GET /v1/libraryEntries']);
    expect(counts).toEqual(bound);

    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    paths.length = 0;
    const changed = await changePersonalLibraryEntry(
      client,
      new Request('https://site.example.test/en/library', {
        method: 'POST',
        headers: {
          cookie: `__Host-rezics_session=${sessionId}`,
          origin: 'https://site.example.test',
          'x-csrf-token': csrf,
        },
      }),
      env,
      { subjectId, state: 'paused', revision: 3, idempotencyKey },
    );
    expect(changed.ok).toBe(true);
    expect(paths.map((path) => path.split('?')[0])).toEqual([`PUT /v1/libraryEntries/${subjectId}`]);
    expect(counts).toEqual(bound);

    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    paths.length = 0;
    const removed = await removePersonalLibraryEntry(
      client,
      new Request('https://site.example.test/en/library', {
        method: 'POST',
        headers: {
          cookie: `__Host-rezics_session=${sessionId}`,
          origin: 'https://site.example.test',
          'x-csrf-token': csrf,
        },
      }),
      env,
      { subjectId, revision: 3, idempotencyKey },
    );
    expect(removed.ok).toBe(true);
    expect(paths.map((path) => path.split('?')[0])).toEqual([`DELETE /v1/libraryEntries/${subjectId}`]);
    expect(counts).toEqual(bound);
  }
});
