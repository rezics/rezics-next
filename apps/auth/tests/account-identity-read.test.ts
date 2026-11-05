import { afterEach, expect, spyOn, test } from 'bun:test';
import { loadAccountIdentity, type AccountIdentityResult } from '../src/account-identity';

const originalFetch = globalThis.fetch;
const accountId = '00000000-0000-4000-8000-000000000001';
const encoder = new TextEncoder();
const streamed = (chunks: Uint8Array[], headers: HeadersInit = {}, cancel?: () => void | Promise<void>, close = true) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (close) controller.close();
      },
      cancel,
    }),
    { status: 200, headers },
  );
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const identity = (id: string, email: string | null): AccountIdentityResult => ({ kind: 'ready', accountId: id, email });

test('the admitted identity read keeps its closed result states and same-origin request', async () => {
  const replies = [
    new Response(JSON.stringify({ account_id: accountId, email: 'person@example.test' }), { status: 200 }),
    new Response(JSON.stringify({ account_id: accountId, email: null }), { status: 200 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 403 }),
    new Response(null, { status: 503 }),
    new Response(JSON.stringify({ account_id: accountId, email: null, extra: true }), { status: 200 }),
    new Response(JSON.stringify({ account_id: accountId, email: 'a'.repeat(255) }), { status: 200 }),
    new Response('{', { status: 200 }),
    new Response(new Uint8Array([0xff]), { status: 200 }),
  ];
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init });
    return replies.shift()!;
  }) as typeof fetch;
  const results = [];
  for (let index = 0; index < 9; index++) results.push(await loadAccountIdentity(new AbortController().signal));
  expect(results).toEqual([
    identity(accountId, 'person@example.test'),
    identity(accountId, null),
    { kind: 'signed-out' },
    { kind: 'denied' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
  ]);
  expect(requests).toHaveLength(9);
  expect(String(requests[0]!.input)).toBe('/account-identity');
  expect(requests.every(({ init }) => init?.method === 'POST' && init.credentials === 'same-origin')).toBe(true);
  expect(requests.every(({ init }) => init?.cache === 'no-store' && init.redirect === 'error' && init.body === '{}')).toBe(true);
});

test('the contract maximum and a UTF-8 code point split across chunks remain ready', async () => {
  const maximumEmail = `\u000e@\u000e.${'\u000e'.repeat(250)}`;
  const maximumBytes = encoder.encode(JSON.stringify({ account_id: accountId, email: maximumEmail }));
  expect(maximumEmail.length).toBe(254);
  expect(maximumBytes.byteLength).toBe(1578);
  const multibyteEmail = 'person@exämple.test';
  const multibyteBytes = encoder.encode(JSON.stringify({ account_id: accountId, email: multibyteEmail }));
  const split = multibyteBytes.indexOf(0xc3) + 1;
  const replies = [
    streamed([maximumBytes], { 'content-length': String(maximumBytes.byteLength) }),
    streamed([multibyteBytes.slice(0, split), multibyteBytes.slice(split, split + 1), multibyteBytes.slice(split + 1)]),
  ];
  globalThis.fetch = (async () => replies.shift()!) as typeof fetch;
  expect(await loadAccountIdentity(new AbortController().signal)).toEqual(identity(accountId, maximumEmail));
  expect(await loadAccountIdentity(new AbortController().signal)).toEqual(identity(accountId, multibyteEmail));
});

test('missing bodies and byte overflow are unavailable; excess cancels without waiting or retrying', async () => {
  const maximumEmail = `\u000e@\u000e.${'\u000e'.repeat(250)}`;
  const maximumBytes = encoder.encode(JSON.stringify({ account_id: accountId, email: maximumEmail }));
  const over = new Uint8Array(maximumBytes.byteLength + 1);
  over.set(maximumBytes);
  over[over.length - 1] = 32;
  let cancellations = 0;
  const neverCancel = () => {
    cancellations++;
    return new Promise<void>(() => {});
  };
  const announced = streamed([], { 'content-length': String(over.byteLength) }, neverCancel, false);
  const single = streamed([over], {}, neverCancel, false);
  const dishonest = streamed(
    [over.slice(0, maximumBytes.byteLength), over.slice(maximumBytes.byteLength)],
    { 'content-length': '1' },
    neverCancel,
    false,
  );
  const replies = [new Response(null, { status: 200 }), announced, single, dishonest];
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return replies.shift()!;
  }) as typeof fetch;
  for (let index = 0; index < 4; index++)
    expect(await loadAccountIdentity(new AbortController().signal)).toEqual({ kind: 'unavailable' });
  expect(requests).toBe(4);
  expect(cancellations).toBe(3);
  expect([announced, single, dishonest].every((response) => !response.body?.locked)).toBe(true);
});

for (const phase of ['headers', 'body'] as const)
  test(`production identity settles ignored abort at ${phase} without renewing its deadline`, async () => {
    const headers = Promise.withResolvers<Response>();
    let effective: AbortSignal | undefined;
    let responseCancelled = false;
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(((_input, init) => {
      effective = init?.signal ?? undefined;
      return headers.promise;
    }) as typeof fetch);
    const timer = spyOn(globalThis, 'setTimeout');
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          responseCancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    try {
      const caller = new AbortController();
      caller.abort();
      expect(await loadAccountIdentity(caller.signal)).toEqual({ kind: 'unavailable' });
      expect(fetcher).not.toHaveBeenCalled();
      timer.mockClear();
      const pending = loadAccountIdentity(new AbortController().signal);
      await Promise.resolve();
      if (phase === 'body') headers.resolve(response);
      await Promise.resolve();
      expect(response.body?.locked).toBe(phase === 'body');
      expect(timer).toHaveBeenCalledTimes(1);
      expect(timer.mock.calls[0]![1]).toBe(5000);
      (timer.mock.calls[0]![0] as () => void)();
      expect(await pending).toEqual({ kind: 'unavailable' });
      expect(effective?.aborted).toBe(true);
      expect(responseCancelled).toBe(phase === 'body');
      expect(response.body?.locked).toBe(false);
      if (phase === 'headers') headers.resolve(response);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
      fetcher.mockRestore();
    }
  });
