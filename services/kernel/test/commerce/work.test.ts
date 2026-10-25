import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createCommerceWork } from '../../src/commerce/work.ts';
import { createCommerceWork as createEnqueue } from '../../src/commerce/enqueue.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { until, workFixture } from './support/work-fixture.ts';

setDefaultTimeout(30_000);
let fixture: Awaited<ReturnType<typeof workFixture>>;
beforeAll(async () => {
  fixture = await workFixture();
  await fixture.start();
});
afterAll(async () => {
  await fixture?.close();
});

test('createCommerceWork returns the commerce module and keeps exactly the ADR-0033 queue set', () => {
  const module = createCommerceWork({
    stripe: fixture.stripe,
    checkout: {
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
    },
  });
  expect(module.name).toBe('commerce');
  expect(typeof module.register).toBe('function');
  expect(Object.keys(WORK_QUEUES)).toEqual(['governance', 'effects', 'workflows', 'delivery', 'import', 'maintenance']);
});

test('a verified paid event delivered twice runs one unpartitioned workflow and grants once in the buyer partition', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const event = await fixture.deliver('checkout.session.completed', session.id);
  await Promise.all([createEnqueue(fixture.client).enqueueStripeEvent(event.ref), fixture.finish(event.id)]);
  expect(await fixture.client.getWorkflow(event.id)).toMatchObject({
    status: 'SUCCESS',
    queueName: 'workflows',
    queuePartitionKey: undefined,
  });
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { account_id: fixture.buyer, route: routeOf(order.id), revoked_at: null },
  ]);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'paid' });
  const steps = await fixture.client.listWorkflowSteps(event.id);
  expect(steps?.map((step) => step.name)).toEqual([
    'commerce.resolveCheckout',
    'commerce.clock',
    'commerce.readCheckout',
    'commerce.applyCheckout',
  ]);
  const receipts = (
    await fixture.pool.query('SELECT receipt_key, partition_no FROM core.receipt WHERE kind=$1 AND receipt_key=$2', [
      'commerce.checkout.apply',
      `wf:${event.id}:apply`,
    ])
  ).rows;
  expect(receipts).toEqual([{ receipt_key: `wf:${event.id}:apply`, partition_no: partitionOf(routeOf(order.id)!) }]);
  expect(Date.parse((await fixture.state(order.id)).observed_at)).toBeGreaterThan(Date.parse('2026-01-01'));
});

for (const outcome of ['success', 'failure'])
  test(`async ${outcome} never grants before payment`, async () => {
    const { order, session } = await fixture.checkout();
    fixture.transport.fake.pay(session.id, 'async');
    await fixture.finish((await fixture.deliver('checkout.session.completed', session.id)).id);
    expect(await fixture.entitlements(order.id)).toHaveLength(0);
    expect(await fixture.state(order.id)).toMatchObject({ settlement: 'pending' });
    if (outcome === 'success') fixture.transport.fake.succeedPayment(session.id);
    else fixture.transport.fake.failPayment(session.id);
    await fixture.finish(
      (
        await fixture.deliver(
          `checkout.session.async_payment_${outcome === 'success' ? 'succeeded' : 'failed'}`,
          session.id,
        )
      ).id,
    );
    expect(await fixture.state(order.id)).toMatchObject({ settlement: outcome === 'success' ? 'paid' : 'failed' });
    expect(await fixture.entitlements(order.id)).toHaveLength(outcome === 'success' ? 1 : 0);
  });

test('refund and dispute events look up their session and revoke and restore the same entitlement', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  await fixture.finish((await fixture.deliver('checkout.session.completed', session.id)).id);
  const original = (await fixture.entitlements(order.id))[0]!;
  const refund = fixture.transport.fake.refund(session.id, { amount: 1200 });
  await fixture.finish((await fixture.deliver('refund.created', refund)).id);
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { entitlement_id: original.entitlement_id, revoke_reason: 'refund', revoked_at: expect.any(Date) },
  ]);
  fixture.transport.fake.failRefund(refund);
  await fixture.finish((await fixture.deliver('refund.failed', refund)).id);
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { entitlement_id: original.entitlement_id, revoked_at: null },
  ]);
  const dispute = fixture.transport.fake.dispute(session.id);
  await fixture.finish((await fixture.deliver('charge.dispute.created', dispute)).id);
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { revoke_reason: 'dispute', revoked_at: expect.any(Date) },
  ]);
  fixture.transport.fake.updateDispute(dispute, 'won');
  await fixture.finish((await fixture.deliver('charge.dispute.closed', dispute)).id);
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { entitlement_id: original.entitlement_id, revoked_at: null },
  ]);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await fixture.events(order.id, 'entitlement.restored')).toHaveLength(2);
});

test('a refund arriving before completed never grants, even when completed is delivered later', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const completed = await fixture.transport.fake.event('checkout.session.completed', session.id);
  const refund = fixture.transport.fake.refund(session.id, { amount: 1200 });
  await fixture.finish((await fixture.deliver('refund.created', refund)).id);
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  const { verifyStripeEvent, classifyStripeEvent } = await import('../../src/commerce/webhook.ts');
  const ref = classifyStripeEvent(
    await verifyStripeEvent(new TextEncoder().encode(completed.bytes), completed.signature, [
      fixture.transport.fake.webhookSecret,
    ]),
  )!;
  await createEnqueue(fixture.client).enqueueStripeEvent(ref);
  await fixture.finish(`stripe:${ref.eventId}`);
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(0);
});

test('concurrent session workflows converge when an older paid response arrives after the final refunded state', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const delay = fixture.transport.delayRead();
  const first = await fixture.deliver('checkout.session.completed', session.id);
  try {
    await delay.captured;
    const refund = fixture.transport.fake.refund(session.id, { amount: 1200 });
    await fixture.finish((await fixture.deliver('refund.created', refund)).id);
    expect(await fixture.entitlements(order.id)).toHaveLength(0);
  } finally {
    delay.release();
  }
  await fixture.finish(first.id);
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(0);
  expect(
    fixture.transport.fake.requests.filter((request) => request.path === `/v1/checkout/sessions/${session.id}`),
  ).toHaveLength(2);
});

test('Stripe unavailability retries the read step; a paid-order mismatch fails visibly without retrying it', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const before = fixture.transport.reads;
  fixture.transport.failRead();
  await fixture.finish((await fixture.deliver('checkout.session.completed', session.id)).id);
  expect(fixture.transport.reads - before).toBe(2);
  fixture.transport.fake.sessions.get(session.id)!.metadata = { order_id: 'another-order' };
  const mismatch = await fixture.deliver('checkout.session.completed', session.id);
  await expect(fixture.finish(mismatch.id)).rejects.toThrow();
  expect((await fixture.client.getWorkflow(mismatch.id))?.status).toBe('ERROR');
  expect(await fixture.entitlements(order.id)).toHaveLength(1);
});

test('a worker killed between a durable read and apply recovers that read and grants exactly once', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const lock = await fixture.pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT order_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2 FOR UPDATE', [
    routeOf(order.id),
    order.id,
  ]);
  const before = fixture.transport.reads;
  const event = await fixture.deliver('checkout.session.completed', session.id);
  try {
    await until(
      () => fixture.client.listWorkflowSteps(event.id),
      (steps) => !!steps?.some((step) => step.name === 'commerce.readCheckout'),
    );
    await fixture.stop();
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  await fixture.start();
  await fixture.finish(event.id);
  expect(fixture.transport.reads - before).toBe(1);
  expect(await fixture.entitlements(order.id)).toHaveLength(1);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(1);
});

for (const lost of [false, true])
  test(`${lost ? 'lost' : 'abandoned'} checkout is reconciled by one delayed workflow and repairs a missed completed webhook`, async () => {
    const order = await fixture.order();
    if (lost) {
      fixture.transport.fake.nextCreateFault = 'lost';
      await expect(fixture.stripe.createCheckoutSession(fixture.request(order), `order:${order.id}`)).rejects.toThrow();
      await fixture.commands.recordCheckout(order.id, { kind: 'unknown' });
    }
    const id = await fixture.schedule(order.id);
    await fixture.schedule(order.id);
    const delayed = await fixture.client.getWorkflow(id);
    expect(delayed).toMatchObject({
      status: 'DELAYED',
      workflowName: 'commerce.reconcileOrder',
      queueName: 'workflows',
      queuePartitionKey: undefined,
    });
    expect(delayed!.delayUntilEpochMS! - Date.now()).toBeGreaterThan(890_000);
    expect(delayed!.delayUntilEpochMS! - Date.now()).toBeLessThanOrEqual(900_000);
    await fixture.client.setWorkflowDelay(id, { delaySeconds: 0 });
    await until(
      () => fixture.client.listWorkflowSteps(id),
      (steps) => !!steps?.some((step) => step.name === 'DBOS.sleep'),
    );
    const saved = (
      await fixture.pool.query(
        'SELECT checkout_session_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
        [routeOf(order.id), order.id],
      )
    ).rows[0]!.checkout_session_id;
    const creates = fixture.transport.fake.requests.filter(
      (request) => request.method === 'POST' && request.params.get('client_reference_id') === order.id,
    );
    expect(creates).toHaveLength(lost ? 2 : 1);
    expect(creates.every((request) => request.headers.get('idempotency-key') === `order:${order.id}`)).toBe(true);
    expect(
      [...fixture.transport.fake.sessions.values()].filter((session) => session.client_reference_id === order.id),
    ).toHaveLength(1);
    expect(await fixture.entitlements(order.id)).toHaveLength(0);
    fixture.transport.fake.pay(saved);
    await fixture.stop();
    await fixture.start(4_300_000);
    await fixture.finish(id);
    expect(await fixture.state(order.id)).toMatchObject({ settlement: 'paid' });
    expect(await fixture.entitlements(order.id)).toHaveLength(1);
    expect(
      fixture.transport.fake.requests.filter((request) => request.path === `/v1/checkout/sessions/${saved}`),
    ).toHaveLength(2);
    await fixture.stop();
    await fixture.start();
  });

test('reconciliation sleeps durably through expiry and repairs a missed expired webhook', async () => {
  const { order, session } = await fixture.checkout();
  const id = await fixture.schedule(order.id);
  await fixture.client.setWorkflowDelay(id, 0);
  await until(
    () => fixture.client.listWorkflowSteps(id),
    (steps) => !!steps?.some((step) => step.name === 'DBOS.sleep'),
  );
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'pending' });
  fixture.transport.fake.expire(session.id);
  await fixture.stop();
  await fixture.start(4_300_000);
  await fixture.finish(id);
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'failed' });
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(
    fixture.transport.fake.requests.filter((request) => request.path === `/v1/checkout/sessions/${session.id}`),
  ).toHaveLength(2);
  await fixture.stop();
  await fixture.start();
});

test('a rejected reconciliation create marks the order failed; terminal orders finish without Stripe calls', async () => {
  const order = await fixture.order();
  fixture.transport.fake.nextCreateFault = 'rejected';
  const id = await fixture.schedule(order.id);
  await fixture.client.setWorkflowDelay(id, 0);
  await fixture.finish(id);
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'failed' });
  const paid = await fixture.checkout();
  fixture.transport.fake.pay(paid.session.id);
  await fixture.finish((await fixture.deliver('checkout.session.completed', paid.session.id)).id);
  const before = fixture.transport.fake.requests.length;
  for (const orderId of [order.id, paid.order.id]) {
    const terminal = `terminal:${orderId}`;
    await fixture.client.enqueue(
      { workflowName: 'commerce.reconcileOrder', queueName: 'workflows', workflowID: terminal },
      orderId,
    );
    await fixture.finish(terminal);
  }
  expect(fixture.transport.fake.requests).toHaveLength(before);
});

test('a session outside commerce and a PaymentIntent without a session write nothing', async () => {
  const order = await fixture.order();
  const session = await fixture.stripe.createCheckoutSession(
    { ...fixture.request(order), orderId: 'not-ours' },
    'order:not-ours',
  );
  fixture.transport.fake.pay(session.id);
  const before = await fixture.pool.query(
    'SELECT (SELECT count(*) FROM core.outbox) AS events, (SELECT count(*) FROM core.receipt) AS receipts',
  );
  await fixture.finish((await fixture.deliver('checkout.session.completed', session.id)).id);
  const id = 'stripe:evt_unrelated';
  await fixture.client.enqueue(
    { workflowName: 'commerce.stripeEvent', queueName: 'workflows', workflowID: id },
    {
      eventId: 'evt_unrelated',
      type: 'refund.created',
      created: 0,
      livemode: false,
      sessionId: null,
      paymentIntentId: 'pi_missing',
    },
  );
  await fixture.finish(id);
  expect(
    (
      await fixture.pool.query(
        'SELECT (SELECT count(*) FROM core.outbox) AS events, (SELECT count(*) FROM core.receipt) AS receipts',
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await fixture.client.listWorkflowSteps(id))?.map((step) => step.name)).toEqual(['commerce.resolveCheckout']);
});
