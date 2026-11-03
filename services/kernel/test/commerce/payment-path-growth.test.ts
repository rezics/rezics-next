import { DBOS } from '@dbos-inc/dbos-sdk';
import { expect, test } from 'bun:test';
import Stripe from 'stripe';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import type { Order, StripeEventRef } from '../../src/commerce/model.ts';
import { STRIPE_EVENT_WORKFLOW, WORKFLOWS_QUEUE } from '../../src/commerce/work-contract.ts';
import { stripeWebhookRoutes } from '../../src/commerce/webhook-routes.ts';
import { createApp } from '../../src/http/app.ts';
import { declareKernelWriteRates } from '../../src/http/write-rate-routes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { WORK_APPLICATION, createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { checkGrowth, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';
import { nativeAnchorFixture, type NativeAnchorFixture } from './support/checkout-anchor.ts';
import { observeProviderBytes, type ProviderByteObserver } from './support/provider-byte-observation.ts';

const scales = [1, 8, 64] as const;
const axes = ['unrelated orders', 'provider events', 'receipts', 'DBOS workflow history'] as const;
type GrowthAxis = (typeof axes)[number];
type Operation = (db: GrowthDatabase, scale: number, repetition: number) => Promise<unknown>;

async function growUnrelatedOrders(db: GrowthDatabase, anchor: Order, from: number, to: number) {
  if (from === to) return;
  const route = routeOf(anchor.id);
  if (route === null) throw new Error('Growth anchor order has no route');
  const createdAt = new Date().toISOString();
  const rows = Array.from({ length: to - from }, () => ({
    route,
    order_id: newId(route),
    buyer_account_id: anchor.buyerAccountId,
    offer_id: anchor.offerId,
    offer_revision: anchor.offerRevision,
    creator_account_id: anchor.creatorAccountId,
    title: anchor.title,
    currency: anchor.currency,
    unit_amount_minor: anchor.unitAmountMinor,
    tax_code: anchor.taxCode,
    royalty_basis_points: anchor.royaltyBasisPoints,
    settlement: 'pending',
    checkout_session_id: null,
    checkout_url: null,
    checkout_expires_at: null,
    payment_intent_id: null,
    observed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    revision: 1,
    transaction_id: crypto.randomUUID(),
    amount_tax_minor: null,
    target_subject_id: anchor.targetSubjectId,
  }));
  await db.admin.query(
    `INSERT INTO commerce.purchase_order (
       route, order_id, buyer_account_id, offer_id, offer_revision, creator_account_id, title,
       currency, unit_amount_minor, tax_code, royalty_basis_points, settlement, checkout_session_id,
       checkout_url, checkout_expires_at, payment_intent_id, observed_at, created_at, updated_at,
       revision, transaction_id, amount_tax_minor, target_subject_id
     )
     SELECT route, order_id, buyer_account_id, offer_id, offer_revision, creator_account_id, title,
       currency, unit_amount_minor, tax_code, royalty_basis_points, settlement, checkout_session_id,
       checkout_url, checkout_expires_at, payment_intent_id, observed_at, created_at, updated_at,
       revision, transaction_id, amount_tax_minor, target_subject_id
     FROM jsonb_to_recordset($1::jsonb) AS x(
       route int, order_id uuid, buyer_account_id uuid, offer_id uuid, offer_revision int,
       creator_account_id uuid, title text, currency text, unit_amount_minor bigint, tax_code text,
       royalty_basis_points int, settlement text, checkout_session_id text, checkout_url text,
       checkout_expires_at timestamptz, payment_intent_id text, observed_at timestamptz,
       created_at timestamptz, updated_at timestamptz, revision int, transaction_id uuid,
       amount_tax_minor bigint, target_subject_id uuid
     )`,
    [JSON.stringify(rows)],
  );
}

async function growReceipts(db: GrowthDatabase, prefix: string, principalId: string, from: number, to: number) {
  if (from === to) return;
  const rows = Array.from({ length: to - from }, (_, offset) => ({
    idempotency_key: `payment-path-growth:${prefix}:${from + offset}`,
    transaction_id: crypto.randomUUID(),
    position: from + offset + 1,
  }));
  const route = routeOf(principalId);
  if (route === null) throw new Error('Receipt principal has no route');
  await db.admin.query(
    `INSERT INTO core.receipt (
       partition_no, principal_kind, principal_id, command_kind, idempotency_key,
       request_digest, epoch, position, transaction_id, response
     )
     SELECT $2, 'account', $3, 'commerce.paymentPathGrowth', idempotency_key,
       decode(repeat('00', 32), 'hex'), 1, position, transaction_id, '{}'::jsonb
     FROM jsonb_to_recordset($1::jsonb) AS x(idempotency_key text, transaction_id uuid, position bigint)`,
    [JSON.stringify(rows), route >>> 4, principalId],
  );
}

async function growWorkflowRows(db: GrowthDatabase, prefix: string, from: number, to: number, providerEvents: boolean) {
  if (from === to) return;
  const now = Date.now();
  const rows = Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset;
    const eventId = `evt_growth_${prefix}_${index}`;
    const ref: StripeEventRef = {
      eventId,
      type: 'checkout.session.completed',
      created: Math.floor(now / 1000),
      livemode: false,
      sessionId: null,
      paymentIntentId: null,
    };
    return {
      workflow_uuid: providerEvents ? `stripe:${eventId}` : `history:payment-path:${prefix}:${index}`,
      workflow_name: providerEvents ? STRIPE_EVENT_WORKFLOW : 'commerce.paymentPathGrowthHistory',
      inputs: JSON.stringify({ positionalArgs: providerEvents ? [ref] : [], namedArgs: {} }),
      created_ms: now + offset,
    };
  });
  await db.admin.query(
    `WITH seeds AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         workflow_uuid text, workflow_name text, inputs text, created_ms bigint
       )
     ), status_rows AS (
       INSERT INTO dbos.workflow_status (
         workflow_uuid, status, name, queue_name, application_name, serialization,
         created_at, updated_at, completed_at
       )
       SELECT workflow_uuid, 'SUCCESS', workflow_name, $2, $3, 'portable_json', created_ms, created_ms, created_ms
       FROM seeds
       RETURNING workflow_uuid, completed_at
     ), input_rows AS (
       INSERT INTO dbos.workflow_input (workflow_uuid, inputs, retention_timestamp)
       SELECT s.workflow_uuid, seeds.inputs, s.completed_at
       FROM status_rows s JOIN seeds USING (workflow_uuid)
       RETURNING workflow_uuid
     ), output_rows AS (
       INSERT INTO dbos.workflow_output (workflow_uuid, output, retention_timestamp)
       SELECT workflow_uuid, 'null', completed_at FROM status_rows
       RETURNING workflow_uuid
     )
     SELECT count(*)::int AS inserted FROM status_rows`,
    [JSON.stringify(rows), WORKFLOWS_QUEUE, WORK_APPLICATION],
  );
}

async function growAxis(
  db: GrowthDatabase,
  anchor: Order,
  axis: GrowthAxis,
  prefix: string,
  principalId: string,
  from: number,
  to: number,
) {
  if (axis === 'unrelated orders') return growUnrelatedOrders(db, anchor, from, to);
  if (axis === 'provider events') return growWorkflowRows(db, prefix, from, to, true);
  if (axis === 'receipts') return growReceipts(db, prefix, principalId, from, to);
  return growWorkflowRows(db, prefix, from, to, false);
}

async function checkAxis(
  fixture: NativeAnchorFixture,
  provider: ProviderByteObserver,
  anchor: Order,
  axis: GrowthAxis,
  operationName: string,
  principalId: string,
  operation: Operation,
  hooks: { prepare?: () => Promise<void>; warmup?: () => Promise<void> } = {},
): Promise<GrowthReport> {
  const prefix = `${operationName.replaceAll(' ', '-')}-${axis.replaceAll(' ', '-')}-${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const expectsProvider = operationName === 'order reconciliation';
  const observations: unknown[] = [];
  const observe = async (db: GrowthDatabase, scale: number, repetition: number, phase: string, run: Operation) => {
    const measured = await provider.run(
      { operationId: `${prefix}:${repetition}`, scale, repetition },
      expectsProvider,
      () => run(db, scale, repetition),
    );
    const { observation } = measured;
    observations.push({ phase, ...observation, workflowId: expectsProvider ? measured.value : undefined });
    expect(observation.status).toBe(expectsProvider ? 'measured' : 'no-provider-calls');
    if (expectsProvider) {
      expect(observation.totals!.providerSends).toBeGreaterThan(0);
      expect(observation.totals!.providerRequestBytes).toBeGreaterThan(0);
      expect(observation.totals!.providerResponseBytes).toBeGreaterThan(0);
    } else expect(observation.totals).toBeNull();
    return measured;
  };
  const report = await checkGrowth(fixture.db, {
    name: `Commerce ${operationName} / unrelated ${axis}`,
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: (db, scale, previous) => growAxis(db, anchor, axis, prefix, principalId, previous, scale),
    // The existing counted series compares retained repetitions, alongside unchanged native counters.
    ...(expectsProvider
      ? {
          counted: {
            read: (value: unknown) => (value as Awaited<ReturnType<typeof observe>>).observation.totals!,
            bounds: {
              providerSends: 'constant' as const,
              providerRequestBytes: 'constant' as const,
              providerResponseBytes: 'constant' as const,
            },
          },
        }
      : {}),
    operation: (db, scale, repetition) => observe(db, scale, repetition, 'measurement candidate', operation),
    ...(hooks.prepare === undefined ? {} : { prepare: hooks.prepare }),
    warmup: (db, scale, repetition) => observe(db, scale, repetition, 'warmup', hooks.warmup ?? operation),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ cost }) => cost.rows > 0 && cost.statements > 0)).toBe(true);
  console.log(JSON.stringify({ axis, operationName, providerObservations: observations, report }));
  return report;
}

test('signed webhook, reconciliation, settlement and offer revision stay bounded across unrelated commerce history', async () => {
  const fixture = await nativeAnchorFixture();
  const db = fixture.db;
  const client = await createWorkClient(db.url, db.pool);
  const enqueue = createCommerceWork(client);
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  const provider = observeProviderBytes(`http://127.0.0.1:${fixture.fake.port}`);
  try {
    const anchor = await fixture.checkout(true, false);
    fixture.fake.pay(anchor.checkoutSessionId!);
    const snapshot = await fixture.stripe.readCheckout(anchor.checkoutSessionId!);
    const buyerId = fixture.buyer.actor.accountId;
    const sellerId = fixture.seller.actor.accountId;

    runtime = await composeWork([commerceWorkModule], {
      pool: db.pool,
      client,
      databaseUrl: db.url,
      executorId: 'commerce-payment-path-growth',
      env: {
        STRIPE_SECRET_KEY: 'sk_test_payment_path_growth',
        STRIPE_MANAGED_PAYMENTS: 'false',
        STRIPE_API_HOST: `http://127.0.0.1:${fixture.fake.port}`,
        STRIPE_ACCOUNT_NAMESPACE: 'payment-growth',
        STRIPE_LIVEMODE: 'false',
        CHECKOUT_SUCCESS_URL: 'https://web.test/success',
        CHECKOUT_CANCEL_URL: 'https://web.test/cancel',
      },
    });
    await runtime.launch();
    for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);

    let reconcileSequence = 0;
    const reconcile: Operation = async () => {
      const id = await enqueue.enqueueKnownOrderRepair(anchor.id, `payment-path-${reconcileSequence++}`);
      await client.retrieveWorkflow(id).getResult();
      return id;
    };
    for (const axis of axes)
      await checkAxis(fixture, provider, anchor, axis, 'order reconciliation', buyerId, reconcile);

    await runtime.shutdown();
    runtime = undefined;

    let settlementSequence = 0;
    const settle: Operation = async () =>
      fixture.commands.applyCheckoutSnapshot(snapshot, `payment-path-settlement-${settlementSequence++}`);
    for (const axis of axes) await checkAxis(fixture, provider, anchor, axis, 'payment settlement', buyerId, settle);

    let revisionSequence = 0;
    const reviseOffer: Operation = async () =>
      fixture.commands.reviseOffer(
        fixture.seller.actor,
        fixture.offer.id,
        { unitAmountMinor: 1300 },
        `payment-path-offer-revision-${revisionSequence++}`,
      );
    for (const axis of axes)
      await checkAxis(fixture, provider, anchor, axis, 'offer price revision', sellerId, reviseOffer);

    const secret = 'whsec_payment_path_growth';
    const timestamp = Math.floor(Date.now() / 1000);
    const eventId = `evt_growth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
    const stripe = new Stripe('sk_test_payment_path_growth');
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2026-10-01',
      created: timestamp,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'checkout.session.completed',
      data: {
        object: {
          id: anchor.checkoutSessionId,
          object: 'checkout.session',
          payment_intent: snapshot.paymentIntentId,
          client_reference_id: anchor.id,
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          metadata: {},
        },
      },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
      timestamp,
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    const app = createApp({
      pool: db.pool,
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
    });
    const webhook = stripeWebhookRoutes(app, {
      secrets: [secret],
      work: enqueue,
      clock: () => timestamp * 1000,
    });
    declareKernelWriteRates(webhook);
    const deliver = async () => {
      const response = await webhook.handle(
        new Request('http://kernel.test/v1/webhooks/stripe', {
          method: 'POST',
          body: payload,
          headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        }),
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(await response.text())).toEqual({ received: true });
      return response.status;
    };
    for (const axis of axes) {
      await checkAxis(fixture, provider, anchor, axis, 'signed webhook ingest', buyerId, deliver, {
        prepare: async () => {
          await client.deleteWorkflows([`stripe:${eventId}`], false);
        },
        warmup: async () => {
          await client.deleteWorkflows([`stripe:${eventId}`], false);
          await deliver();
        },
      });
    }
  } finally {
    await runtime?.shutdown();
    await client.close();
    provider.close();
    await fixture.close();
  }
}, 600_000);
