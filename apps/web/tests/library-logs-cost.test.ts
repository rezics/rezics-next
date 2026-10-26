import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import {
  deletePublishedLog,
  loadMyPublishedLogs,
  loadPublishedLog,
  publishProgressLog,
} from '../src/library/logs-read.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const csrf = newCsrfToken();
const sizes = [1, 10, 100];
const logId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const progressId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const stamp = '2026-04-02T15:04:05.000Z';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const fullLog = {
  id: logId,
  accountId: 'owner',
  subjectId,
  sessionState: 'active',
  startedAt: stamp,
  completedAt: null,
  note: 'A snapshot',
  publishedAt: stamp,
  subject: { id: subjectId, type: 'book', label: 'Cost subject' },
  account: { id: 'owner', handle: '@owner', displayName: 'Owner' },
};

test('published log reads and writes stay within their bound as an account log list grows', async () => {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  let size = 1;
  const paths: string[] = [];
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
        if (request.method === 'GET' && url.pathname === `/v1/publishedLogs/${logId}`) {
          expect([null, 'Bearer access-cost']).toContain(request.headers.get('authorization'));
        } else expect(request.headers.get('authorization')).toBe('Bearer access-cost');
        if (url.pathname === `/v1/publishedLogs/${logId}` && request.method === 'GET') {
          expect(url.searchParams.get('view')).toBe('FULL');
          return Response.json({ publishedLog: fullLog });
        }
        if (url.pathname === '/v1/publishedLogs' && request.method === 'GET') {
          expect(url.searchParams.get('view')).toBe('FULL');
          expect(url.searchParams.get('limit')).toBe('100');
          expect(url.searchParams.get('cursor')).toBeNull();
          expect(url.searchParams.get('accountId')).toBe('owner');
          return Response.json({
            publishedLogs: Array.from({ length: size }, (_, index) => ({
              ...fullLog,
              id: `log-${index}`,
              publishedAt: new Date(Date.parse(stamp) + index * 1000).toISOString(),
            })),
            next: null,
          });
        }
        if (url.pathname === '/v1/publishedLogs' && request.method === 'POST') {
          expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
          expect(await request.json()).toEqual({ sessionId: progressId, note: 'Cost note' });
          return Response.json({ publishedLog: { ...fullLog, id: logId } }, { status: 201 });
        }
        if (url.pathname === `/v1/publishedLogs/${logId}` && request.method === 'DELETE') {
          expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
          return Response.json({ publishedLog: fullLog });
        }
        throw new Error(`unexpected kernel call ${request.method} ${url.pathname}`);
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
  const resetCounts = () => {
    counts.D = 0;
    counts.K = 0;
    counts.R = 0;
    counts.A = 0;
    paths.length = 0;
  };
  const signedInRequest = (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET') =>
    new Request(`https://site.example.test${path}`, {
      method,
      headers: {
        cookie: `__Host-rezics_session=${sessionId}`,
        ...(method === 'GET' ? {} : { origin: 'https://site.example.test', 'x-csrf-token': csrf }),
      },
    });

  for (const scale of sizes) {
    size = scale;

    resetCounts();
    const publicLog = await loadPublishedLog(client, new Request(`https://site.example.test/en/logs/${logId}`), env, {
      id: logId,
    });
    expect(publicLog.log.subject?.label).toBe('Cost subject');
    expect(publicLog.isOwner).toBe(false);
    expect(counts).toEqual({ D: 0, K: 1, R: 0, A: 0 });
    expect(paths).toEqual([`GET /v1/publishedLogs/${logId}?view=FULL`]);

    resetCounts();
    const ownerLog = await loadPublishedLog(client, signedInRequest(`/en/logs/${logId}`), env, { id: logId });
    expect(ownerLog.isOwner).toBe(true);
    expect(counts).toEqual({ D: 1, K: 1, R: 0, A: 0 });
    expect(paths).toEqual([`GET /v1/publishedLogs/${logId}?view=FULL`]);

    resetCounts();
    const list = await loadMyPublishedLogs(client, signedInRequest('/en/library/progress'), env, {});
    expect(list.signedIn).toBe(true);
    expect(list.logs).toHaveLength(scale);
    expect(counts).toEqual({ D: 1, K: 1, R: 0, A: 0 });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('GET /v1/publishedLogs?');

    resetCounts();
    const published = await publishProgressLog(client, signedInRequest('/en/library/progress', 'POST'), env, {
      sessionId: progressId,
      note: 'Cost note',
      idempotencyKey,
    });
    expect(published).toEqual({ ok: true, id: logId });
    expect(counts).toEqual({ D: 1, K: 1, R: 0, A: 0 });
    expect(paths).toEqual(['POST /v1/publishedLogs']);

    resetCounts();
    const deleted = await deletePublishedLog(client, signedInRequest(`/en/logs/${logId}`, 'DELETE'), env, {
      id: logId,
      idempotencyKey,
    });
    expect(deleted).toEqual({ ok: true, id: logId });
    expect(counts).toEqual({ D: 1, K: 1, R: 0, A: 0 });
    expect(paths).toEqual([`DELETE /v1/publishedLogs/${logId}`]);
  }
});
