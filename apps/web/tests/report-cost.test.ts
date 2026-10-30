import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import { submitReport, validateReport } from '../src/report/submit.server';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { newCsrfToken } from '../src/session/csrf';

const contentId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const cookieId = 'a'.repeat(43);
const csrf = newCsrfToken();
const draft = validateReport({
  target: { kind: 'post', id: contentId(1) },
  revisionId: contentId(2),
  reason: 'spam',
  evidence: 'Unsolicited advertising',
  botToken: 'test-proof',
  idempotencyKey: '10203040-5060-4070-8090-102030405060',
});

test('report submission keeps K/D/R/A fixed as stored reports and sessions grow', async () => {
  for (const size of [1, 10, 100]) {
    for (const signedIn of [true, false]) {
      const counts = { K: 0, D: 0, R: 0, A: 0 };
      const events: string[] = [];
      const heldReports = Array.from({ length: size }, (_, n) => ({ reportId: contentId(100 + n) }));
      const sessions = new Map(Array.from({ length: size }, (_, n) => [`session-${n}`, { subject: `reader-${n}` }]));
      sessions.set(cookieId, { subject: 'reader' });
      const stub = {
        async credential() {
          counts.D += 1;
          events.push('session');
          return {
            status: 'active',
            subject: sessions.get(cookieId)!.subject,
            accessToken: 'fresh-token',
            csrfToken: csrf,
          };
        },
        async signedIn() {
          counts.D += 1;
          return { signedIn: true, csrfToken: csrf };
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
      const sessionEnv = {
        AUTH_ISSUER: 'https://auth.test',
        API_RESOURCE: 'https://api.test',
        WEBSITE_SCOPES: 'openid',
        WEBSITE_CLIENT_ID: 'report-cost',
        WEBSITE_CLIENT_KEY: 'unused-with-fresh-token',
        SITE_ORIGINS: 'https://site.test',
        SESSIONS: {
          idFromName: (id: string) => id,
          get: (id: string) => {
            expect(sessions.has(id)).toBe(true);
            return stub;
          },
        } as unknown as DurableObjectNamespace<SessionStore>,
        MEDIA: Object.fromEntries(
          ['get', 'head', 'put', 'delete', 'list'].map((method) => [
            method,
            () => {
              counts.R += 1;
            },
          ]),
        ),
      } satisfies Partial<SessionEnv> & { MEDIA: unknown };
      const client = withPlatformClosedRecognition(
        createKernelClient('https://kernel.test', {
          fetch: (async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).origin === 'https://auth.test') counts.A += 1;
            else counts.K += 1;
            events.push(`${request.method} ${new URL(request.url).pathname}`);
            // A regression that enumerates history or sessions is recorded before failing here.
            expect(request.method).toBe('POST');
            expect(new URL(request.url).pathname).toBe('/v1/reports');
            expect(request.headers.get('authorization')).toBe(signedIn ? 'Bearer fresh-token' : null);
            expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(draft.idempotencyKey));
            const { idempotencyKey: _key, ...body } = draft;
            expect(await request.json()).toEqual(body);
            return Response.json(heldReports[0], { status: 201 });
          }) as typeof fetch,
        }),
      );
      const request = new Request('https://site.test/report', {
        method: 'POST',
        headers: {
          origin: 'https://site.test',
          'x-csrf-token': csrf,
          ...(signedIn ? { cookie: `__Host-rezics_session=${cookieId}` } : {}),
        },
      });
      expect(await submitReport(request, sessionEnv, draft, client)).toEqual({
        ok: true,
        reportId: heldReports[0]!.reportId,
      });
      expect(events).toEqual(signedIn ? ['session', 'POST /v1/reports'] : ['POST /v1/reports']);
      expect(counts).toEqual({ K: 1, D: signedIn ? 1 : 0, R: 0, A: 0 });
      expect(heldReports).toHaveLength(size);
      expect(sessions.size).toBe(size + 1);
    }
  }
});
