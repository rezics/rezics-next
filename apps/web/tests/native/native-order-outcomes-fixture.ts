import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  startNativePurchasesFixture,
  type NativePurchasesFixture,
} from './native-purchases-fixture.ts';

export type NativeOrderOutcomeName =
  | 'initialPublicOfferReview'
  | 'initialSellerOfferRead'
  | 'initialOrderSubmission'
  | 'initialOrderDetailBeforeReprice'
  | 'sellerPriceRevision'
  | 'staleBuyerSubmission'
  | 'ordersBeforeStaleSubmission'
  | 'ordersAfterStaleSubmission'
  | 'revisedPublicOfferReview'
  | 'initialOrderDetailAfterReprice'
  | 'originalOrderReplay'
  | 'ordersAfterOriginalReplay'
  | 'originalKeyChangedRevision'
  | 'ordersAfterChangedRevision'
  | 'revisedBuyerSubmission'
  | 'pendingOrderDetail'
  | 'pendingBuyerEntitlements'
  | 'paymentWebhook'
  | 'paymentWebhookReplay'
  | 'paidOrderDetail'
  | 'paidBuyerEntitlement'
  | 'paidBuyerEntitlements'
  | 'refundWebhook'
  | 'refundWebhookReplay'
  | 'refundedOrderDetail'
  | 'refundedBuyerEntitlement'
  | 'currentBuyerOrder'
  | 'currentOtherBuyerOrder'
  | 'currentAnonymousOrder'
  | 'currentBuyerEntitlement'
  | 'currentOtherBuyerEntitlement'
  | 'currentAnonymousEntitlement'
  | 'failedPublicOfferReview'
  | 'failedOrderSubmission'
  | 'failedPendingOrderDetail'
  | 'failedPaymentWebhook'
  | 'failedPaymentWebhookReplay'
  | 'failedOrderDetail'
  | 'failedBuyerEntitlements'
  | 'reconciliationPublicOfferReview'
  | 'reconciliationOrderSubmission'
  | 'reconciliationOrderDetailBefore'
  | 'reconciliationBuyerEntitlements'
  | 'reconciliationRequest'
  | 'reconciliationReplay'
  | 'reconciliationOrderDetailAfter'
  | 'contentBenefitCurrentBuyer'
  | 'contentUseCurrentBuyer'
  | 'contentUseCurrentOtherBuyer'
  | 'contentUseCurrentAnonymous'
  | 'unknownHistoricalMoney'
  | 'unknownSettlement'
  | 'accessUnavailable'
  | 'accessRefresh'
  | 'accessDeniedCurrentUse'
  | 'repairUncertain';

export type NativeResponseFact = Readonly<{
  method: string;
  path: string;
  persona: string;
  status: number;
  body: unknown;
  bodyText: string;
  headers: Readonly<Record<string, string>>;
}>;

export type NativeHttpCommand = Readonly<{
  kind: 'http';
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  persona: 'alice' | 'bob' | 'anonymous';
  body?: unknown;
  idempotencyKey?: string;
}>;

export type NativeStripeEventCommand = Readonly<{
  kind: 'signed-fake-stripe-event';
  method: 'POST';
  path: '/v1/webhooks/stripe';
  persona: 'fake-stripe';
  event: Readonly<{ id: string; type: string; objectId: string }>;
  replayOf?: string;
}>;

export type NativeProducedOutcome = Readonly<{
  availability: 'produced';
  command: NativeHttpCommand | NativeStripeEventCommand;
  response: NativeResponseFact;
  pollAttempts?: number;
}>;

export type NativeUnavailableOutcome = Readonly<{
  availability: 'unavailable';
  binding: string;
  observed?: Readonly<{
    command: NativeHttpCommand | NativeStripeEventCommand;
    response: NativeResponseFact;
  }>;
}>;

export type NativeOrderOutcome = NativeProducedOutcome | NativeUnavailableOutcome;

export type NativeOrderOutcomeManifest = Readonly<{
  identity: Readonly<{
    source: Readonly<{ repository: 'rezics'; revision: string }>;
    build: Readonly<{ id: string; runtime: 'Bun'; runtimeVersion: string }>;
  }>;
  ids: Readonly<{
    offerId: string;
    targetSubjectId: string;
    initialOrderId: string;
    revisedOrderId: string;
    revisedProviderSessionId: string;
    paidEntitlementId: string;
    failedOrderId: string;
    failedProviderSessionId: string;
    reconciliationOrderId: string;
    reconciliationProviderSessionId: string;
  }>;
  sequence: readonly NativeOrderSequenceStep[];
  outcomes: Readonly<Record<NativeOrderOutcomeName, NativeOrderOutcome>>;
  observations: Readonly<{
    staleProviderRequestCountBefore: number;
    staleProviderRequestCountAfter: number;
    staleOrderIdsBefore: readonly string[];
    staleOrderIdsAfter: readonly string[];
    replayProviderRequestCountBefore: number;
    replayProviderRequestCountAfter: number;
    replayOrderIdsBefore: readonly string[];
    replayOrderIdsAfter: readonly string[];
    changedRevisionProviderRequestCountBefore: number;
    changedRevisionProviderRequestCountAfter: number;
    changedRevisionOrderIdsBefore: readonly string[];
    changedRevisionOrderIdsAfter: readonly string[];
  }>;
  limits: readonly string[];
}>;

export type NativeOrderSequenceStep =
  | Readonly<{ kind: 'fixture'; name: 'startNativePurchasesFixture' }>
  | Readonly<{ kind: 'outcome'; name: NativeOrderOutcomeName }>
  | Readonly<{
      kind: 'provider-command';
      name: 'pay' | 'fail-payment' | 'refund-remaining';
      sessionId: string;
    }>;

export type NativeOrderOutcomesFixture = Readonly<{
  manifest: NativeOrderOutcomeManifest;
  close(): Promise<void>;
}>;

type Persona = NativeHttpCommand['persona'];
type OutcomeMap = Record<NativeOrderOutcomeName, NativeOrderOutcome>;
type RequestTemplate = Omit<NativeHttpCommand, 'kind'>;
type FakeStripeEvent = Awaited<ReturnType<NativePurchasesFixture['stripe']['event']>>;

const responseHeaderAllowlist = [
  'cache-control',
  'content-type',
  'retry-after',
  'vary',
  'www-authenticate',
] as const;

function structuredKey(): string {
  return JSON.stringify(randomUUID());
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const record = object(value);
  if (!record) throw new Error(`${label} was not an object`);
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} was not a non-empty string`);
  return value;
}

function nestedRecord(value: unknown, key: string, label: string): Record<string, unknown> {
  return requiredRecord(requiredRecord(value, label)[key], `${label}.${key}`);
}

function fieldString(value: unknown, key: string, label: string): string {
  return requiredString(requiredRecord(value, label)[key], `${label}.${key}`);
}

function fieldNumber(value: unknown, key: string, label: string): number {
  const field = requiredRecord(value, label)[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`${label}.${key} was not an integer`);
  return field;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function responseFact(
  response: Response,
  command: Pick<NativeHttpCommand | NativeStripeEventCommand, 'method' | 'path' | 'persona'>,
): Promise<NativeResponseFact> {
  const bodyText = await response.text();
  const headers: Record<string, string> = {};
  for (const name of responseHeaderAllowlist) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return {
    method: command.method,
    path: command.path,
    persona: command.persona,
    status: response.status,
    body: parseBody(bodyText),
    bodyText,
    headers,
  };
}

function requireStatus(outcome: NativeProducedOutcome, status: number, label: string): void {
  if (outcome.response.status === status) return;
  throw new Error(`${label} returned ${outcome.response.status}: ${outcome.response.bodyText}`);
}

async function httpOutcome(
  purchases: NativePurchasesFixture,
  template: RequestTemplate,
): Promise<NativeProducedOutcome> {
  const headers = new Headers();
  if (template.body !== undefined) headers.set('content-type', 'application/json');
  if (template.idempotencyKey !== undefined) headers.set('idempotency-key', template.idempotencyKey);
  const response = await purchases.stack.kernel(
    template.path,
    {
      method: template.method,
      headers,
      ...(template.body === undefined ? {} : { body: JSON.stringify(template.body) }),
    },
    template.persona === 'anonymous' ? undefined : template.persona,
  );
  const command: NativeHttpCommand = { kind: 'http', ...template };
  return { availability: 'produced', command, response: await responseFact(response, command) };
}

function eventId(event: FakeStripeEvent): string {
  const body = requiredRecord(JSON.parse(new TextDecoder().decode(event.bytes)) as unknown, 'Stripe event body');
  return fieldString(body, 'id', 'Stripe event body');
}

async function eventOutcome(
  purchases: NativePurchasesFixture,
  event: FakeStripeEvent,
  type: string,
  objectId: string,
  replayOf?: string,
): Promise<NativeProducedOutcome> {
  const command: NativeStripeEventCommand = {
    kind: 'signed-fake-stripe-event',
    method: 'POST',
    path: '/v1/webhooks/stripe',
    persona: 'fake-stripe',
    event: { id: eventId(event), type, objectId },
    ...(replayOf === undefined ? {} : { replayOf }),
  };
  const response = await purchases.deliver(event);
  return { availability: 'produced', command, response: await responseFact(response, command) };
}

function responseOrderId(outcome: NativeProducedOutcome, label: string): string {
  return fieldString(nestedRecord(outcome.response.body, 'order', label), 'id', `${label}.order`);
}

function listOrderIds(outcome: NativeProducedOutcome, label: string): string[] {
  const rows = requiredRecord(outcome.response.body, label).orders;
  if (!Array.isArray(rows)) throw new Error(`${label}.orders was not an array`);
  return rows.map((row, index) => fieldString(row, 'id', `${label}.orders[${index}]`));
}

function providerSessionId(purchases: NativePurchasesFixture, orderId: string): string {
  const session = [...purchases.stripe.sessions.values()].find((candidate) => candidate.client_reference_id === orderId);
  if (!session) throw new Error(`Fake Stripe has no actual Session associated with native order ${orderId}`);
  return session.id;
}

function setOutcome(
  outcomes: OutcomeMap,
  sequence: NativeOrderSequenceStep[],
  name: NativeOrderOutcomeName,
  outcome: NativeOutcome,
): void {
  outcomes[name] = outcome;
  sequence.push({ kind: 'outcome', name });
}

type NativeOutcome = NativeOrderOutcome & { pollAttempts?: number };

function unavailable(binding: string, observed?: NativeUnavailableOutcome['observed']): NativeUnavailableOutcome {
  return { availability: 'unavailable', binding, ...(observed === undefined ? {} : { observed }) };
}

async function boundedOrderRead(
  purchases: NativePurchasesFixture,
  orderId: string,
  persona: Exclude<Persona, 'anonymous'>,
  expectedSettlement: 'paid' | 'failed',
  binding: string,
): Promise<NativeOutcome> {
  const command: NativeHttpCommand = {
    kind: 'http',
    method: 'GET',
    path: `/v1/orders/${orderId}`,
    persona,
  };
  let latest: NativeResponseFact | undefined;
  const deadline = Date.now() + 30_000;
  let attempts = 0;
  do {
    attempts++;
    const response = await purchases.stack.kernel(command.path, {}, persona);
    latest = await responseFact(response, command);
    if (latest.status === 200 && fieldString(nestedRecord(latest.body, 'order', 'native order response'), 'settlement', 'native order response.order') === expectedSettlement)
      return { availability: 'produced', command, response: latest, pollAttempts: attempts };
    if (Date.now() < deadline) await Bun.sleep(50);
  } while (Date.now() < deadline);
  return unavailable(`${binding}; actual native GET did not reach ${expectedSettlement} within 30 seconds`, {
    command,
    response: latest!,
  });
}

async function boundedEntitlementRead(
  purchases: NativePurchasesFixture,
  entitlementId: string,
  persona: Exclude<Persona, 'anonymous'>,
  active: boolean,
  binding: string,
): Promise<NativeOutcome> {
  const command: NativeHttpCommand = {
    kind: 'http',
    method: 'GET',
    path: `/v1/entitlements/${entitlementId}`,
    persona,
  };
  let latest: NativeResponseFact | undefined;
  const deadline = Date.now() + 30_000;
  let attempts = 0;
  do {
    attempts++;
    const response = await purchases.stack.kernel(command.path, {}, persona);
    latest = await responseFact(response, command);
    if (latest.status === 200) {
      const entitlement = nestedRecord(latest.body, 'entitlement', 'native entitlement response');
      if (entitlement.active === active)
        return { availability: 'produced', command, response: latest, pollAttempts: attempts };
    }
    if (Date.now() < deadline) await Bun.sleep(50);
  } while (Date.now() < deadline);
  return unavailable(`${binding}; actual native GET did not report active=${active} within 30 seconds`, {
    command,
    response: latest!,
  });
}

async function captureWorldIdentity() {
  const root = resolve(import.meta.dir, '../../../..');
  const result = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: root });
  if (result.exitCode !== 0) throw new Error(`Unable to read native fixture source revision: ${result.stderr.toString()}`);
  const revision = result.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`Invalid native fixture source revision: ${revision}`);
  return {
    source: { repository: 'rezics' as const, revision },
    build: { id: `native-production-web-worker:${revision}`, runtime: 'Bun' as const, runtimeVersion: Bun.version },
  };
}

function listRead(persona: 'alice' | 'bob'): RequestTemplate {
  return { method: 'GET', path: '/v1/orders', persona };
}

async function ordersRead(
  purchases: NativePurchasesFixture,
  persona: 'alice' | 'bob',
): Promise<NativeProducedOutcome> {
  return httpOutcome(purchases, listRead(persona));
}

export async function startNativeOrderOutcomesFixture(): Promise<NativeOrderOutcomesFixture> {
  const identity = await captureWorldIdentity();
  const sequence: NativeOrderSequenceStep[] = [];
  const outcomes = {} as OutcomeMap;
  const observations = {
    staleProviderRequestCountBefore: 0,
    staleProviderRequestCountAfter: 0,
    staleOrderIdsBefore: [] as string[],
    staleOrderIdsAfter: [] as string[],
    replayProviderRequestCountBefore: 0,
    replayProviderRequestCountAfter: 0,
    replayOrderIdsBefore: [] as string[],
    replayOrderIdsAfter: [] as string[],
    changedRevisionProviderRequestCountBefore: 0,
    changedRevisionProviderRequestCountAfter: 0,
    changedRevisionOrderIdsBefore: [] as string[],
    changedRevisionOrderIdsAfter: [] as string[],
  };
  const changedTerms = await startNativePurchasesFixture();
  sequence.push({ kind: 'fixture', name: 'startNativePurchasesFixture' });
  try {
    const offerId = changedTerms.offer.id;
    const publicPath = `/v1/offers/${offerId}`;
    const publicReview = await httpOutcome(changedTerms, {
      method: 'GET',
      path: publicPath,
      persona: 'anonymous',
    });
    setOutcome(outcomes, sequence, 'initialPublicOfferReview', publicReview);
    requireStatus(publicReview, 200, 'Initial public offer review');
    const reviewedOffer = nestedRecord(publicReview.response.body, 'offer', 'Initial public offer response');
    const initialRevision = fieldNumber(reviewedOffer, 'revision', 'Initial public offer response.offer');

    const privateReview = await httpOutcome(changedTerms, {
      method: 'GET',
      path: publicPath,
      persona: 'alice',
    });
    setOutcome(outcomes, sequence, 'initialSellerOfferRead', privateReview);
    requireStatus(privateReview, 200, 'Initial seller offer read');
    const privateOffer = nestedRecord(privateReview.response.body, 'offer', 'Initial seller offer response');
    const privateRevision = fieldNumber(privateOffer, 'revision', 'Initial seller offer response.offer');

    const initialOrderKey = structuredKey();
    const initialOrderBody = { offerId, expectedOfferRevision: initialRevision };
    const initialOrder = await httpOutcome(changedTerms, {
      method: 'POST',
      path: '/v1/orders',
      persona: 'bob',
      body: initialOrderBody,
      idempotencyKey: initialOrderKey,
    });
    setOutcome(outcomes, sequence, 'initialOrderSubmission', initialOrder);
    requireStatus(initialOrder, 201, 'Initial buyer order submission');
    const initialOrderId = responseOrderId(initialOrder, 'Initial buyer order submission');

    const initialDetailBefore = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${initialOrderId}`,
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'initialOrderDetailBeforeReprice', initialDetailBefore);
    requireStatus(initialDetailBefore, 200, 'Initial order detail before repricing');

    const priceRevisionKey = structuredKey();
    const revisedPrice = 2400;
    const sellerPriceRevision = await httpOutcome(changedTerms, {
      method: 'PATCH',
      path: publicPath,
      persona: 'alice',
      body: { expectedRevision: privateRevision, unitAmountMinor: revisedPrice },
      idempotencyKey: priceRevisionKey,
    });
    setOutcome(outcomes, sequence, 'sellerPriceRevision', sellerPriceRevision);
    requireStatus(sellerPriceRevision, 200, 'Seller price revision');

    const staleBuyerKey = structuredKey();
    const staleProviderBefore = changedTerms.stripe.requests.length;
    const staleOrdersBefore = await ordersRead(changedTerms, 'bob');
    setOutcome(outcomes, sequence, 'ordersBeforeStaleSubmission', staleOrdersBefore);
    requireStatus(staleOrdersBefore, 200, 'Buyer order list before stale submission');
    observations.staleOrderIdsBefore = listOrderIds(staleOrdersBefore, 'Orders before stale submission');
    observations.staleProviderRequestCountBefore = staleProviderBefore;

    const staleSubmission = await httpOutcome(changedTerms, {
      method: 'POST',
      path: '/v1/orders',
      persona: 'bob',
      body: { offerId, expectedOfferRevision: initialRevision },
      idempotencyKey: staleBuyerKey,
    });
    setOutcome(outcomes, sequence, 'staleBuyerSubmission', staleSubmission);

    const staleOrdersAfter = await ordersRead(changedTerms, 'bob');
    setOutcome(outcomes, sequence, 'ordersAfterStaleSubmission', staleOrdersAfter);
    requireStatus(staleOrdersAfter, 200, 'Buyer order list after stale submission');
    observations.staleOrderIdsAfter = listOrderIds(staleOrdersAfter, 'Orders after stale submission');
    observations.staleProviderRequestCountAfter = changedTerms.stripe.requests.length;

    const revisedPublicReview = await httpOutcome(changedTerms, {
      method: 'GET',
      path: publicPath,
      persona: 'anonymous',
    });
    setOutcome(outcomes, sequence, 'revisedPublicOfferReview', revisedPublicReview);
    requireStatus(revisedPublicReview, 200, 'Revised public offer review');
    const revisedOffer = nestedRecord(revisedPublicReview.response.body, 'offer', 'Revised public offer response');
    const revisedRevision = fieldNumber(revisedOffer, 'revision', 'Revised public offer response.offer');

    const initialDetailAfter = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${initialOrderId}`,
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'initialOrderDetailAfterReprice', initialDetailAfter);
    requireStatus(initialDetailAfter, 200, 'Initial order detail after repricing');

    const replayProviderBefore = changedTerms.stripe.requests.length;
    const replayOrdersBefore = await ordersRead(changedTerms, 'bob');
    requireStatus(replayOrdersBefore, 200, 'Buyer order list before original replay');
    observations.replayOrderIdsBefore = listOrderIds(replayOrdersBefore, 'Orders before original replay');
    observations.replayProviderRequestCountBefore = replayProviderBefore;
    const originalReplay = await httpOutcome(changedTerms, {
      method: 'POST',
      path: '/v1/orders',
      persona: 'bob',
      body: initialOrderBody,
      idempotencyKey: initialOrderKey,
    });
    setOutcome(outcomes, sequence, 'originalOrderReplay', originalReplay);
    const replayOrdersAfter = await ordersRead(changedTerms, 'bob');
    setOutcome(outcomes, sequence, 'ordersAfterOriginalReplay', replayOrdersAfter);
    requireStatus(replayOrdersAfter, 200, 'Buyer order list after original replay');
    observations.replayOrderIdsAfter = listOrderIds(replayOrdersAfter, 'Orders after original replay');
    observations.replayProviderRequestCountAfter = changedTerms.stripe.requests.length;

    const changedRevisionProviderBefore = changedTerms.stripe.requests.length;
    const changedRevisionOrdersBefore = await ordersRead(changedTerms, 'bob');
    requireStatus(changedRevisionOrdersBefore, 200, 'Buyer order list before changed-revision replay');
    observations.changedRevisionOrderIdsBefore = listOrderIds(
      changedRevisionOrdersBefore,
      'Orders before changed-revision replay',
    );
    observations.changedRevisionProviderRequestCountBefore = changedRevisionProviderBefore;
    const changedRevisionReplay = await httpOutcome(changedTerms, {
      method: 'POST',
      path: '/v1/orders',
      persona: 'bob',
      body: { offerId, expectedOfferRevision: revisedRevision },
      idempotencyKey: initialOrderKey,
    });
    setOutcome(outcomes, sequence, 'originalKeyChangedRevision', changedRevisionReplay);
    const changedRevisionOrdersAfter = await ordersRead(changedTerms, 'bob');
    setOutcome(outcomes, sequence, 'ordersAfterChangedRevision', changedRevisionOrdersAfter);
    requireStatus(changedRevisionOrdersAfter, 200, 'Buyer order list after changed-revision replay');
    observations.changedRevisionOrderIdsAfter = listOrderIds(
      changedRevisionOrdersAfter,
      'Orders after changed-revision replay',
    );
    observations.changedRevisionProviderRequestCountAfter = changedTerms.stripe.requests.length;

    const revisedBuyerKey = structuredKey();
    const revisedSubmission = await httpOutcome(changedTerms, {
      method: 'POST',
      path: '/v1/orders',
      persona: 'bob',
      body: { offerId, expectedOfferRevision: revisedRevision },
      idempotencyKey: revisedBuyerKey,
    });
    setOutcome(outcomes, sequence, 'revisedBuyerSubmission', revisedSubmission);
    requireStatus(revisedSubmission, 201, 'Explicit revised buyer submission');
    const revisedOrderId = responseOrderId(revisedSubmission, 'Explicit revised buyer submission');
    const revisedSessionId = providerSessionId(changedTerms, revisedOrderId);

    const pendingOrder = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${revisedOrderId}`,
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'pendingOrderDetail', pendingOrder);
    requireStatus(pendingOrder, 200, 'Pending order detail');
    const pendingEntitlements = await httpOutcome(changedTerms, {
      method: 'GET',
      path: '/v1/entitlements',
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'pendingBuyerEntitlements', pendingEntitlements);
    requireStatus(pendingEntitlements, 200, 'Pending buyer entitlement list');

    sequence.push({ kind: 'provider-command', name: 'pay', sessionId: revisedSessionId });
    await changedTerms.stripe.pay(revisedSessionId);
    const paymentEvent = await changedTerms.stripe.event('checkout.session.completed', revisedSessionId);
    const paymentWebhook = await eventOutcome(changedTerms, paymentEvent, 'checkout.session.completed', revisedSessionId);
    setOutcome(outcomes, sequence, 'paymentWebhook', paymentWebhook);
    requireStatus(paymentWebhook, 200, 'Verified payment webhook');
    const paymentWebhookReplay = await eventOutcome(
      changedTerms,
      paymentEvent,
      'checkout.session.completed',
      revisedSessionId,
      paymentWebhook.command.kind === 'signed-fake-stripe-event' ? paymentWebhook.command.event.id : undefined,
    );
    setOutcome(outcomes, sequence, 'paymentWebhookReplay', paymentWebhookReplay);
    requireStatus(paymentWebhookReplay, 200, 'Replayed verified payment webhook');

    const paidOrder = await boundedOrderRead(
      changedTerms,
      revisedOrderId,
      'bob',
      'paid',
      'The installed signed Stripe delivery did not produce a paid order response',
    );
    setOutcome(outcomes, sequence, 'paidOrderDetail', paidOrder);
    if (paidOrder.availability !== 'produced') throw new Error(paidOrder.binding);
    const paidOrderBody = nestedRecord(paidOrder.response.body, 'order', 'Paid order response');
    const entitlementId = requiredString(paidOrderBody.entitlementId, 'Paid order response.order.entitlementId');
    const paidEntitlement = await boundedEntitlementRead(
      changedTerms,
      entitlementId,
      'bob',
      true,
      'The installed paid order did not produce an active own-entitlement response',
    );
    setOutcome(outcomes, sequence, 'paidBuyerEntitlement', paidEntitlement);
    if (paidEntitlement.availability !== 'produced') throw new Error(paidEntitlement.binding);
    const paidEntitlements = await httpOutcome(changedTerms, {
      method: 'GET',
      path: '/v1/entitlements',
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'paidBuyerEntitlements', paidEntitlements);
    requireStatus(paidEntitlements, 200, 'Paid buyer entitlement list');

    const refund = changedTerms.stripe.refundRemaining(revisedSessionId, 'remaining');
    sequence.push({ kind: 'provider-command', name: 'refund-remaining', sessionId: revisedSessionId });
    const refundEvent = await changedTerms.stripe.event('refund.created', refund.id);
    const refundWebhook = await eventOutcome(changedTerms, refundEvent, 'refund.created', refund.id);
    setOutcome(outcomes, sequence, 'refundWebhook', refundWebhook);
    requireStatus(refundWebhook, 200, 'Verified full-refund webhook');
    const refundWebhookReplay = await eventOutcome(
      changedTerms,
      refundEvent,
      'refund.created',
      refund.id,
      refundWebhook.command.kind === 'signed-fake-stripe-event' ? refundWebhook.command.event.id : undefined,
    );
    setOutcome(outcomes, sequence, 'refundWebhookReplay', refundWebhookReplay);
    requireStatus(refundWebhookReplay, 200, 'Replayed verified full-refund webhook');

    const refundedOrder = await boundedOrderRead(
      changedTerms,
      revisedOrderId,
      'bob',
      'paid',
      'The installed refund event did not preserve the recorded paid order response',
    );
    setOutcome(outcomes, sequence, 'refundedOrderDetail', refundedOrder);
    if (refundedOrder.availability !== 'produced') throw new Error(refundedOrder.binding);
    const refundedEntitlement = await boundedEntitlementRead(
      changedTerms,
      entitlementId,
      'bob',
      false,
      'The installed full-refund event did not produce a revoked current-entitlement response',
    );
    setOutcome(outcomes, sequence, 'refundedBuyerEntitlement', refundedEntitlement);
    if (refundedEntitlement.availability !== 'produced') throw new Error(refundedEntitlement.binding);

    const currentBuyerOrder = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${revisedOrderId}`,
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'currentBuyerOrder', currentBuyerOrder);
    const currentOtherBuyerOrder = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${revisedOrderId}`,
      persona: 'alice',
    });
    setOutcome(outcomes, sequence, 'currentOtherBuyerOrder', currentOtherBuyerOrder);
    const currentAnonymousOrder = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/orders/${revisedOrderId}`,
      persona: 'anonymous',
    });
    setOutcome(outcomes, sequence, 'currentAnonymousOrder', currentAnonymousOrder);
    const currentBuyerEntitlement = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/entitlements/${entitlementId}`,
      persona: 'bob',
    });
    setOutcome(outcomes, sequence, 'currentBuyerEntitlement', currentBuyerEntitlement);
    const currentOtherBuyerEntitlement = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/entitlements/${entitlementId}`,
      persona: 'alice',
    });
    setOutcome(outcomes, sequence, 'currentOtherBuyerEntitlement', currentOtherBuyerEntitlement);
    const currentAnonymousEntitlement = await httpOutcome(changedTerms, {
      method: 'GET',
      path: `/v1/entitlements/${entitlementId}`,
      persona: 'anonymous',
    });
    setOutcome(outcomes, sequence, 'currentAnonymousEntitlement', currentAnonymousEntitlement);

    const failedWorld = await startNativePurchasesFixture();
    sequence.push({ kind: 'fixture', name: 'startNativePurchasesFixture' });
    let reconciliationWorld: NativePurchasesFixture | undefined;
    try {
      const failedOffer = await httpOutcome(failedWorld, {
        method: 'GET',
        path: `/v1/offers/${failedWorld.offer.id}`,
        persona: 'anonymous',
      });
      setOutcome(outcomes, sequence, 'failedPublicOfferReview', failedOffer);
      requireStatus(failedOffer, 200, 'Failed-order public offer review');
      const failedOfferRevision = fieldNumber(
        nestedRecord(failedOffer.response.body, 'offer', 'Failed-order public offer response'),
        'revision',
        'Failed-order public offer response.offer',
      );
      const failedOrder = await httpOutcome(failedWorld, {
        method: 'POST',
        path: '/v1/orders',
        persona: 'alice',
        body: { offerId: failedWorld.offer.id, expectedOfferRevision: failedOfferRevision },
        idempotencyKey: structuredKey(),
      });
      setOutcome(outcomes, sequence, 'failedOrderSubmission', failedOrder);
      requireStatus(failedOrder, 201, 'Failed order submission');
      const failedOrderId = responseOrderId(failedOrder, 'Failed order submission');
      const failedSessionId = providerSessionId(failedWorld, failedOrderId);
      const failedPending = await httpOutcome(failedWorld, {
        method: 'GET',
        path: `/v1/orders/${failedOrderId}`,
        persona: 'alice',
      });
      setOutcome(outcomes, sequence, 'failedPendingOrderDetail', failedPending);
      requireStatus(failedPending, 200, 'Failed-order pending detail');

      sequence.push({ kind: 'provider-command', name: 'pay', sessionId: failedSessionId });
      failedWorld.stripe.pay(failedSessionId, 'async');
      sequence.push({ kind: 'provider-command', name: 'fail-payment', sessionId: failedSessionId });
      failedWorld.stripe.failPayment(failedSessionId);
      const failedEvent = await failedWorld.stripe.event('checkout.session.async_payment_failed', failedSessionId);
      const failedWebhook = await eventOutcome(
        failedWorld,
        failedEvent,
        'checkout.session.async_payment_failed',
        failedSessionId,
      );
      setOutcome(outcomes, sequence, 'failedPaymentWebhook', failedWebhook);
      requireStatus(failedWebhook, 200, 'Verified failed-payment webhook');
      const failedWebhookReplay = await eventOutcome(
        failedWorld,
        failedEvent,
        'checkout.session.async_payment_failed',
        failedSessionId,
        failedWebhook.command.kind === 'signed-fake-stripe-event' ? failedWebhook.command.event.id : undefined,
      );
      setOutcome(outcomes, sequence, 'failedPaymentWebhookReplay', failedWebhookReplay);
      requireStatus(failedWebhookReplay, 200, 'Replayed verified failed-payment webhook');
      const failedDetail = await boundedOrderRead(
        failedWorld,
        failedOrderId,
        'alice',
        'failed',
        'The installed signed Stripe delivery did not produce a failed order response',
      );
      setOutcome(outcomes, sequence, 'failedOrderDetail', failedDetail);
      if (failedDetail.availability !== 'produced') throw new Error(failedDetail.binding);
      const failedEntitlements = await httpOutcome(failedWorld, {
        method: 'GET',
        path: '/v1/entitlements',
        persona: 'alice',
      });
      setOutcome(outcomes, sequence, 'failedBuyerEntitlements', failedEntitlements);
      requireStatus(failedEntitlements, 200, 'Failed buyer entitlement list');

      reconciliationWorld = await startNativePurchasesFixture();
      sequence.push({ kind: 'fixture', name: 'startNativePurchasesFixture' });
      const reconcileOffer = await httpOutcome(reconciliationWorld, {
        method: 'GET',
        path: `/v1/offers/${reconciliationWorld.offer.id}`,
        persona: 'anonymous',
      });
      setOutcome(outcomes, sequence, 'reconciliationPublicOfferReview', reconcileOffer);
      requireStatus(reconcileOffer, 200, 'Reconciliation-order public offer review');
      const reconcileRevision = fieldNumber(
        nestedRecord(reconcileOffer.response.body, 'offer', 'Reconciliation public offer response'),
        'revision',
        'Reconciliation public offer response.offer',
      );
      const reconcileSubmission = await httpOutcome(reconciliationWorld, {
        method: 'POST',
        path: '/v1/orders',
        persona: 'bob',
        body: { offerId: reconciliationWorld.offer.id, expectedOfferRevision: reconcileRevision },
        idempotencyKey: structuredKey(),
      });
      setOutcome(outcomes, sequence, 'reconciliationOrderSubmission', reconcileSubmission);
      requireStatus(reconcileSubmission, 201, 'Reconciliation order submission');
      const reconciliationOrderId = responseOrderId(reconcileSubmission, 'Reconciliation order submission');
      const reconciliationSessionId = providerSessionId(reconciliationWorld, reconciliationOrderId);
      const reconciliationBefore = await httpOutcome(reconciliationWorld, {
        method: 'GET',
        path: `/v1/orders/${reconciliationOrderId}`,
        persona: 'bob',
      });
      setOutcome(outcomes, sequence, 'reconciliationOrderDetailBefore', reconciliationBefore);
      requireStatus(reconciliationBefore, 200, 'Reconciliation order detail before repair');
      const reconciliationEntitlements = await httpOutcome(reconciliationWorld, {
        method: 'GET',
        path: '/v1/entitlements',
        persona: 'bob',
      });
      setOutcome(outcomes, sequence, 'reconciliationBuyerEntitlements', reconciliationEntitlements);
      requireStatus(reconciliationEntitlements, 200, 'Reconciliation buyer entitlement list');
      const reconciliationKey = structuredKey();
      const reconciliationRequest = await httpOutcome(reconciliationWorld, {
        method: 'POST',
        path: `/v1/orders/${reconciliationOrderId}:reconcile`,
        persona: 'bob',
        body: {},
        idempotencyKey: reconciliationKey,
      });
      setOutcome(outcomes, sequence, 'reconciliationRequest', reconciliationRequest);
      let reconciliationReplay: NativeOutcome;
      if (reconciliationRequest.response.status === 202) {
        const reconciliationBody = requiredRecord(reconciliationRequest.response.body, 'Reconciliation response');
        if (
          reconciliationBody.orderId !== reconciliationOrderId ||
          reconciliationBody.reconciliation !== 'queued'
        )
          throw new Error(`Native reconciliation returned an unexpected queued response: ${reconciliationRequest.response.bodyText}`);
        reconciliationReplay = await httpOutcome(reconciliationWorld, {
          method: 'POST',
          path: `/v1/orders/${reconciliationOrderId}:reconcile`,
          persona: 'bob',
          body: {},
          idempotencyKey: reconciliationKey,
        });
        if (reconciliationReplay.response.status !== 202)
          throw new Error(`Native reconciliation replay returned ${reconciliationReplay.response.status}: ${reconciliationReplay.response.bodyText}`);
        setOutcome(outcomes, sequence, 'reconciliationReplay', reconciliationReplay);
      } else if ([401, 403, 503].includes(reconciliationRequest.response.status)) {
        const binding =
          reconciliationRequest.response.status === 403
            ? 'The native Kernel order.reconcile route returned forbidden for the installed NativeWebStack bearer; no admitted order:reconcile credential is exposed by this fixture.'
            : reconciliationRequest.response.status === 401
              ? 'The native Kernel order.reconcile route returned unauthorized; NativeWebStack exposes no authenticated order:reconcile credential for this buyer.'
              : `The installed POST /v1/orders/:orderId:reconcile returned 503: ${reconciliationRequest.response.bodyText}`;
        reconciliationReplay = unavailable(binding, {
          command: reconciliationRequest.command,
          response: reconciliationRequest.response,
        });
        setOutcome(outcomes, sequence, 'reconciliationReplay', reconciliationReplay);
      } else {
        throw new Error(
          `Native order.reconcile returned an unexpected status ${reconciliationRequest.response.status}: ${reconciliationRequest.response.bodyText}`,
        );
      }
      const reconciliationAfter = await httpOutcome(reconciliationWorld, {
        method: 'GET',
        path: `/v1/orders/${reconciliationOrderId}`,
        persona: 'bob',
      });
      setOutcome(outcomes, sequence, 'reconciliationOrderDetailAfter', reconciliationAfter);
      requireStatus(reconciliationAfter, 200, 'Reconciliation order detail after repair request');

      const unsupported: Partial<Record<NativeOrderOutcomeName, string>> = {
        contentBenefitCurrentBuyer:
          'The mounted native fixture publishes Content editions, but no Commerce-to-Content current-benefit response interface is exposed by NativeWebStack.',
        contentUseCurrentBuyer:
          'No installed native Content current-use response is exposed for a Commerce entitlement; an entitlement read is not a use decision.',
        contentUseCurrentOtherBuyer:
          'No installed native Content current-use response is exposed for an other-buyer persona.',
        contentUseCurrentAnonymous:
          'No installed native Content current-use response is exposed for an anonymous persona.',
        unknownHistoricalMoney:
          'No installed native producer creates an order with unknown historical money; the fixture creates only current known-price orders.',
        unknownSettlement:
          'No installed native producer in this fixture creates an unknown-settlement order from a lost Checkout creation response.',
        accessUnavailable:
          'No installed native Commerce-to-Content current-access producer exposes an unavailable access response.',
        accessRefresh:
          'No installed native Commerce-to-Content current-access producer exposes a refresh response.',
        accessDeniedCurrentUse:
          'No installed native Content current-use response exposes denied use; Commerce disclosure denials are captured separately.',
        repairUncertain:
          'No installed native producer exposes an uncertain repair result; the mounted order.reconcile command returns a concrete queued, denied or unavailable response.',
      };
      for (const [name, binding] of Object.entries(unsupported) as [NativeOrderOutcomeName, string][]) {
        outcomes[name] = unavailable(binding);
      }

      const manifest: NativeOrderOutcomeManifest = {
        identity,
        ids: {
          offerId,
          targetSubjectId: changedTerms.offer.subjectId,
          initialOrderId,
          revisedOrderId,
          revisedProviderSessionId: revisedSessionId,
          paidEntitlementId: entitlementId,
          failedOrderId,
          failedProviderSessionId: failedSessionId,
          reconciliationOrderId,
          reconciliationProviderSessionId: reconciliationSessionId,
        },
        sequence,
        outcomes,
        observations,
        limits: [
          'The native sequence records API responses and provider events; it does not prove that Web required a deliberate review gesture before submission.',
          'No response body is enriched from fake provider state. Provider Session IDs appear only as correlation facts used to deliver signed events.',
          'The native response sequence is not rendered page proof; Web owns runtime story IDs, interaction evidence and screenshots.',
        ],
      };
      return {
        manifest,
        async close() {
          const errors: unknown[] = [];
          for (const purchases of [reconciliationWorld, failedWorld, changedTerms]) {
            try {
              await purchases?.close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length) throw new AggregateError(errors, 'Native order outcomes fixture cleanup failed');
        },
      };
    } catch (error) {
      try {
        await reconciliationWorld?.close();
      } catch {}
      try {
        await failedWorld.close();
      } catch {}
      throw error;
    }
  } catch (error) {
    try {
      await changedTerms.close();
    } catch {}
    throw error;
  }
}
