import { afterEach, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { StripeRejectedError, StripeUnavailableError, type CheckoutRequest } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const observedAt = '2026-10-25T12:00:00.000Z';
const request: CheckoutRequest = {
  orderId: 'order-1',
  buyerAccountId: 'buyer-1',
  title: 'A book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
  successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const fixtures: ReturnType<typeof startFakeStripe>[] = [];
afterEach(() => {
  for (const fake of fixtures.splice(0)) fake.stop();
});
function setup(managedPayments = false, rewriteRead?: Parameters<typeof startFakeStripe>[0]) {
  const fake = startFakeStripe(rewriteRead);
  fixtures.push(fake);
  const config = {
    apiKey: 'sk_test_fixture_secret',
    managedPayments,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http' as const,
    timeoutMs: 80,
    maxNetworkRetries: 0,
    clock: () => new Date(observedAt),
  };
  return { fake, port: createStripePort(config), config };
}

test('checkout sessions carry the order price inline with the order idempotency key and no catalogue objects', async () => {
  const { fake, port } = setup();
  const session = await port.createCheckoutSession(request, 'order:order-1');
  expect(session).toEqual({
    id: expect.stringMatching(/^cs_test_/),
    url: expect.stringContaining('https://'),
    expiresAt: new Date(request.expiresAt * 1000).toISOString(),
  });
  const create = fake.requests[0]!;
  expect(create.method).toBe('POST');
  expect(create.path).toBe('/v1/checkout/sessions');
  expect(create.headers.get('idempotency-key')).toBe('order:order-1');
  expect(Object.fromEntries(create.params)).toEqual({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': '1200',
    'line_items[0][price_data][product_data][name]': 'A book',
    'line_items[0][price_data][product_data][tax_code]': 'txcd_10302000',
    client_reference_id: 'order-1',
    'metadata[order_id]': 'order-1',
    'metadata[account_id]': 'buyer-1',
    'payment_intent_data[metadata][order_id]': 'order-1',
    expires_at: String(request.expiresAt),
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    'automatic_tax[enabled]': 'true',
  });
  expect(fake.requests.some((r) => /\/v1\/(products|prices)/.test(r.path))).toBe(false);
  const snapshot = await port.readCheckout(session.id);
  expect(snapshot).toEqual({
    sessionId: session.id,
    clientReferenceId: 'order-1',
    metadataOrderId: 'order-1',
    livemode: false,
    status: 'open',
    paymentStatus: 'unpaid',
    currency: 'usd',
    amountSubtotalMinor: 1200,
    amountTaxMinor: 0,
    amountTotalMinor: 1200,
    paymentIntentId: null,
    paymentIntentStatus: null,
    chargeId: null,
    chargeAmountMinor: null,
    refunds: [],
    disputes: [],
    transactions: [],
    observedAt,
  });
  expect(fake.requests).toHaveLength(2);
});

test('managed payments uses managed tax handling and fallback uses automatic tax', async () => {
  const { fake, port } = setup(true);
  await port.createCheckoutSession(request, 'managed');
  expect(fake.requests[0]!.params.get('managed_payments[enabled]')).toBe('true');
  expect(fake.requests[0]!.params.has('automatic_tax[enabled]')).toBe(false);
});

test('snapshots normalize payment refund and dispute state with their balance transactions', async () => {
  const { fake, port } = setup();
  const session = await port.createCheckoutSession(request, 'paid');
  fake.pay(session.id);
  const start = fake.requests.length;
  const paid = await port.readCheckout(session.id);
  expect(fake.requests.length - start).toBe(3);
  expect(paid).toMatchObject({
    status: 'complete',
    paymentStatus: 'paid',
    paymentIntentStatus: 'succeeded',
    chargeAmountMinor: 1200,
    observedAt,
  });
  expect(paid.paymentIntentId).toMatch(/^pi_/);
  expect(paid.chargeId).toMatch(/^ch_/);
  expect(paid.transactions).toEqual([
    {
      id: expect.stringMatching(/^txn_/),
      kind: 'charge',
      sourceId: paid.chargeId!,
      currency: 'usd',
      amountMinor: 1200,
      feeMinor: 65,
      netMinor: 1135,
      feeDetails: [{ type: 'stripe_fee', amountMinor: 65, description: 'Processing fee' }],
      exchangeRate: null,
      created: expect.stringMatching(/^\d{4}-/),
    },
  ]);
  const reads = fake.requests.slice(start);
  expect(reads[0]!.params.getAll('expand[]')).toContain('payment_intent.latest_charge.balance_transaction');
  expect(reads[1]!.params.get('payment_intent')).toBe(paid.paymentIntentId);
  expect(reads[1]!.params.getAll('expand[]')).toEqual(['data.balance_transaction', 'data.failure_balance_transaction']);
  expect(reads[2]!.params.get('payment_intent')).toBe(paid.paymentIntentId);
  expect(reads[2]!.params.getAll('expand[]')).toEqual(['data.balance_transactions']);
  expect(await port.findCheckoutSession(paid.paymentIntentId!)).toBe(session.id);
  expect(await port.findCheckoutSession('pi_unknown')).toBeNull();

  const partial = fake.refund(session.id, { amount: 300 });
  let snapshot = await port.readCheckout(session.id);
  expect(snapshot.refunds).toEqual([{ id: partial, status: 'succeeded', amountMinor: 300 }]);
  expect(snapshot.transactions[1]).toMatchObject({
    kind: 'refund',
    sourceId: partial,
    amountMinor: -300,
    feeMinor: 0,
    netMinor: -300,
  });
  const rest = fake.refund(session.id, { amount: 900, status: 'pending' });
  snapshot = await port.readCheckout(session.id);
  expect(snapshot.refunds).toContainEqual({ id: rest, status: 'pending', amountMinor: 900 });
  fake.failRefund(rest);
  snapshot = await port.readCheckout(session.id);
  expect(snapshot.refunds).toContainEqual({ id: rest, status: 'failed', amountMinor: 900 });
  expect(snapshot.transactions).toContainEqual(
    expect.objectContaining({ kind: 'refund_reversal', sourceId: rest, amountMinor: 900, netMinor: 900 }),
  );
  const final = fake.refund(session.id, { amount: 900 });
  expect((await port.readCheckout(session.id)).refunds).toContainEqual({
    id: final,
    status: 'succeeded',
    amountMinor: 900,
  });
});

test('async pending, failed and succeeded payments and expired checkouts retain provider state', async () => {
  const { fake, port } = setup();
  const pending = await port.createCheckoutSession(request, 'async');
  fake.pay(pending.id, 'async');
  expect(await port.readCheckout(pending.id)).toMatchObject({
    status: 'complete',
    paymentStatus: 'unpaid',
    paymentIntentStatus: 'processing',
    chargeId: null,
    transactions: [],
  });
  fake.failPayment(pending.id);
  expect(await port.readCheckout(pending.id)).toMatchObject({
    status: 'complete',
    paymentStatus: 'unpaid',
    paymentIntentStatus: 'requires_payment_method',
    transactions: [],
  });
  const success = await port.createCheckoutSession(request, 'async-success');
  fake.pay(success.id, 'async');
  fake.succeedPayment(success.id);
  expect(await port.readCheckout(success.id)).toMatchObject({
    paymentStatus: 'paid',
    paymentIntentStatus: 'succeeded',
  });
  const expired = await port.createCheckoutSession(request, 'expired');
  fake.expire(expired.id);
  expect(await port.readCheckout(expired.id)).toMatchObject({ status: 'expired', paymentStatus: 'unpaid' });
});

test('dispute withdrawals and won reversals preserve signed amounts, dispute fees and exchange rates', async () => {
  const { fake, port } = setup();
  const session = await port.createCheckoutSession(request, 'dispute');
  fake.pay(session.id, 'immediate', { currency: 'eur', amount: 1100, exchangeRate: 11 / 12 });
  const id = fake.dispute(session.id, { fee: 1500 });
  let snapshot = await port.readCheckout(session.id);
  expect(snapshot.disputes).toEqual([{ id, status: 'needs_response', amountMinor: 1200 }]);
  expect(snapshot.transactions[0]).toMatchObject({ currency: 'eur', amountMinor: 1100, exchangeRate: 11 / 12 });
  expect(snapshot.transactions[1]).toMatchObject({
    kind: 'dispute',
    sourceId: id,
    amountMinor: -1100,
    feeMinor: 1500,
    netMinor: -2600,
    feeDetails: [{ type: 'stripe_fee', amountMinor: 1500, description: 'Dispute fee' }],
  });
  fake.updateDispute(id, 'under_review');
  expect((await port.readCheckout(session.id)).disputes[0]!.status).toBe('under_review');
  fake.updateDispute(id, 'won');
  fake.updateDispute(id, 'won');
  snapshot = await port.readCheckout(session.id);
  expect(snapshot.disputes[0]!.status).toBe('won');
  expect(snapshot.transactions).toHaveLength(3);
  expect(snapshot.transactions[2]).toMatchObject({
    kind: 'dispute_reversal',
    sourceId: id,
    amountMinor: 1100,
    feeMinor: 0,
    netMinor: 1100,
  });
});

test('list filtering and bounded pagination collect only this payment intent and reject excess objects', async () => {
  const { fake, port } = setup();
  fake.pageSize = 2;
  const a = await port.createCheckoutSession(request, 'pages-a');
  const b = await port.createCheckoutSession(request, 'pages-b');
  fake.pay(a.id);
  fake.pay(b.id);
  for (let i = 0; i < 5; i++) fake.refund(a.id, { amount: 1 });
  fake.refund(b.id, { amount: 1 });
  for (let i = 0; i < 3; i++) fake.dispute(a.id);
  fake.dispute(b.id);
  const start = fake.requests.length;
  const snapshot = await port.readCheckout(a.id);
  expect(snapshot.refunds).toHaveLength(5);
  expect(snapshot.disputes).toHaveLength(3);
  expect(fake.requests.length - start).toBe(6);
  expect(fake.requests.slice(start).filter((r) => r.params.has('starting_after'))).toHaveLength(3);
  fake.pageSize = 100;
  for (let i = 5; i < 101; i++) fake.refund(a.id, { amount: 1 });
  await expect(port.readCheckout(a.id)).rejects.toBeInstanceOf(StripeUnavailableError);
  const c = await port.createCheckoutSession(request, 'too-many-disputes');
  fake.pay(c.id);
  for (let i = 0; i < 11; i++) fake.dispute(c.id);
  await expect(port.readCheckout(c.id)).rejects.toBeInstanceOf(StripeUnavailableError);
});

test('lost create then retry with the same key returns the same session and stores one session', async () => {
  const { fake, port } = setup();
  fake.nextCreateFault = 'lost';
  await expect(port.createCheckoutSession(request, 'lost')).rejects.toBeInstanceOf(StripeUnavailableError);
  const retry = await port.createCheckoutSession(request, 'lost');
  expect(fake.sessions.size).toBe(1);
  expect(await port.createCheckoutSession(request, 'lost')).toEqual(retry);
  fake.pay(retry.id);
  expect(await port.createCheckoutSession(request, 'lost')).toEqual(retry);
  await expect(port.createCheckoutSession({ ...request, title: 'different' }, 'lost')).rejects.toBeInstanceOf(
    StripeUnavailableError,
  );
  expect(fake.sessions.size).toBe(1);
});

test('rejected and unknown Stripe outcomes are distinguished without exposing the API key', async () => {
  const { fake, port, config } = setup();
  for (const [type, status] of [
    ['invalid_request_error', 400],
    ['card_error', 402],
    ['idempotency_error', 400],
    ['authentication_error', 401],
    ['permission_error', 403],
    ['rate_limit_error', 429],
    ['api_error', 500],
  ] as const) {
    fake.nextCreateFault = { type, status, message: `Error with ${config.apiKey}` };
    try {
      await port.createCheckoutSession(request, type);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(
        type === 'invalid_request_error' || type === 'card_error' ? StripeRejectedError : StripeUnavailableError,
      );
      expect(String(error)).not.toContain(config.apiKey);
    }
  }
  expect(fake.sessions.size).toBe(0);
  for (const fault of ['rejected', 'timeout'] as const) {
    fake.nextCreateFault = fault;
    await expect(port.createCheckoutSession(request, fault)).rejects.toBeInstanceOf(
      fault === 'rejected' ? StripeRejectedError : StripeUnavailableError,
    );
  }
  const session = await port.createCheckoutSession(request, 'connection');
  fake.stop();
  await expect(port.readCheckout(session.id)).rejects.toBeInstanceOf(StripeUnavailableError);
});

test('fake events contain current Stripe objects and exact bytes signed by stripe-node', async () => {
  const { fake, port } = setup();
  const session = await port.createCheckoutSession(request, 'event');
  fake.pay(session.id);
  const snapshot = await port.readCheckout(session.id);
  const refund = fake.refund(session.id, { amount: 100 });
  const dispute = fake.dispute(session.id);
  const sdk = new Stripe('sk_test_webhook');
  for (const [type, id, object] of [
    ['checkout.session.completed', session.id, 'checkout.session'],
    ['payment_intent.succeeded', snapshot.paymentIntentId!, 'payment_intent'],
    ['charge.succeeded', snapshot.chargeId!, 'charge'],
    ['refund.created', refund, 'refund'],
    ['charge.dispute.created', dispute, 'dispute'],
  ] as const) {
    const event = await fake.event(type, id);
    const verified = await sdk.webhooks.constructEventAsync(
      event.bytes,
      event.signature,
      fake.webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
    expect(verified).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      object: 'event',
      livemode: false,
      type,
      data: { object: { id, object, livemode: false } },
    });
  }
  fake.updateDispute(dispute, 'won');
  const current = await fake.event('charge.dispute.closed', dispute);
  expect(JSON.parse(current.bytes).data.object.status).toBe('won');
});

test('captured provider tax mode overrides later factory configuration', async () => {
  const { fake, port } = setup(true);
  const captured = { ...request, managedPayments: false };
  const first = await port.createCheckoutSession(captured, 'captured-mode');
  expect(await port.createCheckoutSession(captured, 'captured-mode')).toEqual(first);
  expect(fake.requests.map((r) => r.rawParams)[0]).toBe(fake.requests.map((r) => r.rawParams)[1]);
  expect(fake.requests.every((r) => r.params.get('automatic_tax[enabled]') === 'true')).toBe(true);
  expect(fake.requests.every((r) => !r.params.has('managed_payments[enabled]'))).toBe(true);
  expect(fake.sessions.size).toBe(1);
});

test('incomplete, foreign and unsupported current payment evidence is unavailable before flattening', async () => {
  let fault: { surface: string; field: string; value: unknown } | undefined;
  const { fake, port } = setup(false, async (path, response) => {
    const body = await response.json();
    if (fault) {
      const target = path.startsWith('/v1/checkout/sessions/')
        ? fault.surface === 'session'
          ? body
          : fault.surface === 'intent'
            ? body.payment_intent
            : fault.surface === 'charge'
              ? body.payment_intent.latest_charge
              : undefined
        : path === '/v1/refunds'
          ? fault.surface === 'refund'
            ? body.data[0]
            : fault.surface === 'refunds'
              ? body
              : undefined
          : path === '/v1/disputes' && fault.surface === 'dispute'
            ? body.data[0]
            : undefined;
      if (target) target[fault.field] = fault.value;
    }
    return Response.json(body);
  });
  const session = await port.createCheckoutSession(request, 'evidence');
  fake.pay(session.id);
  fake.refund(session.id, { amount: 1200 });
  fake.dispute(session.id);
  const complete = await port.readCheckout(session.id);
  expect(complete.refunds).toHaveLength(1);
  for (const row of [
    { surface: 'session', field: 'id', value: 'cs_foreign' },
    { surface: 'session', field: 'mode', value: 'subscription' },
    { surface: 'session', field: 'payment_intent', value: null },
    { surface: 'session', field: 'payment_intent', value: complete.paymentIntentId },
    { surface: 'intent', field: 'latest_charge', value: null },
    { surface: 'intent', field: 'latest_charge', value: complete.chargeId },
    { surface: 'intent', field: 'livemode', value: true },
    { surface: 'intent', field: 'currency', value: 'eur' },
    { surface: 'intent', field: 'amount', value: 1199 },
    { surface: 'intent', field: 'amount_received', value: 0 },
    { surface: 'intent', field: 'status', value: 'future_status' },
    { surface: 'charge', field: 'payment_intent', value: 'pi_foreign' },
    { surface: 'charge', field: 'currency', value: 'eur' },
    { surface: 'charge', field: 'livemode', value: true },
    { surface: 'charge', field: 'amount', value: null },
    { surface: 'charge', field: 'amount_captured', value: 0 },
    { surface: 'refund', field: 'payment_intent', value: 'pi_foreign' },
    { surface: 'refund', field: 'charge', value: 'ch_foreign' },
    { surface: 'refund', field: 'currency', value: 'eur' },
    { surface: 'refund', field: 'amount', value: -1 },
    { surface: 'refund', field: 'status', value: 'future_status' },
    { surface: 'refund', field: 'status', value: null },
    { surface: 'dispute', field: 'payment_intent', value: 'pi_foreign' },
    { surface: 'dispute', field: 'charge', value: 'ch_foreign' },
    { surface: 'dispute', field: 'currency', value: 'eur' },
    { surface: 'dispute', field: 'livemode', value: true },
    { surface: 'dispute', field: 'status', value: 'future_status' },
    { surface: 'refunds', field: 'has_more', value: undefined },
    { surface: 'refunds', field: 'has_more', value: true },
    { surface: 'refunds', field: 'data', value: [] },
  ]) {
    fault = row;
    await expect(port.readCheckout(session.id)).rejects.toBeInstanceOf(StripeUnavailableError);
  }
  fault = undefined;
  expect((await port.readCheckout(session.id)).paymentIntentId).toBe(complete.paymentIntentId);
});

test('complete associated paid and adverse evidence does not require balance movement availability', async () => {
  const { fake, port } = setup(false, async (path, response) => {
    const body = await response.json();
    if (path.startsWith('/v1/checkout/sessions/')) body.payment_intent.latest_charge.balance_transaction = null;
    if (path === '/v1/refunds')
      for (const refund of body.data) {
        refund.balance_transaction = null;
        refund.failure_balance_transaction = null;
      }
    if (path === '/v1/disputes') for (const dispute of body.data) dispute.balance_transactions = [];
    return Response.json(body);
  });
  const session = await port.createCheckoutSession(request, 'no-cash');
  fake.pay(session.id);
  expect(await port.readCheckout(session.id)).toMatchObject({
    paymentStatus: 'paid',
    refunds: [],
    disputes: [],
    transactions: [],
  });
  const refund = fake.refund(session.id, { amount: 1200, status: 'pending' });
  const dispute = fake.dispute(session.id, { status: 'lost', withdraw: false });
  expect(await port.readCheckout(session.id)).toMatchObject({
    refunds: [{ id: refund, status: 'pending' }],
    disputes: [{ id: dispute, status: 'lost' }],
    transactions: [],
  });
  fake.failRefund(refund);
  fake.updateDispute(dispute, 'won');
  expect(await port.readCheckout(session.id)).toMatchObject({
    paymentStatus: 'paid',
    refunds: [{ id: refund, status: 'failed' }],
    disputes: [{ id: dispute, status: 'won' }],
    transactions: [],
  });
});
