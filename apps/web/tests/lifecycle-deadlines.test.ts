import { afterAll, expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { commandLifecycle, loadLifecycle, parseIntent } from '../src/accounts/lifecycle-controls/data';
import { commandRequest, reviewRequest } from '../src/accounts/lifecycle-controls/request';

const schedule = globalThis.setTimeout;
const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
  schedule(fn, ms === 10_000 || ms === 35_000 ? 5 : ms, ...args)) as typeof setTimeout);
afterAll(() => timer.mockRestore());
const account = { id: '01a1a000-0000-7000-8000-000000000101', kind: 'actor', displayName: 'Reader', handle: null };
const intent = parseIntent({ accountId: account.id, action: 'suspend', key: crypto.randomUUID(), reason: ' exact ' });
const review = () =>
  Response.json({
    account,
    current: { state: 'active', minimumAuthnEpoch: '1', fenced: false },
    actions: [{ action: 'account:suspend', operationId: 'account.suspend' }],
    original: { status: 'unknown' },
  });
const stalled = (body: boolean): Promise<Response> =>
  body
    ? Promise.resolve(new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }))
    : new Promise(() => {});

for (const body of [false, true])
  for (const phase of ['review', 'dispatch', 'readback', 'recorded'] as const) {
    test(`lifecycle releases stalled ${body ? 'body' : 'headers'} during ${phase}`, async () => {
      const requests: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const read = request.url.endsWith('/lifecycleReview');
          expect(request.headers.get('authorization')).toBe('Bearer operator');
          if (read) {
            if (phase === 'review' || requests.length > 1) return stalled(body);
            expect(await request.json()).toEqual({
              original: { operationId: 'account.suspend', key: intent.key, reason: intent.reason },
            });
            return review();
          }
          expect(request.headers.get('idempotency-key')).toBe(intent.key);
          expect(await request.json()).toEqual({ reason: intent.reason });
          if (phase === 'dispatch') return stalled(body);
          if (phase === 'readback') throw Error('response lost after possible commit');
          return Response.json({
            suspension: { accountId: account.id, state: 'suspended', minimumAuthnEpoch: '2', receiptId: account.id },
          });
        }) as typeof fetch,
      });
      const outcome =
        phase === 'review'
          ? await loadLifecycle(client, 'Bearer operator', account.id)
          : await commandLifecycle(client, 'Bearer operator', intent);
      expect(outcome.status).toBe(phase === 'review' ? 'unavailable' : phase === 'recorded' ? 'recorded' : 'uncertain');
      expect(requests.filter((request) => !request.url.endsWith('/lifecycleReview'))).toHaveLength(
        phase === 'review' ? 0 : 1,
      );
      expect(requests.at(-1)!.signal.aborted).toBe(true);
    });
  }

test('caller cancellation releases review and command envelopes without claiming non-application', async () => {
  const caller = new AbortController();
  let nativeSignal!: AbortSignal;
  const pending = commandRequest((signal) => {
    nativeSignal = signal;
    return new Promise(() => {});
  }, caller.signal);
  caller.abort();
  expect((await pending).status).toBe('uncertain');
  expect(nativeSignal.aborted).toBe(true);
  let called = false;
  expect(
    (
      await reviewRequest(async () => {
        called = true;
        return { status: 'missing' };
      }, caller.signal)
    ).status,
  ).toBe('unavailable');
  expect(called).toBe(false);
});
