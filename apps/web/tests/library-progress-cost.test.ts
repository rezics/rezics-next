import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { loadProgressSession, recordProgress } from '../src/library/progress-reads.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const csrf = newCsrfToken();
const sizes = [1, 10, 100];
const viewBound = { D: 1, K: 3, R: 0, A: 0 };
const recordBound = { D: 1, K: 1, R: 0, A: 0 };
const progressId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const stamp = '2026-04-02T15:04:05.000Z';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';

test('reading progress stays within its bound as its pages and unit batches grow', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  let pending = 0;
  let maxPending = 0;
  const paths: string[] = [];
  const unrelated: string[] = [];
  let recordedAdd = 0;
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
          expect(request.headers.get('authorization')).toBe('Bearer access-cost');
          expect(unrelated.some((id) => url.pathname.includes(id))).toBe(false);
          if (url.pathname === `/v1/progressSessions/${progressId}` && request.method === 'GET') {
            expect(url.searchParams.get('view')).toBe('FULL');
            return Response.json({
              progressSession: {
                id: progressId,
                subjectId,
                versionSubjectId: null,
                mode: 'completed_units',
                unit: 'episode',
                total: null,
                amount: null,
                locator: null,
                position: null,
                completedUnitCount: size,
                state: 'active',
                revision: 1,
                startedAt: stamp,
                completedAt: null,
                subject: { id: subjectId, type: 'book', label: 'Cost subject' },
                versionSubject: null,
              },
            });
          }
          if (url.pathname === `/v1/progressSessions/${progressId}/changes` && request.method === 'GET') {
            expect(url.searchParams.get('view')).toBe('FULL');
            expect(url.searchParams.get('limit')).toBe('100');
            expect(url.searchParams.get('cursor')).toBeNull();
            return Response.json({
              changes: Array.from({ length: size }, (_, index) => ({
                id: `${progressId}:${index + 1}`,
                revision: index + 1,
                intent: { amount: String(index + 1) },
                createdAt: stamp,
              })),
              next: null,
            });
          }
          if (url.pathname === `/v1/progressSessions/${progressId}/completedUnits` && request.method === 'GET') {
            expect(url.searchParams.get('view')).toBe('FULL');
            expect(url.searchParams.get('limit')).toBe('100');
            expect(url.searchParams.get('cursor')).toBeNull();
            return Response.json({
              completedUnits: Array.from({ length: size }, (_, index) => `unit-${index}`),
              next: null,
            });
          }
          if (url.pathname === `/v1/progressSessions/${progressId}:record` && request.method === 'POST') {
            expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
            const body = (await request.json()) as { revision?: number; add?: string[] };
            recordedAdd = body.add?.length ?? -1;
            expect(body.revision).toBe(1);
            expect(body.add).toHaveLength(size);
            return Response.json({
              progressSession: {
                id: progressId,
                subjectId,
                versionSubjectId: null,
                mode: 'completed_units',
                unit: 'episode',
                total: null,
                amount: null,
                locator: null,
                position: null,
                completedUnitCount: size,
                state: 'active',
                revision: 2,
                startedAt: stamp,
                completedAt: null,
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
      return { signedIn: true, subject: 'owner', csrfToken: csrf };
    },
    async credential() {
      counts.D += 1;
      return { status: 'active' as const, subject: 'owner', accessToken: 'access-cost', csrfToken: csrf };
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
    SITE_ORIGINS: 'https://site.example.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => stub,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;

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
    const view = await loadProgressSession(
      client,
      new Request(`https://site.example.test/en/library/progress/${progressId}`, {
        headers: { cookie: `__Host-rezics_session=${sessionId}` },
      }),
      env,
      { id: progressId },
    );
    expect(unrelated).toHaveLength(scale);
    expect(view.signedIn).toBe(true);
    if (!view.signedIn) continue;
    expect(view.session.changes).toHaveLength(scale);
    expect(view.session.units).toHaveLength(scale);
    expect(paths.map((path) => path.split('?')[0]).sort()).toEqual(
      [
        `GET /v1/progressSessions/${progressId}`,
        `GET /v1/progressSessions/${progressId}/changes`,
        `GET /v1/progressSessions/${progressId}/completedUnits`,
      ].sort(),
    );
    expect(counts).toEqual(viewBound);
    expect(maxPending).toBe(3);

    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    pending = 0;
    maxPending = 0;
    paths.length = 0;
    recordedAdd = 0;
    const added = Array.from({ length: scale }, (_, index) => `batch-${scale}-${index}`);
    const recorded = await recordProgress(
      client,
      new Request('https://site.example.test/en/library/progress', {
        method: 'POST',
        headers: {
          cookie: `__Host-rezics_session=${sessionId}`,
          origin: 'https://site.example.test',
          'x-csrf-token': csrf,
        },
      }),
      env,
      { sessionId: progressId, revision: 1, idempotencyKey, add: added },
    );
    expect(recorded.ok).toBe(true);
    if (recorded.ok) expect(recorded.session.completedUnitCount).toBe(scale);
    expect(recordedAdd).toBe(scale);
    expect(paths.some((path) => unrelated.some((id) => path.includes(id)))).toBe(false);
    expect(counts).toEqual(recordBound);
    expect(maxPending).toBe(1);
  }
});
