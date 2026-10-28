import { afterEach, expect, test } from 'bun:test';
import { StripeRejectedError } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const fixtures: ReturnType<typeof startFakeStripe>[] = [];
afterEach(() => {
  for (const fake of fixtures.splice(0)) fake.stop();
});

async function setup() {
  const fake = startFakeStripe();
  fixtures.push(fake);
  const port = createStripePort({
    apiKey: 'sk_test_fixture_secret',
    managedPayments: true,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    timeoutMs: 1000,
    maxNetworkRetries: 0,
    clock: () => new Date('2026-10-29T00:00:00.000Z'),
  });
  // Provider-boundary data only: native order binding is a separate consumer obligation.
  const session = await port.createCheckoutSession(
    {
      orderId: 'provider-fixture-order',
      buyerAccountId: 'provider-fixture-buyer',
      title: 'Fixture book',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    'locator-fixture',
  );
  return { fake, port, session };
}

test('open Session locator is one unexpanded SDK GET and a closed correlation DTO', async () => {
  const { fake, port, session } = await setup();
  const start = fake.requests.length;
  expect(await port.readCheckoutLocator(session.id)).toEqual({
    sessionId: session.id,
    clientReferenceId: 'provider-fixture-order',
    metadataOrderId: 'provider-fixture-order',
    livemode: false,
    mode: 'payment',
    paymentIntentId: null,
  });
  const reads = fake.requests.slice(start);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.method).toBe('GET');
  expect(reads[0]!.path).toBe(`/v1/checkout/sessions/${session.id}`);
  expect([...reads[0]!.rawParams]).toEqual([]);
});

test('paid Session locator never expands or reads financial children as their history grows', async () => {
  const { fake, port, session } = await setup();
  fake.pay(session.id);
  for (const scale of [1, 4, 16]) {
    fake.refund(session.id, { amount: scale });
    fake.dispute(session.id, { amount: scale, withdraw: false });
    const start = fake.requests.length;
    const locator = await port.readCheckoutLocator(session.id);
    expect(locator).toEqual({
      sessionId: session.id,
      clientReferenceId: 'provider-fixture-order',
      metadataOrderId: 'provider-fixture-order',
      livemode: false,
      mode: 'payment',
      paymentIntentId: expect.stringMatching(/^pi_/),
    });
    const reads = fake.requests.slice(start);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.path).toBe(`/v1/checkout/sessions/${session.id}`);
    expect([...reads[0]!.rawParams]).toEqual([]);
  }
});

test('locator preserves missing and foreign correlation and provider mode for native rejection', async () => {
  const { fake, port, session } = await setup();
  const provider = fake.sessions.get(session.id)!;
  provider.client_reference_id = null;
  provider.metadata = { order_id: 'foreign-order', account_id: 'private-provider-metadata' };
  provider.mode = 'subscription';
  provider.livemode = true;
  expect(await port.readCheckoutLocator(session.id)).toEqual({
    sessionId: session.id,
    clientReferenceId: null,
    metadataOrderId: 'foreign-order',
    livemode: true,
    mode: 'subscription',
    paymentIntentId: null,
  });
  provider.metadata = {};
  expect((await port.readCheckoutLocator(session.id)).metadataOrderId).toBeNull();
});

test('provider locator failure is visible and never becomes an empty successful anchor', async () => {
  const { port } = await setup();
  await expect(port.readCheckoutLocator('cs_test_unknown')).rejects.toBeInstanceOf(StripeRejectedError);
});
