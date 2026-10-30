import { expect, test } from 'bun:test';
import {
  createReconciliationRequest,
  nativeOrderReconcile,
  type ReconciliationIntent,
} from '../src/checkout/order-reconcile';

const orderId = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const key = '019a1b2c-3d4e-7f00-8a00-5b0000000062';

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
