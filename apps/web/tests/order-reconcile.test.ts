import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createReconciliationRequest,
  nativeOrderReconcile,
  type ReconciliationIntent,
} from '../src/checkout/order-reconcile';

const orderId = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const key = '019a1b2c-3d4e-7f00-8a00-5b0000000062';

test('native reconciliation uses the generated route and accepts only the exact 202 receipt', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ orderId, reconciliation: 'queued' }, { status: 202 });
    },
  });
  expect(await nativeOrderReconcile(client, 'Bearer buyer', { orderId, idempotencyKey: key })).toEqual({
    kind: 'queued',
    orderId,
    reconciliation: 'queued',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe(`https://kernel.test/v1/orders/${orderId}:reconcile`);
  expect(requests[0]!.method).toBe('POST');
  expect(await requests[0]!.json()).toEqual({});
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer buyer');
  expect(requests[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(key));
});

test('native denial, conflict, unavailable and lost responses retain their controller outcomes', async () => {
  for (const [status, expected] of [
    [401, { kind: 'denied' }],
    [403, { kind: 'denied' }],
    [404, { kind: 'denied' }],
    [422, { kind: 'conflict' }],
    [503, { kind: 'unavailable' }],
    [200, { kind: 'unavailable' }],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: async () =>
        Response.json(
          status === 503
            ? { status: 503, code: 'unavailable', request_id: 'request-1' }
            : { orderId, reconciliation: 'queued' },
          { status },
        ),
    });
    expect(await nativeOrderReconcile(client, 'Bearer buyer', { orderId, idempotencyKey: key })).toEqual(expected);
  }

  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      if (requests.length === 1) throw new Error('Response lost after native effect');
      return Response.json({ orderId, reconciliation: 'queued' }, { status: 202 });
    },
  });
  const request = createReconciliationRequest(
    orderId,
    (intent) => nativeOrderReconcile(client, 'Bearer buyer', intent),
    () => key,
  );
  expect(await request()).toEqual({ kind: 'retry' });
  expect(await request()).toEqual({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(requests).toHaveLength(2);
  expect(requests.map((sent) => sent.url)).toEqual([
    `https://kernel.test/v1/orders/${orderId}:reconcile`,
    `https://kernel.test/v1/orders/${orderId}:reconcile`,
  ]);
  expect(requests.map((sent) => sent.headers.get('idempotency-key'))).toEqual([
    JSON.stringify(key),
    JSON.stringify(key),
  ]);
});

test('status reconciliation starts only on explicit action and retains its distinct key after a timeout', async () => {
  const calls: ReconciliationIntent[] = [];
  const request = createReconciliationRequest(
    orderId,
    async (intent) => {
      calls.push(intent);
      if (calls.length === 1) throw new Error('Response lost');
      return { kind: 'queued', orderId, reconciliation: 'queued' };
    },
    () => key,
  );
  expect(calls).toHaveLength(0);
  expect(await request()).toEqual({ kind: 'retry' });
  expect(await request()).toEqual({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(calls).toEqual([
    { orderId, idempotencyKey: key },
    { orderId, idempotencyKey: key },
  ]);
  expect(await request()).toEqual({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(calls).toHaveLength(2);
});

test('unavailable or denied reconciliation never manufactures payment or a successful queued result', async () => {
  const request = createReconciliationRequest(
    orderId,
    async () => ({ kind: 'unavailable' }),
    () => key,
  );
  expect(await request()).toEqual({ kind: 'unavailable' });
  const denied = createReconciliationRequest(
    orderId,
    async () => ({ kind: 'denied' }),
    () => key,
  );
  expect(await denied()).toEqual({ kind: 'denied' });
  const foreign = createReconciliationRequest(
    orderId,
    async () => ({
      kind: 'queued',
      orderId: key,
      reconciliation: 'queued',
    }),
    () => key,
  );
  expect(await foreign()).toEqual({ kind: 'unavailable' });
  // The pending generated-client binding performs no guessed transport.
  expect(typeof nativeOrderReconcile).toBe('function');
});

test('retired reconciliation replies retain uncertainty and the original key without accepting a late enqueue', async () => {
  let current = false;
  let finish!: (result: { kind: 'queued'; orderId: string; reconciliation: 'queued' }) => void;
  let keys = 0;
  const calls: ReconciliationIntent[] = [];
  const request = createReconciliationRequest(
    orderId,
    async (intent) => {
      calls.push(intent);
      if (calls.length === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return { kind: 'queued', orderId, reconciliation: 'queued' };
    },
    () => {
      keys++;
      return key;
    },
  );
  expect(await request(() => current)).toEqual({ kind: 'retry' });
  expect(keys).toBe(0);
  expect(calls).toHaveLength(0);
  current = true;
  const pending = request(() => current);
  expect(await request(() => current)).toBeUndefined();
  current = false;
  finish({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(await pending).toEqual({ kind: 'retry' });
  current = true;
  expect(await request(() => current)).toEqual({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(await request(() => current)).toEqual({ kind: 'queued', orderId, reconciliation: 'queued' });
  expect(calls).toEqual([
    { orderId, idempotencyKey: key },
    { orderId, idempotencyKey: key },
  ]);
  expect(calls[0]).toBe(calls[1]);
  expect(Object.isFrozen(calls[0])).toBe(true);
  expect(keys).toBe(1);
});
