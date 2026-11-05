import { expect, test } from 'bun:test';
import { createCheckoutForOrder } from '../../src/commerce/creation-attempt.ts';
import type { createCommerceCommands } from '../../src/commerce/commands.ts';
import { STRIPE_API_VERSION, type CheckoutRequest } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { readCommerceMoneyPolicy, validateOfferAmount } from '../../src/commerce/money.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

// This boundary test exercises actual SDK serialization and the shared first-attempt retry port.
// Native Content admission remains independently required by the real commands.
test('new tax is explicit; retrying an existing historical physical attempt preserves omission and original parameters', async () => {
  const fake = startFakeStripe();
  const stripe = createStripePort({
    apiKey: 'sk_test_units',
    managedPayments: true,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
  const request: CheckoutRequest = {
    orderId: 'order-old',
    buyerAccountId: 'buyer-old',
    title: 'Original price',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    successUrl: 'https://old.test/success',
    cancelUrl: 'https://old.test/cancel',
    managedPayments: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  let admitted = 0;
  const commands = {
    async beginCheckoutCreation() {
      return {
        kind: 'ready',
        first: false,
        observedAt: new Date().toISOString(),
        attempt: {
          firstAttemptId: 'original-attempt',
          firstAttemptAt: new Date().toISOString(),
          providerKey: 'order:order-old',
          request: structuredClone(request),
          retried: true,
        },
      };
    },
    consumeCheckoutCreationAdmission() {
      admitted++;
    },
    async recordCheckout() {},
  } as unknown as ReturnType<typeof createCommerceCommands>;
  try {
    await createCheckoutForOrder(
      { commands, stripe, urls: { successUrl: 'https://new.test/success', cancelUrl: 'https://new.test/cancel' } },
      request.orderId,
    );
    expect(admitted).toBe(1);
    const old = fake.requests[0]!;
    expect(old.headers.get('idempotency-key')).toBe('order:order-old');
    expect(old.params.has('line_items[0][price_data][tax_behavior]')).toBe(false);
    expect(old.params.get('line_items[0][price_data][unit_amount]')).toBe('1200');
    expect(old.params.get('success_url')).toBe(request.successUrl);
    expect(old.params.get('cancel_url')).toBe(request.cancelUrl);
    expect(old.params.get('expires_at')).toBe(String(request.expiresAt));
    expect(old.params.get('automatic_tax[enabled]')).toBe('true');
    expect(old.params.has('managed_payments[enabled]')).toBe(false);
    await stripe.createCheckoutSession(
      {
        ...request,
        orderId: 'order-new',
        apiVersion: STRIPE_API_VERSION,
        ...validateOfferAmount(
          { currency: request.currency, amountMinor: request.unitAmountMinor },
          readCommerceMoneyPolicy({}),
        ),
      },
      'order:order-new',
    );
    const fresh = fake.requests[1]!;
    expect(fresh.params.get('line_items[0][price_data][tax_behavior]')).toBe('exclusive');
    expect(fresh.params.get('line_items[0][price_data][unit_amount]')).toBe('1200');
    expect(fresh.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    // A retained, explicitly captured baseline overrides the new SDK default without changing the capture.
    const captured: CheckoutRequest = { ...request, orderId: 'order-captured', apiVersion: '2026-09-30.endive' };
    const evidence = JSON.stringify(captured);
    await stripe.createCheckoutSession(captured, 'order:order-captured');
    expect(fake.requests[2]!.headers.get('stripe-version')).toBe('2026-09-30.endive');
    expect(JSON.stringify(captured)).toBe(evidence);
    expect(fake.requests).toHaveLength(3);
  } finally {
    fake.stop();
  }
});
