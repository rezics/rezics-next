import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { loadRoutePage } from '../src/features/pages/route.tsx';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { homeContinueQuery, loadContinue } from '../src/library/continue-read.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const sizes = [1, 10, 100];
const stamp = '2026-04-02T15:04:05.000Z';
const csrf = newCsrfToken();

test('the public page query and browser Continue query keep their separate read bounds', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  const reads: URL[] = [];
  const progress: URL[] = [];
  const paths: string[] = [];
  const pages = createFakeKernelFetch(fixtures as never);
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/auth/')) {
        counts.A += 1;
        return new Response(null, { status: 404 });
      }
      counts.K += 1;
      paths.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/v1/libraryEntries' && request.method === 'GET') {
        reads.push(url);
        expect(request.headers.get('authorization')).toBe('Bearer fresh-token');
        const limit = Number(url.searchParams.get('limit') ?? 20);
        return Response.json({
          libraryEntries: Array.from({ length: Math.min(size, limit) }, (_, index) => ({
            subjectId: `subject-${index}`,
            state: 'in_progress',
            revision: 1,
            createdAt: stamp,
            updatedAt: stamp,
            subject: {
              id: `subject-${index}`,
              type: 'book',
              label: `Label ${index}`,
            },
          })),
          next: null,
        });
      }
      if (url.pathname.startsWith('/v1/libraryEntries/')) throw new Error(`unexpected per-entry read ${url.pathname}`);
      if (url.pathname === '/v1/progressSessions') {
        progress.push(url);
        return Response.json({ progressSessions: [], next: null });
      }
      return pages(request);
    }) as typeof fetch,
  });
  const stub = {
    async signedIn() {
      counts.D += 1;
      return { signedIn: true, subject: 'reader', csrfToken: csrf };
    },
    async credential() {
      counts.D += 1;
      return {
        status: 'active' as const,
        subject: 'reader',
        accessToken: 'fresh-token',
        csrfToken: csrf,
      };
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
    idFromName: (name: string) => name,
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
  const reset = () => {
    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    reads.length = 0;
    progress.length = 0;
    paths.length = 0;
  };

  for (const scale of sizes) {
    size = scale;
    reset();
    const page = await loadRoutePage(client, '/');
    expect(page.kind).toBe('page');
    expect(paths).toEqual(['POST /v1/pages:read']);
    expect(counts).toEqual({ D: 0, K: 1, R: 0, A: 0 });

    reset();
    const signedInRequest = new Request('https://site.example.test/en', {
      headers: { cookie: `__Host-rezics_session=${sessionId}` },
    });
    const query = homeContinueQuery('en', () => loadContinue(client, signedInRequest, env));
    const resume = await new QueryClient().fetchQuery(query);
    expect(resume).toHaveLength(Math.min(scale, 6));
    expect(reads).toHaveLength(1);
    expect(progress).toHaveLength(Math.min(scale, 6));
    expect(Number(reads[0]!.searchParams.get('limit'))).toBeGreaterThan(0);
    expect(Number(reads[0]!.searchParams.get('limit'))).toBeLessThanOrEqual(6);
    expect(reads[0]!.searchParams.get('state')).toBe('in_progress');
    expect(paths.filter((path) => path === 'POST /v1/pages:read')).toHaveLength(0);
    expect(counts).toEqual({ D: 1, K: 1 + Math.min(scale, 6), R: 0, A: 0 });

    reset();
    const signedOutPage = await loadRoutePage(client, '/');
    expect(signedOutPage.kind).toBe('page');
    expect(paths).toEqual(['POST /v1/pages:read']);
    expect(counts).toEqual({ D: 0, K: 1, R: 0, A: 0 });

    reset();
    const signedOutQuery = homeContinueQuery('en', () =>
      loadContinue(client, new Request('https://site.example.test/en'), env),
    );
    expect(await new QueryClient().fetchQuery(signedOutQuery)).toEqual([]);
    expect(reads).toHaveLength(0);
    expect(counts).toEqual({ D: 0, K: 0, R: 0, A: 0 });
  }
});
