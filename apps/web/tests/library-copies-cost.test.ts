import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { loadCopiesPage, removeCopy, saveCopy, submitCopy } from '../src/library/copies-read.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sizes = [1, 10, 100];
const bound = { D: 1, K: 1, R: 0, A: 0 };
const sessionId = 'a'.repeat(43);
const csrf = newCsrfToken();
const copyId = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-0000000000bb';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const origin = 'https://site.example.test';

test('copies stay within their bound as the copy list grows', async () => {
  for (const scale of sizes) {
    const unrelated = Array.from({ length: scale }, (_, index) => `unrelated-${scale}-${index}`);
    for (const operation of ['view', 'filtered-view', 'create', 'update', 'delete'] as const) {
      const viewing = operation === 'view' || operation === 'filtered-view';
      const filtered = operation === 'filtered-view';
      const counts = { D: 0, K: 0, R: 0, A: 0 };
      let pending = 0;
      let maxPending = 0;
      const paths: string[] = [];
      const stub = {
        async signedIn() {
          counts.D += 1;
          return { signedIn: true, subject: 'alice', csrfToken: csrf };
        },
        async credential() {
          counts.D += 1;
          return { status: 'active' as const, subject: 'alice', accessToken: 'fresh-token', csrfToken: csrf };
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
        SITE_ORIGINS: origin,
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
      const client = withPlatformClosedRecognition(
        createKernelClient('https://kernel.example.test', {
          fetch: (async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === 'https://auth.example.test') {
              counts.A += 1;
              return new Response(null, { status: 404 });
            }
            counts.K += 1;
            pending += 1;
            maxPending = Math.max(maxPending, pending);
            paths.push(`${request.method} ${url.pathname}${url.search}`);
            try {
              expect(request.headers.get('authorization')).toBe('Bearer fresh-token');
              expect(unrelated.some((id) => url.pathname.includes(id) || url.search.includes(id))).toBe(false);
              if (viewing) {
                expect(request.method).toBe('GET');
                expect(url.pathname).toBe('/v1/copies');
                expect(url.searchParams.get('view')).toBe('FULL');
                expect(url.searchParams.get('limit')).toBe('100');
                expect(url.searchParams.get('subjectId')).toBe(filtered ? subjectId : null);
                return Response.json({
                  copies: Array.from({ length: scale }, (_, index) => ({
                    id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
                    subjectId: filtered ? subjectId : `subject-${index}`,
                    status: 'owned',
                    revision: 1,
                    location: 'Shelf',
                    source: 'Shop',
                    acquiredOn: '2030-01-01',
                    disposedOn: null,
                    note: `note-${index}`,
                    subject: { id: filtered ? subjectId : `subject-${index}`, type: 'book', label: `Label ${index}` },
                  })),
                  next: null,
                });
              }
              expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
              if (operation === 'create') {
                expect(request.method).toBe('POST');
                expect(url.pathname).toBe('/v1/copies');
                expect(await request.json()).toEqual({
                  subjectId,
                  status: 'owned',
                  location: 'Shelf',
                  source: 'Shop',
                  acquiredOn: '2030-01-01',
                  disposedOn: null,
                  note: 'Cost copy',
                });
                return Response.json(
                  {
                    copy: {
                      id: copyId,
                      subjectId,
                      status: 'owned',
                      revision: 1,
                      location: 'Shelf',
                      source: 'Shop',
                      acquiredOn: '2030-01-01',
                      disposedOn: null,
                      note: 'Cost copy',
                    },
                  },
                  { status: 201 },
                );
              }
              if (operation === 'update') {
                expect(request.method).toBe('PATCH');
                expect(url.pathname).toBe(`/v1/copies/${copyId}`);
                expect(await request.json()).toEqual({
                  revision: 3,
                  status: 'lent',
                  location: 'Friend',
                  source: null,
                  acquiredOn: null,
                  disposedOn: null,
                  note: 'Loan',
                });
                return Response.json({
                  copy: {
                    id: copyId,
                    subjectId,
                    status: 'lent',
                    revision: 4,
                    location: 'Friend',
                    source: null,
                    acquiredOn: null,
                    disposedOn: null,
                    note: 'Loan',
                  },
                });
              }
              expect(request.method).toBe('DELETE');
              expect(url.pathname).toBe(`/v1/copies/${copyId}`);
              expect(url.searchParams.get('revision')).toBe('3');
              return new Response(null, { status: 204 });
            } finally {
              pending -= 1;
            }
          }) as typeof fetch,
        }),
      );
      const request = new Request(`${origin}/en/library/copies${filtered ? `?subjectId=${subjectId}` : ''}`, {
        method: viewing ? 'GET' : 'POST',
        headers: {
          cookie: `__Host-rezics_session=${sessionId}`,
          ...(viewing ? {} : { origin, 'x-csrf-token': csrf }),
        },
      });
      if (viewing) {
        const page = await loadCopiesPage(client, request, env, filtered ? { subjectId } : {});
        expect(page.subjectId).toBe(filtered ? subjectId : null);
        expect(page.copies).toHaveLength(scale);
        expect(page.copies.some((copy) => 'subjectId' in copy)).toBe(false);
      } else if (operation === 'create') {
        const draft = {
          subjectId,
          idempotencyKey,
          status: 'owned',
          location: 'Shelf',
          source: 'Shop',
          acquiredOn: '2030-01-01',
          disposedOn: null,
          note: 'Cost copy',
        };
        for (const write of [submitCopy, saveCopy]) {
          for (const field of ['acquiredOn', 'disposedOn']) {
            for (const day of ['0000-01-01', '1900-02-29', '2030', '2030-01', '2030-01-01\n', '2030-01-01T00:00:00Z']) {
              expect(await write(client, request, env, { ...draft, id: copyId, revision: 3, [field]: day })).toEqual({
                ok: false,
                reason: 'invalid',
              });
            }
          }
        }
        expect(counts).toEqual({ D: 0, K: 0, R: 0, A: 0 });
        const created = await submitCopy(client, request, env, draft);
        expect(created).toMatchObject({ ok: true });
      } else if (operation === 'update') {
        const saved = await saveCopy(client, request, env, {
          id: copyId,
          revision: 3,
          idempotencyKey,
          status: 'lent',
          location: 'Friend',
          source: null,
          acquiredOn: null,
          disposedOn: null,
          note: 'Loan',
        });
        expect(saved).toMatchObject({ ok: true });
      } else {
        const removed = await removeCopy(client, request, env, { id: copyId, revision: 3, idempotencyKey });
        expect(removed).toEqual({ ok: true });
      }
      expect(unrelated).toHaveLength(scale);
      expect(paths).toHaveLength(1);
      expect(paths.some((path) => path.includes('/subjects/') || unrelated.some((id) => path.includes(id)))).toBe(
        false,
      );
      expect(counts).toEqual(bound);
      expect(maxPending).toBe(1);
    }
  }
});
