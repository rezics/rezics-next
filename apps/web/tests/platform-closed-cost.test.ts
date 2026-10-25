import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadRoutePage } from '../src/features/pages/route.tsx';
import { isPlatformClosedError, withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { readSessionIdentity } from '../src/session/state.ts';
import type { SessionEnv } from '../src/session/client.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionId = 'a'.repeat(43);
const sizes = [1, 10, 100];
const bound = { K: 1, D: 1, R: 0, A: 0 };

function problem() {
  return {
    type: 'https://rezics.com/problems/platform_closed',
    title: 'platform_closed',
    status: 403,
    code: 'platform_closed',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'platform-closed-cost',
  };
}

test('closed page reads keep K/D/R/A fixed as existing page data grows', async () => {
  for (const size of sizes) {
    const existingEntries = Array.from({ length: size }, (_, index) => `entry-${index}`);
    const counts = { K: 0, D: 0, R: 0, A: 0 };
    const stub = {
      async signedIn() {
        counts.D += 1;
        return { signedIn: true, subject: 'person', csrfToken: null };
      },
    };
    const sessions = {
      idFromName: (_id: string) => _id,
      get: (_id: unknown) => stub,
    } as unknown as DurableObjectNamespace<SessionStore>;
    const env = {
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'rezics-web-cost',
      WEBSITE_CLIENT_KEY: 'unused-by-this-read',
      SESSIONS: sessions,
    } as Partial<SessionEnv>;
    const request = new Request('https://site.example.test/en/', {
      headers: { cookie: `__Host-rezics_session=${sessionId}` },
    });
    const identity = await readSessionIdentity(request, env);
    expect(identity.state).toBe('signed-in');

    const client = withPlatformClosedRecognition(
      createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          counts.K += 1;
          expect(existingEntries).toHaveLength(size);
          const upstream = new Request(input, init);
          expect(new URL(upstream.url).pathname).toBe('/v1/pages:read');
          return Response.json(problem(), {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          });
        }) as typeof fetch,
      }),
    );
    let closed = false;
    try {
      await loadRoutePage(client, '/');
    } catch (error) {
      closed = isPlatformClosedError(error);
    }
    expect(closed).toBe(true);
    expect(counts).toEqual(bound);
  }
});
