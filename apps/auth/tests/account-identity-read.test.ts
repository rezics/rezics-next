import { afterEach, expect, spyOn, test } from 'bun:test';
import { loadAccountIdentity, type AccountIdentityResult } from '../src/account-identity';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const identity = (accountId: string, email: string | null): AccountIdentityResult => ({ kind: 'ready', accountId, email });

test('the admitted identity read keeps its closed result states and same-origin request', async () => {
  const replies = [
    new Response(JSON.stringify({ account_id: 'own-account', email: 'person@example.test' }), { status: 200 }),
    new Response(JSON.stringify({ account_id: 'own-account', email: null }), { status: 200 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 403 }),
    new Response(null, { status: 503 }),
    new Response(JSON.stringify({ account_id: 'own-account', email: null, extra: true }), { status: 200 }),
    new Response('{', { status: 200 }),
  ];
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init });
    return replies.shift()!;
  }) as typeof fetch;

  const results = [];
  for (let index = 0; index < 7; index++) results.push(await loadAccountIdentity(new AbortController().signal));
  expect(results).toEqual([
    identity('own-account', 'person@example.test'),
    identity('own-account', null),
    { kind: 'signed-out' },
    { kind: 'denied' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
  ]);
  expect(requests).toHaveLength(7);
  expect(String(requests[0]!.input)).toBe('/account-identity');
  expect(requests.every(({ init }) => init?.method === 'POST' && init.credentials === 'same-origin')).toBe(true);
  expect(
    requests.every(({ init }) => init?.cache === 'no-store' && init.redirect === 'error' && init.body === '{}'),
  ).toBe(true);
});

for (const phase of ['headers', 'body'] as const)
  test(`production identity settles ignored abort at ${phase} without renewing its deadline`, async () => {
    const headers = Promise.withResolvers<Response>();
    const body = Promise.withResolvers<unknown>();
    let effective: AbortSignal | undefined;
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(((_input, init) => {
      effective = init?.signal ?? undefined;
      return headers.promise;
    }) as typeof fetch);
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      const caller = new AbortController();
      caller.abort();
      expect(await loadAccountIdentity(caller.signal)).toEqual({ kind: 'unavailable' });
      expect(fetcher).not.toHaveBeenCalled();
      timer.mockClear();
      const pending = loadAccountIdentity(new AbortController().signal);
      await Promise.resolve();
      const response = new Response();
      response.json = () => body.promise;
      if (phase === 'body') headers.resolve(response);
      await Promise.resolve();
      expect(timer).toHaveBeenCalledTimes(1);
      expect(timer.mock.calls[0]![1]).toBe(5000);
      (timer.mock.calls[0]![0] as () => void)();
      expect(await pending).toEqual({ kind: 'unavailable' });
      expect(effective?.aborted).toBe(true);
      headers.resolve(response);
      body.resolve({ account_id: 'retired', email: 'retired@example.test' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
      fetcher.mockRestore();
    }
  });
