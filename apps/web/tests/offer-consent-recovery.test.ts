import { expect, mock, spyOn, test } from 'bun:test';
import { createOfferRequest } from '../src/checkout/offer-recovery';

mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
const { startCheckout } = await import('../src/checkout/start');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const intent = { offerId: id(1), expectedOfferRevision: 7, idempotencyKey: id(2) };
const order: { id: string; offerId: string; settlement: string; checkoutUrl: string | null } = {
  id: id(3),
  offerId: id(1),
  settlement: 'pending',
  checkoutUrl: 'https://checkout.stripe.com/current',
};

test('uncertain creation resolves to the authoritative order or hosted Checkout using only the original intent as history grows', async () => {
  const fetcher = spyOn(globalThis, 'fetch');
  try {
    for (const size of [1, 8, 64])
      for (const state of ['pending', 'paid', 'failed', 'unknown', 'no-session']) {
        const records = new Map(Array.from({ length: size }, (_, n) => [id(100 + n), { ...order, id: id(100 + n) }]));
        records.set(order.id, {
          ...order,
          settlement: state === 'no-session' ? 'pending' : state,
          checkoutUrl: state === 'no-session' ? null : order.checkoutUrl,
        });
        const calls: Request[] = [];
        fetcher.mockImplementation(async (input, init) => {
          const call = new Request(input, init);
          calls.push(call.clone());
          expect(new URL(call.url).pathname).toBe('/v1/orders');
          if (calls.length === 1) throw new Error('Response lost after creation');
          return Response.json({ order: records.get(order.id) });
        });
        const submit = createOfferRequest(intent, (input) =>
          startCheckout(
            new Request('https://site.test/checkout', {
              method: 'POST',
              headers: { authorization: 'Bearer current-buyer', 'content-type': 'application/json' },
              body: JSON.stringify(input),
            }),
            {},
          ),
        );
        expect(await submit()).toEqual({ kind: 'retry' });
        const expected =
          state === 'pending' ? { kind: 'checkout', url: order.checkoutUrl } : { kind: 'order', orderId: order.id };
        expect(await submit()).toEqual(expected);
        expect(await submit()).toEqual(expected);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
          expect(call.headers.get('authorization')).toBe('Bearer current-buyer');
          expect(call.headers.get('idempotency-key')).toBe(intent.idempotencyKey);
          expect(await call.json()).toEqual({ offerId: intent.offerId, expectedOfferRevision: 7 });
        }
      }
  } finally {
    fetcher.mockRestore();
  }
});
