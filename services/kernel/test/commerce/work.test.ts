import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createCommerceWork } from '../../src/commerce/work.ts';
import { createCommerceWork as createEnqueue } from '../../src/commerce/enqueue.ts';
import { orderExpiryWorkflowId } from '../../src/commerce/work-contract.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { refreshUserFixture } from './support/refresh-user-fixture.ts';
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
  expect(Object.keys(WORK_QUEUES)).toEqual([
    'governance',
    'effects',
    'locator-effects',
    'workflows',
    'delivery',
    'import',
    'maintenance',
  ]);
});

test('a verified paid event delivered twice runs one event parent and one Session-partitioned refresh and grants once in the buyer partition', async () => {
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
  const checkoutId = `checkout:${session.id}:${event.ref.eventId}`;
  const steps = await fixture.client.listWorkflowSteps(event.id);
  expect(steps?.map((step) => step.name)).toEqual([
    'commerce.resolveCheckout',
    'commerce.checkoutSync',
    'DBOS.getResult',
  ]);
  expect(await fixture.client.getWorkflow(checkoutId)).toMatchObject({
    status: 'SUCCESS',
    queueName: 'effects',
    queuePartitionKey: expect.stringContaining(session.id),
  });
  const checkoutSteps = await fixture.client.listWorkflowSteps(checkoutId);
  expect(checkoutSteps).toHaveLength(1);
  expect(checkoutSteps?.map((step) => step.name)).not.toContain('commerce.readCheckout');
  expect(checkoutSteps?.map((step) => step.name)).not.toContain('commerce.clock');
  const receipts = (
    await fixture.pool.query(
      'SELECT idempotency_key AS receipt_key, partition_no FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2',
      ['commerce.checkout.apply', `wf:${checkoutId}:apply`],
    )
  ).rows;
  expect(receipts).toEqual([{ receipt_key: `wf:${checkoutId}:apply`, partition_no: partitionOf(routeOf(order.id)!) }]);
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
    await verifyStripeEvent(
      new TextEncoder().encode(completed.bytes),
      completed.signature,
      [fixture.transport.fake.webhookSecret],
      Date.now(),
    ),
  )!;
  await createEnqueue(fixture.client).enqueueStripeEvent(ref);
  await fixture.finish(`stripe:${ref.eventId}`);
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(0);
});

test('serialized Session workflows converge when payment is followed by the final refunded state', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const delay = fixture.transport.delayRead();
  const first = await fixture.deliver('checkout.session.completed', session.id);
  let later: Awaited<ReturnType<typeof fixture.deliver>> | undefined;
  try {
    await delay.captured;
    const refund = fixture.transport.fake.refund(session.id, { amount: 1200 });
    later = await fixture.deliver('refund.created', refund);
    const laterId = `checkout:${session.id}:${later.ref.eventId}`;
    await until(
      () => fixture.client.getWorkflow(laterId),
      (row) => row !== undefined,
    );
    expect(await fixture.client.getWorkflow(laterId)).toMatchObject({ status: 'ENQUEUED', queueName: 'effects' });
    expect(await fixture.entitlements(order.id)).toHaveLength(0);
    delay.release();
    await fixture.finish(later.id);
  } finally {
    delay.release();
    await fixture.finish(first.id);
    if (later) await fixture.finish(later.id);
  }
  await fixture.finish(first.id);
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(0);
  expect(
    fixture.transport.fake.requests.filter(
      (request) =>
        request.path === `/v1/checkout/sessions/${session.id}` &&
        (request.params.has('expand[0]') || request.params.has('expand[]')),
    ),
  ).toHaveLength(2);
});

test('Stripe unavailability retries the provider attempt; a paid-order mismatch fails visibly without retrying it', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const before = fixture.transport.reads;
  const servedBefore = fixture.transport.fake.requests.filter(
    (r) => r.path === `/v1/checkout/sessions/${session.id}`,
  ).length;
  fixture.transport.failRead();
  await fixture.finish((await fixture.deliver('checkout.session.completed', session.id)).id);
  const served = fixture.transport.fake.requests.filter((r) => r.path === `/v1/checkout/sessions/${session.id}`);
  expect(fixture.transport.reads - before).toBe(served.length - servedBefore + 1);
  expect(served.filter((r) => r.params.has('expand[0]') || r.params.has('expand[]'))).toHaveLength(1);
  fixture.transport.fake.sessions.get(session.id)!.metadata = { order_id: 'another-order' };
  const mismatch = await fixture.deliver('checkout.session.completed', session.id);
  await expect(fixture.finish(mismatch.id)).rejects.toThrow();
  expect((await fixture.client.getWorkflow(mismatch.id))?.status).toBe('ERROR');
  expect(await fixture.entitlements(order.id)).toHaveLength(1);
});

test('a worker killed after a full provider read recovers with a fresh read and grants exactly once', async () => {
  await fixture.stop();
  const native = await refreshUserFixture(fixture.transport.fake);
  try {
    await native.start();
    const { order, session } = await native.checkout();
    native.fake.pay(session);
    const event = await native.event('checkout.session.completed', session);
    const hold = await native.arm(event.child, 'read');
    await event.submit();
    const captured = await hold.captured();
    expect((await native.stop())?.pid).toBe(captured.pid);
    expect(await native.receipts(event.child)).toHaveLength(0);
    await native.start();
    await native.finish(event.id);
    expect(native.reads(event.child)).toHaveLength(2);
    const response = await native.request(`/v1/orders/${order.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).order).toMatchObject({ settlement: 'paid', entitlementId: expect.any(String) });
    const listed = await native.request('/v1/entitlements');
    expect(listed.status).toBe(200);
    expect(
      (await listed.json()).entitlements.filter((row: { orderId: string }) => row.orderId === order.id),
    ).toMatchObject([{ active: true }]);
    expect(await native.events(order.id, 'entitlement.granted')).toHaveLength(1);
    expect(await native.receipts(event.child)).toHaveLength(1);
  } finally {
    await native.close();
    await fixture.start();
  }
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
    await fixture.client.setWorkflowDelay(id, { delayUntilEpochMS: Date.now() });
    await fixture.finish(id);
    const expiryID = orderExpiryWorkflowId(order.id);
    await until(
      () => fixture.client.getWorkflow(expiryID),
      (workflow) => workflow?.status === 'DELAYED',
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
    await fixture.finish(expiryID);
    expect(await fixture.state(order.id)).toMatchObject({ settlement: 'paid' });
    expect(await fixture.entitlements(order.id)).toHaveLength(1);
    expect(
      fixture.transport.fake.requests.filter(
        (request) =>
          request.path === `/v1/checkout/sessions/${saved}` &&
          (request.params.has('expand[0]') || request.params.has('expand[]')),
      ),
    ).toHaveLength(2);
    await fixture.stop();
    await fixture.start();
  });

test('reconciliation sleeps durably through expiry and repairs a missed expired webhook', async () => {
  const { order, session } = await fixture.checkout();
  const id = await fixture.schedule(order.id);
  await fixture.client.setWorkflowDelay(id, { delayUntilEpochMS: Date.now() });
  await fixture.finish(id);
  const expiryID = orderExpiryWorkflowId(order.id);
  await until(
    () => fixture.client.getWorkflow(expiryID),
    (workflow) => workflow?.status === 'DELAYED',
  );
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'pending' });
  fixture.transport.fake.expire(session.id);
  await fixture.stop();
  await fixture.start(4_300_000);
  await fixture.finish(expiryID);
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'failed' });
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  expect(
    fixture.transport.fake.requests.filter(
      (request) =>
        request.path === `/v1/checkout/sessions/${session.id}` &&
        (request.params.has('expand[0]') || request.params.has('expand[]')),
    ),
  ).toHaveLength(2);
  await fixture.stop();
  await fixture.start();
});

test('a rejected reconciliation create marks the order failed; terminal orders finish without Stripe calls', async () => {
  const order = await fixture.order();
  fixture.transport.fake.nextCreateFault = 'rejected';
  const id = await fixture.schedule(order.id);
  await fixture.client.setWorkflowDelay(id, { delayUntilEpochMS: Date.now() });
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
