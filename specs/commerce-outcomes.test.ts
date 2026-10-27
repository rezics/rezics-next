import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CommerceDriver,
  EntitlementView,
  OfferFixture,
  OfferView,
  OrderReadView,
  OrderView,
  Persona,
  StripeEventType,
} from './commerce-driver';

setDefaultTimeout(60_000);
let driver: CommerceDriver;
beforeEach(async () => {
  const location = process.env.COMMERCE_DRIVER;
  if (!location) throw new Error('Commerce outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('COMMERCE_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('COMMERCE_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createCommerceDriver !== 'function') throw new Error('Expected createCommerceDriver factory');
  driver = await binding.createCommerceDriver();
  await driver.setTime('2030-01-02T00:00:00.000Z');
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
let serial = 0;
const key = () => `"commerce-${++serial}"`;
const get = (as: Persona, path: string) => driver.request(as, { method: 'GET', path });
const create = (as: Persona, offerId: string, idempotencyKey = key()) =>
  driver.request(as, {
    method: 'POST',
    path: '/v1/orders',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { offerId },
  });
async function body<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}
async function order(id: string, as: Persona = 'buyer') {
  return (await body<{ order: OrderReadView }>(await get(as, `/v1/orders/${id}`))).order;
}
async function listing(as: Persona = 'buyer') {
  return body<{ entitlements: EntitlementView[]; next: string | null }>(await get(as, '/v1/entitlements'));
}
async function checkout(as: Persona = 'buyer', offer?: OfferFixture) {
  const selected = offer ?? (await driver.provisionOffer());
  const response = await create(as, selected.id);
  const result = (await body<{ order: OrderView }>(response, 201)).order;
  expect(response.headers.get('location')).toBe(`/v1/orders/${result.id}`);
  expect(result).toMatchObject({ offerId: selected.id, settlement: 'pending', entitlementId: null });
  expect(result.checkoutUrl).toMatch(/^https?:\/\//);
  expect(Number.isFinite(Date.parse(result.checkoutExpiresAt!))).toBe(true);
  const row = (await driver.inspect()).orders.find((item) => item.id === result.id)!;
  expect(row.checkoutSessionId).toBeTruthy();
  return { order: result, sessionId: row.checkoutSessionId!, offer: selected };
}
function signature(
  bytes: Uint8Array,
  secret = driver.configuration.webhookSecret,
  timestamp = Math.floor(Date.parse(driver.now()) / 1000),
) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(bytes).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}
const deliver = (bytes: Uint8Array, header: string | null = signature(bytes)) =>
  driver.request('anonymous', {
    method: 'POST',
    path: '/v1/webhooks/stripe',
    rawBody: bytes,
    headers: { 'Content-Type': 'application/json', ...(header === null ? {} : { 'Stripe-Signature': header }) },
  });
async function event(
  sessionId: string,
  type: StripeEventType = 'checkout.session.completed',
  payloadPaymentStatus?: 'paid',
) {
  const id = `evt_${++serial}`;
  return {
    id,
    bytes: await driver.stripe.event({
      id,
      sessionId,
      type,
      ...(payloadPaymentStatus === undefined ? {} : { payloadPaymentStatus }),
    }),
  };
}
async function notify(sessionId: string, type: StripeEventType = 'checkout.session.completed') {
  const message = await event(sessionId, type);
  expect(await body(await deliver(message.bytes))).toEqual({ received: true });
  await driver.settle();
  return message;
}
async function paid(as: Persona = 'buyer', offer?: OfferFixture) {
  const fixture = await checkout(as, offer);
  await driver.stripe.pay(fixture.sessionId);
  await notify(fixture.sessionId);
  const view = await order(fixture.order.id, as);
  expect(view.settlement).toBe('paid');
  expect(view.entitlementId).toBeTruthy();
  const entitlement = (
    await body<{ entitlement: EntitlementView }>(await get(as, `/v1/entitlements/${view.entitlementId}`))
  ).entitlement;
  expect(entitlement).toMatchObject({
    id: view.entitlementId,
    orderId: view.id,
    offerId: fixture.offer.id,
    targetSubjectId: fixture.offer.targetSubjectId,
    active: true,
    revokedAt: null,
    revokeReason: null,
  });
  expect(Number.isFinite(Date.parse(entitlement.grantedAt))).toBe(true);
  return { ...fixture, entitlement };
}
const events = async (suffix: string) =>
  (await driver.inspect()).events.filter((item) => item.type === `com.rezics.commerce.${suffix}.v1`);
async function entitlement(id: string, as: Persona = 'buyer') {
  return (await body<{ entitlement: EntitlementView }>(await get(as, `/v1/entitlements/${id}`))).entitlement;
}
async function noGrant(id: string, settlement: OrderView['settlement']) {
  expect(await order(id)).toMatchObject({ settlement, entitlementId: null });
  expect((await driver.inspect()).entitlements.filter((item) => item.orderId === id)).toEqual([]);
  expect(await events('entitlement.granted')).toEqual([]);
}

test('anonymous reads an offer but cannot create orders list entitlements or discover private IDs', async () => {
  const fixture = await paid();
  expect(await body<{ offer: OfferView }>(await get('anonymous', `/v1/offers/${fixture.offer.id}`))).toEqual({
    offer: {
      id: fixture.offer.id,
      targetSubjectId: fixture.offer.targetSubjectId,
      title: fixture.offer.title,
      currency: fixture.offer.currency,
      unitAmountMinor: fixture.offer.unitAmountMinor,
      state: 'active',
      subject: null,
    },
  });
  expect((await create('anonymous', fixture.offer.id)).status).toBe(401);
  expect((await get('anonymous', '/v1/entitlements')).status).toBe(401);
  for (const [path, unknown] of [
    [`/v1/orders/${fixture.order.id}`, `/v1/orders/${driver.unknown.orderId}`],
    [`/v1/entitlements/${fixture.entitlement.id}`, `/v1/entitlements/${driver.unknown.entitlementId}`],
  ]) {
    const { request_id: _hiddenRequest, ...hidden } = await body<Record<string, unknown>>(
      await get('anonymous', path!),
      404,
    );
    const { request_id: _absentRequest, ...absent } = await body<Record<string, unknown>>(
      await get('anonymous', unknown!),
      404,
    );
    expect(hidden).toMatchObject({ code: 'not_found' });
    expect(absent).toMatchObject({ code: 'not_found' });
    expect(hidden).toEqual(absent);
  }
  expect((await listing()).entitlements).toEqual([fixture.entitlement]);
});

test('buyer checkout snapshots the offer at T in the buyer partition and sends inline Stripe prices', async () => {
  await driver.configureCheckout({ managedPayments: true });
  const fixture = await checkout();
  const before = fixture.offer;
  await driver.reviseOffer(before.id, { unitAmountMinor: before.unitAmountMinor + 100 });
  expect((await driver.inspect()).orders).toEqual([
    expect.objectContaining({
      id: fixture.order.id,
      buyerAccountId: driver.accounts.buyer.id,
      route: driver.accounts.buyer.route,
      partition: driver.accounts.buyer.partition,
      offerId: before.id,
      offerRevision: before.revision,
      creatorAccountId: before.creatorAccountId,
      title: before.title,
      currency: before.currency,
      unitAmountMinor: before.unitAmountMinor,
      taxCode: before.taxCode,
      royaltyBasisPoints: before.royaltyBasisPoints,
    }),
  ]);
  const calls = await driver.stripe.creates();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    sessionId: fixture.sessionId,
    idempotencyKey: `order:${fixture.order.id}`,
    parameters: {
      mode: 'payment',
      client_reference_id: fixture.order.id,
      metadata: { order_id: fixture.order.id, account_id: driver.accounts.buyer.id },
      payment_intent_data: { metadata: { order_id: fixture.order.id } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: before.currency,
            unit_amount: before.unitAmountMinor,
            product_data: { name: before.title, tax_code: before.taxCode },
          },
        },
      ],
      managed_payments: { enabled: true },
      success_url: driver.configuration.successUrl,
      cancel_url: driver.configuration.cancelUrl,
      expires_at: Math.floor(Date.parse(fixture.order.createdAt) / 1000) + 3600,
    },
  });
  expect(await order(fixture.order.id)).toEqual({
    ...fixture.order,
    title: before.title,
    targetSubjectId: before.targetSubjectId,
    subject: null,
  });
});

test('checkout without Managed Payments enables automatic tax', async () => {
  await driver.configureCheckout({ managedPayments: false });
  await checkout();
  const calls = await driver.stripe.creates();
  expect(calls[0]!.parameters.automatic_tax).toEqual({ enabled: true });
  expect(calls[0]!.parameters.managed_payments?.enabled ?? false).toBe(false);
});

test('same Idempotency-Key replays one order and session while a changed body conflicts', async () => {
  const offer = await driver.provisionOffer();
  const another = await driver.provisionOffer();
  const idempotencyKey = key();
  const first = await body<{ order: OrderView }>(await create('buyer', offer.id, idempotencyKey), 201);
  expect(first.order.settlement).toBe('pending');
  expect(first.order.checkoutUrl).toBeTruthy();
  expect(await body(await create('buyer', offer.id, idempotencyKey), 201)).toEqual(first);
  expect(await body(await create('buyer', another.id, idempotencyKey), 422)).toMatchObject({
    code: 'idempotency_conflict',
  });
  expect((await driver.inspect()).orders).toHaveLength(1);
  expect(await driver.stripe.sessions()).toHaveLength(1);
});

test('signed paid completion grants once and other sees only the same 404 as an unknown ID', async () => {
  const fixture = await paid();
  expect(fixture.entitlement.summary).toBeNull();
  const { summary: _summary, ...storedEntitlement } = fixture.entitlement;
  expect((await driver.inspect()).entitlements).toEqual([
    expect.objectContaining({
      ...storedEntitlement,
      accountId: driver.accounts.buyer.id,
      route: driver.accounts.buyer.route,
      partition: driver.accounts.buyer.partition,
    }),
  ]);
  expect(await events('entitlement.granted')).toHaveLength(1);
  expect(await listing()).toEqual({ entitlements: [fixture.entitlement], next: null });
  expect(await listing('other')).toEqual({ entitlements: [], next: null });
  for (const [kind, id, unknown] of [
    ['orders', fixture.order.id, driver.unknown.orderId],
    ['entitlements', fixture.entitlement.id, driver.unknown.entitlementId],
  ]) {
    const { request_id: _hiddenRequest, ...hidden } = await body<Record<string, unknown>>(
      await get('other', `/v1/${kind}/${id}`),
      404,
    );
    const { request_id: _absentRequest, ...absent } = await body<Record<string, unknown>>(
      await get('other', `/v1/${kind}/${unknown}`),
      404,
    );
    expect(hidden).toMatchObject({ code: 'not_found' });
    expect(absent).toMatchObject({ code: 'not_found' });
    expect(hidden).toEqual(absent);
  }
});

test('async unpaid completion stays pending until async payment succeeds', async () => {
  const fixture = await checkout();
  await driver.stripe.completeUnpaid(fixture.sessionId);
  await notify(fixture.sessionId);
  await noGrant(fixture.order.id, 'pending');
  await driver.stripe.asyncPay(fixture.sessionId);
  await notify(fixture.sessionId, 'checkout.session.async_payment_succeeded');
  expect((await order(fixture.order.id)).settlement).toBe('paid');
  expect((await listing()).entitlements).toEqual([
    expect.objectContaining({ orderId: fixture.order.id, active: true }),
  ]);
  expect(await events('entitlement.granted')).toHaveLength(1);
});

test('async payment failure settles failed without an entitlement', async () => {
  const fixture = await checkout();
  await driver.stripe.completeUnpaid(fixture.sessionId);
  await notify(fixture.sessionId);
  await noGrant(fixture.order.id, 'pending');
  await driver.stripe.failPayment(fixture.sessionId);
  await notify(fixture.sessionId, 'checkout.session.async_payment_failed');
  await noGrant(fixture.order.id, 'failed');
});

test('expired unpaid checkout settles failed without an entitlement', async () => {
  const fixture = await checkout();
  await noGrant(fixture.order.id, 'pending');
  await driver.stripe.expire(fixture.sessionId);
  await notify(fixture.sessionId, 'checkout.session.expired');
  await noGrant(fixture.order.id, 'failed');
});

test('identical signed bytes replay before and after processing with one event workflow and grant', async () => {
  const fixture = await checkout();
  await driver.settle();
  await driver.holdWork();
  await driver.stripe.pay(fixture.sessionId);
  const message = await event(fixture.sessionId);
  const header = signature(message.bytes);
  expect(await body(await deliver(message.bytes, header))).toEqual({ received: true });
  expect(await body(await deliver(message.bytes, header))).toEqual({ received: true });
  await driver.settle();
  const before = await driver.inspect();
  expect((await order(fixture.order.id)).settlement).toBe('paid');
  expect(before.workflows.filter((item) => item.id === `stripe:${message.id}`)).toHaveLength(1);
  expect(before.workflows.filter((item) => item.id === `checkout:${fixture.sessionId}:${message.id}`)).toHaveLength(1);
  expect(before.entitlements).toHaveLength(1);
  expect(before.entitlements[0]!.active).toBe(true);
  expect(await events('entitlement.granted')).toHaveLength(1);
  expect(await body(await deliver(message.bytes, header))).toEqual({ received: true });
  await driver.settle();
  expect(await driver.inspect()).toEqual(before);
});

test('wrong secret tampered bytes missing header and stale timestamp reject without durable changes', async () => {
  const fixture = await checkout();
  await driver.stripe.pay(fixture.sessionId);
  await driver.settle();
  const message = await event(fixture.sessionId);
  const valid = signature(message.bytes);
  const tampered = new Uint8Array([...message.bytes, 32]);
  const before = await driver.inspect();
  for (const [bytes, header] of [
    [message.bytes, signature(message.bytes, 'wrong-secret')],
    [tampered, valid],
    [message.bytes, null],
    [
      message.bytes,
      signature(message.bytes, driver.configuration.webhookSecret, Math.floor(Date.parse(driver.now()) / 1000) - 301),
    ],
  ] as const) {
    expect(await body(await deliver(bytes, header), 400)).toMatchObject({ code: 'invalid_signature' });
    await driver.settle();
    expect(await driver.inspect()).toEqual(before);
  }
  expect(await body(await deliver(message.bytes))).toEqual({ received: true });
  await driver.settle();
  expect((await order(fixture.order.id)).settlement).toBe('paid');
  expect((await listing()).entitlements[0]!.active).toBe(true);
});

test('forged completed for an unpaid session grants nothing while a real paid completion grants', async () => {
  const fixture = await checkout();
  const message = await event(fixture.sessionId, 'checkout.session.completed', 'paid');
  expect(await body(await deliver(message.bytes, signature(message.bytes, 'forged-secret')), 400)).toMatchObject({
    code: 'invalid_signature',
  });
  await driver.settle();
  await noGrant(fixture.order.id, 'pending');
  await driver.stripe.pay(fixture.sessionId);
  await notify(fixture.sessionId);
  expect((await listing()).entitlements).toEqual([
    expect.objectContaining({ orderId: fixture.order.id, active: true }),
  ]);
});

test('validly signed payload claiming paid cannot override an unpaid current Stripe session', async () => {
  const fixture = await checkout();
  await driver.stripe.completeUnpaid(fixture.sessionId);
  const message = await event(fixture.sessionId, 'checkout.session.completed', 'paid');
  expect(await body(await deliver(message.bytes))).toEqual({ received: true });
  await driver.settle();
  await noGrant(fixture.order.id, 'pending');
  await driver.stripe.asyncPay(fixture.sessionId);
  await notify(fixture.sessionId, 'checkout.session.async_payment_succeeded');
  expect((await listing()).entitlements[0]!.active).toBe(true);
});

test('refunded buyer keeps a listed inactive entitlement after a full Stripe-originated refund', async () => {
  const fixture = await paid('refunded');
  await driver.stripe.refund(fixture.sessionId, 'remaining');
  await notify(fixture.sessionId, 'charge.refunded');
  const revoked = await entitlement(fixture.entitlement.id, 'refunded');
  expect(revoked).toMatchObject({ active: false, revokeReason: 'refund' });
  expect(Number.isFinite(Date.parse(revoked.revokedAt!))).toBe(true);
  expect((await listing('refunded')).entitlements).toEqual([revoked]);
  expect((await order(fixture.order.id, 'refunded')).settlement).toBe('paid');
  expect(await events('entitlement.revoked')).toHaveLength(1);
  expect(await listing('other')).toEqual({ entitlements: [], next: null });
});

test('partial refund preserves the entitlement and a subsequent full refund revokes it', async () => {
  const fixture = await paid('refunded', await driver.provisionOffer({ unitAmountMinor: 1000 }));
  await driver.stripe.refund(fixture.sessionId, 400);
  await notify(fixture.sessionId, 'charge.refunded');
  expect(await entitlement(fixture.entitlement.id, 'refunded')).toEqual(fixture.entitlement);
  expect(await events('entitlement.revoked')).toHaveLength(0);
  await driver.stripe.refund(fixture.sessionId, 'remaining');
  await notify(fixture.sessionId, 'charge.refunded');
  expect(await entitlement(fixture.entitlement.id, 'refunded')).toMatchObject({
    active: false,
    revokeReason: 'refund',
  });
});

test('refund events arriving before checkout completion never grant an entitlement', async () => {
  const fixture = await checkout('refunded');
  await driver.stripe.pay(fixture.sessionId);
  await driver.stripe.refund(fixture.sessionId, 'remaining');
  await notify(fixture.sessionId, 'charge.refunded');
  expect((await order(fixture.order.id, 'refunded')).entitlementId).toBeNull();
  expect((await driver.inspect()).entitlements).toEqual([]);
  await notify(fixture.sessionId);
  // Fail closed: a fully refunded purchase never briefly grants, even on first observation.
  expect((await order(fixture.order.id, 'refunded')).settlement).toBe('paid');
  expect((await driver.inspect()).entitlements).toEqual([]);
  expect(await events('entitlement.granted')).toEqual([]);
  const control = await paid();
  expect((await listing()).entitlements).toEqual([control.entitlement]);
});

async function dispute(status: 'won' | 'lost') {
  const fixture = await paid();
  await driver.stripe.dispute(fixture.sessionId, 'needs_response');
  await notify(fixture.sessionId, 'charge.dispute.created');
  expect(await entitlement(fixture.entitlement.id)).toMatchObject({ active: false, revokeReason: 'dispute' });
  expect(await events('entitlement.revoked')).toHaveLength(1);
  await driver.stripe.dispute(fixture.sessionId, status);
  await notify(fixture.sessionId, 'charge.dispute.closed');
  return fixture;
}

test('dispute needs_response revokes and won restores the same entitlement', async () => {
  const fixture = await dispute('won');
  expect(await entitlement(fixture.entitlement.id)).toMatchObject({
    active: true,
    revokedAt: null,
    revokeReason: null,
  });
  expect((await driver.inspect()).entitlements).toHaveLength(1);
  expect(await events('entitlement.granted')).toHaveLength(1);
  expect(await events('entitlement.restored')).toHaveLength(1);
});

test('lost dispute stays revoked and does not emit a restoration', async () => {
  const fixture = await dispute('lost');
  expect(await entitlement(fixture.entitlement.id)).toMatchObject({ active: false, revokeReason: 'dispute' });
  expect(await events('entitlement.restored')).toHaveLength(0);
});

test('warning_needs_response inquiry preserves an active entitlement', async () => {
  const fixture = await paid();
  await driver.stripe.dispute(fixture.sessionId, 'warning_needs_response');
  await notify(fixture.sessionId, 'charge.dispute.created');
  expect(await entitlement(fixture.entitlement.id)).toEqual(fixture.entitlement);
  expect(await events('entitlement.revoked')).toHaveLength(0);
});

test('delisting prevents new checkout but preserves an existing entitlement', async () => {
  const fixture = await paid();
  await driver.reviseOffer(fixture.offer.id, { state: 'delisted' });
  expect(await body(await create('buyer', fixture.offer.id), 409)).toMatchObject({ code: 'offer_unavailable' });
  expect(await entitlement(fixture.entitlement.id)).toEqual(fixture.entitlement);
  expect((await listing()).entitlements).toEqual([fixture.entitlement]);
  expect((await driver.inspect()).orders).toHaveLength(1);
  expect(await driver.stripe.sessions()).toHaveLength(1);
  expect((await create('buyer', driver.unknown.offerId)).status).toBe(404);
});

test('suspended account cannot create an order while an active account can', async () => {
  const fixture = await checkout();
  const before = await driver.inspect();
  const response = await create('suspended', fixture.offer.id);
  // Fail closed without choosing an unspecified authentication-versus-authorization error code.
  expect([401, 403]).toContain(response.status);
  expect(await driver.inspect()).toEqual(before);
  expect(await driver.stripe.sessions()).toHaveLength(1);
});

test('definitive Stripe create rejection records failed with no checkout URL', async () => {
  const offer = await driver.provisionOffer();
  await driver.stripe.failNextCreate('reject');
  await create('buyer', offer.id);
  const rows = (await driver.inspect()).orders;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ settlement: 'failed', checkoutUrl: null, checkoutSessionId: null });
  expect(await order(rows[0]!.id)).toMatchObject({ settlement: 'failed', checkoutUrl: null, entitlementId: null });
  expect(await driver.stripe.sessions()).toHaveLength(0);
  await checkout();
});

test('lost Stripe create records unknown then same-key retry recovers the single session', async () => {
  const offer = await driver.provisionOffer();
  const idempotencyKey = key();
  await driver.stripe.failNextCreate('lose');
  await create('buyer', offer.id, idempotencyKey);
  const rows = (await driver.inspect()).orders;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ settlement: 'unknown', checkoutUrl: null });
  expect(await order(rows[0]!.id)).toMatchObject({ settlement: 'unknown', checkoutUrl: null, entitlementId: null });
  const sessions = await driver.stripe.sessions();
  expect(sessions).toHaveLength(1);
  const recovered = await body<{ order: OrderView }>(await create('buyer', offer.id, idempotencyKey), 201);
  expect(recovered.order).toMatchObject({ id: rows[0]!.id, settlement: 'pending' });
  expect(recovered.order.checkoutUrl).toBeTruthy();
  expect((await driver.inspect()).orders[0]!.checkoutSessionId).toBe(sessions[0]!.id);
  expect(await driver.stripe.sessions()).toEqual(sessions);
  expect((await driver.inspect()).orders).toHaveLength(1);
  expect((await driver.stripe.creates()).every((call) => call.idempotencyKey === `order:${rows[0]!.id}`)).toBe(true);
});

test('create order webhook delivery and entitlement listing use equal statement counts at three seeded scales', async () => {
  const control = await paid();
  const counts: number[][] = [];
  for (const scale of [0, 100, 1000]) {
    await driver.seedUnrelatedOrders(scale);
    await driver.holdWork();
    const created = await driver.measure(() => create('buyer', control.offer.id));
    const view = (await body<{ order: OrderView }>(created.value, 201)).order;
    expect(view.settlement).toBe('pending');
    const row = (await driver.inspect()).orders.find((item) => item.id === view.id)!;
    await driver.stripe.pay(row.checkoutSessionId!);
    const message = await event(row.checkoutSessionId!);
    const webhook = await driver.measure(() => deliver(message.bytes));
    expect(await body(webhook.value)).toEqual({ received: true });
    const listed = await driver.measure(() => get('buyer', '/v1/entitlements'));
    expect(await body(listed.value)).toEqual({ entitlements: [control.entitlement], next: null });
    for (const measurement of [created, webhook, listed]) {
      expect(Number.isInteger(measurement.statements)).toBe(true);
      expect(measurement.statements).toBeGreaterThan(0);
      expect(Number.isFinite(measurement.buffers)).toBe(true);
      expect(measurement.buffers).toBeGreaterThanOrEqual(0);
    }
    counts.push([created.statements, webhook.statements, listed.statements]);
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
  await driver.settle();
  expect((await listing()).entitlements.filter((item) => item.active)).toHaveLength(4);
});
