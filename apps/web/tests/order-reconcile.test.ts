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
