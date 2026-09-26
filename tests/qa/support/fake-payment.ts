import { signProviderCallback } from '../../../services/main/src/modules/commerce/store.ts';

type Status = 'pending' | 'succeeded' | 'failed';

/**
 * In-stack fake payment provider on a loopback HTTP port. It records payments
 * by the caller's reference, can lose a create response after recording it,
 * can become unavailable, and signs callbacks exactly as the provider profile
 * requires. No live provider or credential is involved.
 */
export function startFakePaymentProvider(secret: string) {
  const payments = new Map<string, { amountMinor: string; currency: string; status: Status }>();
  let mode: 'normal' | 'lose-response' | 'unavailable' = 'normal';
  let creates = 0;
  let eventCount = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (mode === 'unavailable') return new Response('unavailable', { status: 503 });
      if (request.method === 'POST' && url.pathname === '/payments') {
        creates++;
        const body = await request.json() as { reference: string; amountMinor: string; currency: string };
        const existing = payments.get(body.reference);
        if (existing && (existing.amountMinor !== body.amountMinor || existing.currency !== body.currency)) {
          return new Response('reference conflict', { status: 409 });
        }
        if (!existing) payments.set(body.reference, { amountMinor: body.amountMinor, currency: body.currency, status: 'pending' });
        // The payment exists, but the caller never learns it.
        if (mode === 'lose-response') return new Response('gateway timeout', { status: 504 });
        return Response.json({ reference: body.reference, status: 'pending' }, { status: 201 });
      }
      const match = /^\/payments\/(.+)$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const payment = payments.get(decodeURIComponent(match[1]!));
        return payment ? Response.json({ status: payment.status }) : new Response('missing', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get creates() { return creates; },
    payment: (reference: string) => payments.get(reference),
    setMode(next: typeof mode) { mode = next; },
    /** Settle a payment at the provider and return its signed callback delivery. */
    settle(reference: string, status: 'succeeded' | 'failed') {
      const payment = payments.get(reference);
      if (!payment) throw new Error(`fake provider has no payment ${reference}`);
      payment.status = status;
      return this.callback(reference, status === 'succeeded' ? 'payment.succeeded' : 'payment.failed');
    },
    callback(reference: string, kind: string, eventId = `evt-${++eventCount}-${reference}`) {
      const body = JSON.stringify({ provider: 'fake', eventId, reference, kind });
      return { body, signature: signProviderCallback(secret, body), eventId };
    },
    stop: () => server.stop(true),
  };
}
