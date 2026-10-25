import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createCommerceWork as createEnqueue } from '../../src/commerce/enqueue.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../src/commerce/webhook.ts';
import { routeOf } from '../../src/route/route.ts';
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

test('a verified paid event awaits its session checkout workflow and applies once', async () => {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const event = await fixture.deliver('checkout.session.completed', session.id);
  const checkoutId = `checkout:${session.id}:${event.ref.eventId}`;

  await fixture.finish(event.id);

  const workflows = await fixture.client.listWorkflows({ workflowIDs: [event.id, checkoutId] });
  expect(workflows.map((workflow) => workflow.workflowID).sort()).toEqual([event.id, checkoutId].sort());
  expect(await fixture.client.getWorkflow(event.id)).toMatchObject({
    workflowName: 'commerce.stripeEvent',
    status: 'SUCCESS',
  });
  expect(await fixture.client.getWorkflow(checkoutId)).toMatchObject({
    workflowName: 'commerce.checkoutSync',
    status: 'SUCCESS',
    parentWorkflowID: event.id,
  });
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { account_id: fixture.buyer, route: routeOf(order.id), revoked_at: null },
  ]);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(1);
  const receipts = (
    await fixture.pool.query('SELECT idempotency_key FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2', [
      'commerce.checkout.apply',
      `wf:${checkoutId}:apply`,
    ])
  ).rows;
  expect(receipts).toEqual([{ idempotency_key: `wf:${checkoutId}:apply` }]);
});

test('enqueuing the same verified event twice starts one event and one checkout workflow', async () => {
  const { session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const event = await fixture.deliver('checkout.session.completed', session.id);
  const checkoutId = `checkout:${session.id}:${event.ref.eventId}`;
  const enqueue = createEnqueue(fixture.client);

  await Promise.all([enqueue.enqueueStripeEvent(event.ref), enqueue.enqueueStripeEvent(event.ref)]);
  await fixture.finish(event.id);

  const workflows = await fixture.client.listWorkflows({ workflowIDs: [event.id, checkoutId] });
  expect(workflows).toHaveLength(2);
  expect(workflows.map((workflow) => workflow.workflowID).sort()).toEqual([event.id, checkoutId].sort());
  expect(workflows.every((workflow) => workflow.status === 'SUCCESS')).toBe(true);
});

test('an event whose payment intent has no resolvable Checkout Session starts no child workflow', async () => {
  const { session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const refund = fixture.transport.fake.refund(session.id, { amount: 100 });
  const signed = await fixture.transport.fake.event('refund.created', refund);
  fixture.transport.fake.sessions.delete(session.id);
  const verified = await verifyStripeEvent(
    new TextEncoder().encode(signed.bytes),
    signed.signature,
    [fixture.transport.fake.webhookSecret],
    Date.now(),
  );
  const ref = classifyStripeEvent(verified)!;
  const eventId = `stripe:${ref.eventId}`;
  const checkoutId = `checkout:${session.id}:${ref.eventId}`;

  await createEnqueue(fixture.client).enqueueStripeEvent(ref);
  await fixture.finish(eventId);

  expect(await fixture.client.getWorkflow(eventId)).toMatchObject({
    workflowName: 'commerce.stripeEvent',
    status: 'SUCCESS',
  });
  expect(await fixture.client.getWorkflow(checkoutId)).toBeUndefined();
  expect(await fixture.client.listWorkflows({ workflowIDs: [eventId, checkoutId] })).toMatchObject([
    { workflowID: eventId, workflowName: 'commerce.stripeEvent', status: 'SUCCESS' },
  ]);
});

test('a worker stopped inside the checkout workflow recovers and applies once', async () => {
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
  const checkoutId = `checkout:${session.id}:${event.ref.eventId}`;
  try {
    await until(
      () => fixture.client.listWorkflowSteps(checkoutId),
      (steps) => !!steps?.some((step) => step.name === 'commerce.readCheckout' && step.completedAtEpochMs),
    );
    await fixture.stop();
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect(await fixture.entitlements(order.id)).toHaveLength(0);
  await fixture.start();
  await fixture.finish(event.id);
  expect(await fixture.client.getWorkflow(checkoutId)).toMatchObject({ status: 'SUCCESS' });
  expect(fixture.transport.reads - before).toBe(1);
  expect(await fixture.entitlements(order.id)).toHaveLength(1);
  expect(await fixture.events(order.id, 'entitlement.granted')).toHaveLength(1);
  const receipts = (
    await fixture.pool.query('SELECT idempotency_key FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2', [
      'commerce.checkout.apply',
      `wf:${checkoutId}:apply`,
    ])
  ).rows;
  expect(receipts).toHaveLength(1);
});
