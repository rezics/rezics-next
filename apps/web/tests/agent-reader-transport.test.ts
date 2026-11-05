import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { loadSettingsPage } from '../src/settings/preferences';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

test('Agent preference transport stops after preparation retirement and forwards cancellation to native GET', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const nativeStarted = deferred<void>();
  let delayPreparation = true;
  const accountId = 'reader-a';
  const sessionId = 'a'.repeat(43);
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          if (delayPreparation) {
            delayPreparation = false;
            entered.resolve(undefined);
            await release.promise;
          }
          return { status: 'active' as const, subject: accountId, accessToken: 'reader-token', csrfToken: null };
        },
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const nativeReads: Array<{ signal?: AbortSignal; work: Deferred<never> }> = [];
  const client = {
    accounts: () => ({
      preferences: {
        get: (options?: { fetch?: { signal?: AbortSignal } }) => {
          const work = deferred<never>();
          nativeReads.push({ signal: options?.fetch?.signal, work });
          nativeStarted.resolve(undefined);
          return work.promise;
        },
      },
    }),
  } as unknown as KernelClient;
  const requestFor = (signal: AbortSignal) =>
    new Request('https://rezics.test/en/_server/agent-reader', {
      headers: { cookie: `__Host-rezics_session=${sessionId}` },
      signal,
    });

  const abandonedController = new AbortController();
  const abandonedRequest = requestFor(abandonedController.signal);
  const abandonedRead = loadSettingsPage(client, abandonedRequest, sessionEnv, { signal: abandonedRequest.signal });
  await entered.promise;
  abandonedController.abort();
  release.resolve(undefined);
  await expect(abandonedRead).rejects.toMatchObject({ name: 'AbortError' });
  expect(nativeReads).toHaveLength(0);

  const currentController = new AbortController();
  const currentRequest = requestFor(currentController.signal);
  const currentRead = loadSettingsPage(client, currentRequest, sessionEnv, { signal: currentRequest.signal });
  await nativeStarted.promise;
  expect(nativeReads[0]?.signal).toBe(currentRequest.signal);
  currentController.abort();
  nativeReads[0]!.work.resolve(undefined as never);
  await expect(currentRead).rejects.toMatchObject({ name: 'AbortError' });
});
