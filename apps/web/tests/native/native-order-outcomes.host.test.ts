import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
  startNativeOrderOutcomesFixture,
  type NativeOrderOutcomeName,
  type NativeOrderOutcomesFixture,
  type NativeProducedOutcome,
} from './native-order-outcomes-fixture.ts';

let fixture: NativeOrderOutcomesFixture;
setDefaultTimeout(300_000);

beforeAll(async () => {
  fixture = await startNativeOrderOutcomesFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
}, 300_000);

function produced(name: NativeOrderOutcomeName): NativeProducedOutcome {
  const outcome = fixture.manifest.outcomes[name];
  expect(outcome.availability, `${name} must be produced by the native fixture`).toBe('produced');
  if (outcome.availability !== 'produced') throw new Error(`${name}: ${outcome.binding}`);
  return outcome;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a response object');
  return value as Record<string, unknown>;
}

function nested(value: unknown, key: string): Record<string, unknown> {
  return object(object(value)[key]);
}

function ids(outcome: NativeProducedOutcome): string[] {
  const rows = object(outcome.response.body).orders;
  if (!Array.isArray(rows)) throw new Error('Expected native order rows');
  return rows.map((row) => String(object(row).id));
}

function rawJson(outcome: NativeProducedOutcome): unknown {
  try {
    return JSON.parse(outcome.response.bodyText) as unknown;
  } catch {
    return outcome.response.bodyText;
  }
}

function sequenceIndex(name: NativeOrderOutcomeName): number {
  return fixture.manifest.sequence.findIndex((step) => step.kind === 'outcome' && step.name === name);
}

test('changed terms require the reviewed revision and retain the original accepted order on exact replay', () => {
  const manifest = fixture.manifest;
  const initialReview = produced('initialPublicOfferReview');
  const initialOffer = nested(initialReview.response.body, 'offer');
  const initialOrder = produced('initialOrderSubmission');
  const initialRequestBody = object(initialOrder.command.body);
  expect(initialOrder.command.idempotencyKey).toMatch(/^"[0-9a-f-]{36}"$/i);
  expect(initialRequestBody).toEqual({
    offerId: manifest.ids.offerId,
    expectedOfferRevision: initialOffer.revision,
  });

  const stale = produced('staleBuyerSubmission');
  expect(stale.command.idempotencyKey).toMatch(/^"[0-9a-f-]{36}"$/i);
  expect(stale.command.idempotencyKey).not.toBe(initialOrder.command.idempotencyKey);
  expect(stale.response.status).toBe(409);
  expect(stale.response.body).toMatchObject({ code: 'offer_revision_conflict', retryable: false });
  for (const field of ['offer', 'revision', 'currency', 'unitAmountMinor', 'expectedOfferRevision'])
    expect(object(stale.response.body)).not.toHaveProperty(field);
  expect(manifest.observations.staleOrderIdsAfter).toEqual(manifest.observations.staleOrderIdsBefore);
  expect(manifest.observations.staleProviderRequestCountAfter).toBe(
    manifest.observations.staleProviderRequestCountBefore,
  );
  expect(ids(produced('ordersAfterStaleSubmission'))).toEqual(ids(produced('ordersBeforeStaleSubmission')));

  const revisedReview = produced('revisedPublicOfferReview');
  const revisedOffer = nested(revisedReview.response.body, 'offer');
  expect(revisedOffer.revision).toBeGreaterThan(initialOffer.revision as number);
  expect(revisedOffer.unitAmountMinor).not.toBe(initialOffer.unitAmountMinor);
  const initialBefore = nested(produced('initialOrderDetailBeforeReprice').response.body, 'order');
  const initialAfter = nested(produced('initialOrderDetailAfterReprice').response.body, 'order');
  expect(initialAfter).toEqual(initialBefore);
  expect(initialAfter.contentEdition).toEqual(initialBefore.contentEdition);
  expect(initialAfter.recordedPresentment).toEqual(initialBefore.recordedPresentment);
  expect(initialAfter.unitAmountMinor).toBe(initialBefore.unitAmountMinor);

  const replay = produced('originalOrderReplay');
  expect(replay.command.body).toEqual(initialOrder.command.body);
  expect(replay.command.idempotencyKey).toBe(initialOrder.command.idempotencyKey);
  expect(replay.response.status).toBe(201);
  expect(replay.response.body).toEqual(initialOrder.response.body);
  expect(manifest.observations.replayOrderIdsAfter).toEqual(manifest.observations.replayOrderIdsBefore);
  expect(manifest.observations.replayProviderRequestCountAfter).toBe(
    manifest.observations.replayProviderRequestCountBefore,
  );

  const changedRevision = produced('originalKeyChangedRevision');
  expect(changedRevision.command.idempotencyKey).toBe(initialOrder.command.idempotencyKey);
  expect(object(changedRevision.command.body).expectedOfferRevision).toBe(revisedOffer.revision);
  expect(changedRevision.response.status).toBe(422);
  expect(changedRevision.response.body).toMatchObject({ code: 'idempotency_conflict' });
  expect(manifest.observations.changedRevisionOrderIdsAfter).toEqual(
    manifest.observations.changedRevisionOrderIdsBefore,
  );
  expect(manifest.observations.changedRevisionProviderRequestCountAfter).toBe(
    manifest.observations.changedRevisionProviderRequestCountBefore,
  );

  const deliberate = produced('revisedBuyerSubmission');
  expect(deliberate.response.status).toBe(201);
  expect(object(deliberate.command.body)).toEqual({
    offerId: manifest.ids.offerId,
    expectedOfferRevision: revisedOffer.revision,
  });
  expect(deliberate.command.idempotencyKey).not.toBe(initialOrder.command.idempotencyKey);
  expect(deliberate.command.idempotencyKey).not.toBe(stale.command.idempotencyKey);
  expect(sequenceIndex('revisedPublicOfferReview')).toBeGreaterThan(sequenceIndex('staleBuyerSubmission'));
  expect(sequenceIndex('revisedBuyerSubmission')).toBeGreaterThan(sequenceIndex('revisedPublicOfferReview'));
  expect(nested(produced('pendingOrderDetail').response.body, 'order').unitAmountMinor).toBe(
    revisedOffer.unitAmountMinor,
  );
});

test('verified payment and full refund preserve settlement truth separately from current benefit', () => {
  const manifest = fixture.manifest;
  const pending = produced('pendingOrderDetail');
  expect(pending.response.status).toBe(200);
  expect(nested(pending.response.body, 'order')).toMatchObject({
    id: manifest.ids.revisedOrderId,
    settlement: 'pending',
  });
  expect(object(produced('pendingBuyerEntitlements').response.body).entitlements).toEqual([]);

  const payment = produced('paymentWebhook');
  const paymentReplay = produced('paymentWebhookReplay');
  expect(payment.response.status).toBe(200);
  expect(payment.command.kind).toBe('signed-fake-stripe-event');
  if (payment.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed payment event');
  expect(payment.command.event.type).toBe('checkout.session.completed');
  expect(paymentReplay.command.kind).toBe('signed-fake-stripe-event');
  if (paymentReplay.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed payment replay');
  expect(paymentReplay.command.replayOf).toBe(payment.command.event.id);
  expect(paymentReplay.response.status).toBe(200);

  const paidOrder = nested(produced('paidOrderDetail').response.body, 'order');
  expect(paidOrder).toMatchObject({ id: manifest.ids.revisedOrderId, settlement: 'paid' });
  expect(paidOrder.entitlementId).toBe(manifest.ids.paidEntitlementId);
  expect(nested(produced('paidBuyerEntitlement').response.body, 'entitlement')).toMatchObject({
    id: manifest.ids.paidEntitlementId,
    orderId: manifest.ids.revisedOrderId,
    active: true,
    revokedAt: null,
  });
  const paidRows = object(produced('paidBuyerEntitlements').response.body).entitlements;
  expect(Array.isArray(paidRows)).toBe(true);
  expect((paidRows as unknown[]).filter((row) => object(row).orderId === manifest.ids.revisedOrderId)).toHaveLength(1);

  const refund = produced('refundWebhook');
  const refundReplay = produced('refundWebhookReplay');
  expect(refund.response.status).toBe(200);
  expect(refund.command.kind).toBe('signed-fake-stripe-event');
  if (refund.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed refund event');
  expect(refund.command.event.type).toBe('refund.created');
  expect(refundReplay.command.kind).toBe('signed-fake-stripe-event');
  if (refundReplay.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed refund replay');
  expect(refundReplay.command.replayOf).toBe(refund.command.event.id);
  expect(refundReplay.response.status).toBe(200);

  expect(nested(produced('refundedOrderDetail').response.body, 'order')).toMatchObject({
    id: manifest.ids.revisedOrderId,
    settlement: 'paid',
    entitlementId: manifest.ids.paidEntitlementId,
  });
  const refundedBenefit = nested(produced('refundedBuyerEntitlement').response.body, 'entitlement');
  expect(refundedBenefit).toMatchObject({
    id: manifest.ids.paidEntitlementId,
    orderId: manifest.ids.revisedOrderId,
    active: false,
    revokeReason: 'refund',
  });
  expect(refundedBenefit.revokedAt).toBeTruthy();
});

test('failed delivery and current own-versus-other disclosure stay tied to native reads', () => {
  const manifest = fixture.manifest;
  const failedPending = nested(produced('failedPendingOrderDetail').response.body, 'order');
  expect(failedPending).toMatchObject({ id: manifest.ids.failedOrderId, settlement: 'pending' });
  const failedEvent = produced('failedPaymentWebhook');
  const failedReplay = produced('failedPaymentWebhookReplay');
  expect(failedEvent.response.status).toBe(200);
  expect(failedEvent.command.kind).toBe('signed-fake-stripe-event');
  if (failedEvent.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed failed event');
  expect(failedEvent.command.event.type).toBe('checkout.session.async_payment_failed');
  expect(failedReplay.command.kind).toBe('signed-fake-stripe-event');
  if (failedReplay.command.kind !== 'signed-fake-stripe-event') throw new Error('Expected signed failed replay');
  expect(failedReplay.command.replayOf).toBe(failedEvent.command.event.id);
  expect(failedReplay.response.status).toBe(200);
  const failed = nested(produced('failedOrderDetail').response.body, 'order');
  expect(failed).toMatchObject({ id: manifest.ids.failedOrderId, settlement: 'failed', entitlementId: null });
  const failedEntitlements = object(produced('failedBuyerEntitlements').response.body).entitlements;
  expect(Array.isArray(failedEntitlements)).toBe(true);
  expect((failedEntitlements as unknown[]).some((row) => object(row).orderId === manifest.ids.failedOrderId)).toBe(false);

  expect(produced('currentBuyerOrder').response.status).toBe(200);
  expect(nested(produced('currentBuyerOrder').response.body, 'order')).toMatchObject({
    id: manifest.ids.revisedOrderId,
    settlement: 'paid',
  });
  expect(nested(produced('currentBuyerEntitlement').response.body, 'entitlement')).toMatchObject({
    id: manifest.ids.paidEntitlementId,
    active: false,
    revokeReason: 'refund',
  });
  for (const name of [
    'currentOtherBuyerOrder',
    'currentAnonymousOrder',
    'currentOtherBuyerEntitlement',
    'currentAnonymousEntitlement',
  ] as const) {
    const response = produced(name).response;
    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('order');
    expect(response.body).not.toHaveProperty('entitlement');
  }
});

test('repair and unavailable mappings preserve the installed boundary without inventing outcomes', () => {
  const manifest = fixture.manifest;
  expect(manifest.identity.source.revision).toMatch(/^[0-9a-f]{40}$/i);
  expect(manifest.identity.build.id).toContain(manifest.identity.source.revision);
  const request = produced('reconciliationRequest');
  expect(request.command).toMatchObject({
    kind: 'http',
    method: 'POST',
    path: `/v1/orders/${manifest.ids.reconciliationOrderId}:reconcile`,
    persona: 'bob',
    body: {},
  });
  expect(request.command.idempotencyKey).toMatch(/^"[0-9a-f-]{36}"$/i);
  const replay = manifest.outcomes.reconciliationReplay;
  if (request.response.status === 202) {
    expect(request.response.body).toEqual({ orderId: manifest.ids.reconciliationOrderId, reconciliation: 'queued' });
    expect(replay.availability).toBe('produced');
    if (replay.availability !== 'produced') throw new Error(replay.binding);
    expect(replay.command).toMatchObject({
      method: 'POST',
      path: request.command.path,
      persona: 'bob',
      body: {},
      idempotencyKey: request.command.idempotencyKey,
    });
    expect(replay.response.status).toBe(202);
    expect(replay.response.body).toEqual(request.response.body);
  } else {
    expect([401, 403, 503]).toContain(request.response.status);
    expect(replay.availability).toBe('unavailable');
    if (replay.availability !== 'unavailable') throw new Error('Unavailable native repair was reported as produced');
    expect(replay.binding).toMatch(/order\.reconcile|order:reconcile|reconcile/i);
    expect(replay.observed?.response).toEqual(request.response);
  }
  expect(nested(produced('reconciliationOrderDetailBefore').response.body, 'order')).toMatchObject({
    id: manifest.ids.reconciliationOrderId,
    settlement: 'pending',
  });
  expect(nested(produced('reconciliationOrderDetailAfter').response.body, 'order')).toMatchObject({
    id: manifest.ids.reconciliationOrderId,
    settlement: 'pending',
  });

  for (const name of [
    'contentBenefitCurrentBuyer',
    'contentUseCurrentBuyer',
    'contentUseCurrentOtherBuyer',
    'contentUseCurrentAnonymous',
    'unknownHistoricalMoney',
    'unknownSettlement',
    'accessUnavailable',
    'accessRefresh',
    'accessDeniedCurrentUse',
    'repairUncertain',
  ] as const) {
    const outcome = manifest.outcomes[name];
    expect(outcome.availability).toBe('unavailable');
    if (outcome.availability !== 'unavailable') throw new Error(`${name} must not be fabricated`);
    expect(outcome.binding.length).toBeGreaterThan(15);
  }

  for (const outcome of Object.values(manifest.outcomes)) {
    if (outcome.availability !== 'produced') continue;
    expect(outcome.response.method.length).toBeGreaterThan(0);
    expect(outcome.response.path.startsWith('/')).toBe(true);
    expect(outcome.response.persona.length).toBeGreaterThan(0);
    expect(typeof outcome.response.status).toBe('number');
    expect(rawJson(outcome)).toEqual(outcome.response.body);
    expect(Object.keys(outcome.response.headers).every((header) =>
      ['cache-control', 'content-type', 'retry-after', 'vary', 'www-authenticate'].includes(header),
    )).toBe(true);
  }
  const exported = JSON.stringify(manifest);
  expect(exported).not.toContain('stripe-signature');
  expect(exported).not.toContain('webhookSecret');
  expect(exported).not.toContain('authorization');
  expect(exported).not.toContain('set-cookie');
});
