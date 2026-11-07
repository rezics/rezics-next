import { expect, test } from 'bun:test';
import { startFakeStripe } from './support/fake-stripe.ts';

test('walk fixture pays a Checkout session and returns signed webhook bytes', async () => {
  const fake = startFakeStripe();
  try {
    const created = await fetch(`http://127.0.0.1:${fake.port}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'walk-fixture' },
      body: new URLSearchParams({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][product_data][name]': 'Walk edition',
        'line_items[0][price_data][product_data][tax_code]': 'txcd_10302000',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': '1200',
        success_url: 'https://example.test/orders/paid',
        cancel_url: 'https://example.test/orders/cancel',
        expires_at: String(Math.floor(Date.now() / 1000) + 3600),
        'payment_intent_data[metadata][order_id]': '00000000-0000-4000-8000-000000000001',
      }),
    });
    expect(created.ok).toBe(true);
    const session = (await created.json()) as { id: string };
    const paid = await fetch(`http://127.0.0.1:${fake.port}/walk/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    });
    expect(paid.status).toBe(204);
    const signed = await fetch(`http://127.0.0.1:${fake.port}/walk/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed', objectId: session.id }),
    });
    expect(signed.ok).toBe(true);
    const payload = (await signed.json()) as { bytes: string; headers: { 'stripe-signature': string } };
    expect(payload.bytes).toContain('checkout.session.completed');
    expect(payload.headers['stripe-signature']).toContain('t=');
  } finally {
    fake.stop();
  }
});
