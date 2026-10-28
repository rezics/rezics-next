import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createCommerceWork as createEnqueue } from '../../src/commerce/enqueue.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../src/commerce/webhook.ts';
import { routeOf } from '../../src/route/route.ts';
import { refreshUserFixture } from './support/refresh-user-fixture.ts';
import { workFixture } from './support/work-fixture.ts';

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
    queueName: 'effects',
    queuePartitionKey: expect.stringContaining(session.id),
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

test('a worker stopped after the full checkout read recovers fresh and applies once', async () => {
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
    expect(await native.client.getWorkflow(event.child)).toMatchObject({ status: 'SUCCESS' });
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
