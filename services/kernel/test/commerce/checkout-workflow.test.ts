import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createCommerceWork as createEnqueue } from '../../src/commerce/enqueue.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../src/commerce/webhook.ts';
import { StripeUnavailableError } from '../../src/commerce/model.ts';
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

test('Lost creation response preserves one stable native intent and provider request within the safe window', async () => {
  const key = Bun.randomUUIDv7();
  fixture.transport.fake.nextCreateFault = 'lost';
  await expect(fixture.checkoutRequest(key)).rejects.toBeInstanceOf(StripeUnavailableError);
  const order = await fixture.orderForRequest(key);
  const native = await fixture.pool.query(
    'SELECT * FROM commerce.checkout_creation_attempt WHERE route=$1 AND order_id=$2',
    [routeOf(order.id), order.id],
  );
  expect(native.rows).toHaveLength(1);
  const first = fixture.transport.fake.requests.find((r) => r.params.get('client_reference_id') === order.id)!;
  const originalSession = [...fixture.transport.fake.sessions.values()].find(
    (s) => s.client_reference_id === order.id,
  )!;
  expect(originalSession).toBeDefined();
  const result = await fixture.checkoutRequest(key, {
    successUrl: 'https://changed.test/success',
    cancelUrl: 'https://changed.test/cancel',
    stripe: { ...fixture.providerStripe, managedPayments: true },
  });
  expect(result.checkoutSessionId).toBe(originalSession.id);
  const calls = fixture.transport.fake.requests.filter((r) => r.params.get('client_reference_id') === order.id);
  expect(calls).toHaveLength(2);
  expect(calls.map((r) => r.rawParams)).toEqual([first.rawParams, first.rawParams]);
  expect(calls.map((r) => r.headers.get('idempotency-key'))).toEqual([`order:${order.id}`, `order:${order.id}`]);
  expect([...fixture.transport.fake.sessions.values()].filter((s) => s.client_reference_id === order.id)).toHaveLength(
    1,
  );
  const after = (
    await fixture.pool.query('SELECT * FROM commerce.checkout_creation_attempt WHERE route=$1 AND order_id=$2', [
      routeOf(order.id),
      order.id,
    ])
  ).rows;
  expect(after).toEqual([{ ...native.rows[0], retried: true }]);
  const beforeReplay = fixture.transport.fake.requests.length;
  expect((await fixture.checkoutRequest(key)).checkoutSessionId).toBe(originalSession.id);
  expect(fixture.transport.fake.requests).toHaveLength(beforeReplay);
  expect(result).not.toHaveProperty('request');
  expect(result).not.toHaveProperty('firstAttemptAt');
});

for (const fault of ['lost', 'cached failure'] as const)
  test(`${fault} followed by replay cannot erase an earlier uncertain creation`, async () => {
    const key = Bun.randomUUIDv7();
    fixture.transport.fake.nextCreateFault = fault === 'lost' ? 'lost' : { type: 'api_error', status: 500 };
    await expect(fixture.checkoutRequest(key)).rejects.toBeInstanceOf(StripeUnavailableError);
    const order = await fixture.orderForRequest(key);
    const before = fixture.transport.fake.requests.filter((r) => r.params.get('client_reference_id') === order.id);
    if (fault === 'lost') {
      await expect(
        fixture.providerStripe.createCheckoutSession(
          { ...fixture.request(order), title: 'Mismatched retry' },
          `order:${order.id}`,
        ),
      ).rejects.toBeInstanceOf(StripeUnavailableError);
      expect(await fixture.state(order.id)).toMatchObject({ settlement: 'unknown' });
      const restored = await fixture.checkoutRequest(key);
      const original = [...fixture.transport.fake.sessions.values()].find((s) => s.client_reference_id === order.id)!;
      expect(restored.checkoutSessionId).toBe(original.id);
    } else {
      await expect(fixture.checkoutRequest(key)).rejects.toBeInstanceOf(StripeUnavailableError);
      expect(await fixture.state(order.id)).toMatchObject({ settlement: 'unknown' });
    }
    const calls = fixture.transport.fake.requests.filter((r) => r.params.get('client_reference_id') === order.id);
    expect(calls.at(-1)!.rawParams).toBe(before[0]!.rawParams);
    expect(calls.every((r) => r.headers.get('idempotency-key') === `order:${order.id}`)).toBe(true);
    expect(
      [...fixture.transport.fake.sessions.values()].filter((s) => s.client_reference_id === order.id),
    ).toHaveLength(fault === 'lost' ? 1 : 0);
  });

test('HTTP replay refuses an expired uncertain creation without another provider create', async () => {
  const key = Bun.randomUUIDv7();
  fixture.transport.fake.nextCreateFault = 'lost';
  await expect(fixture.checkoutRequest(key)).rejects.toBeInstanceOf(StripeUnavailableError);
  const order = await fixture.orderForRequest(key);
  const before = fixture.transport.fake.requests.filter((r) => r.params.get('client_reference_id') === order.id);
  await expect(fixture.checkoutRequest(key, { clockOffset: 25 * 60 * 60 * 1000 })).rejects.toBeInstanceOf(
    StripeUnavailableError,
  );
  expect(fixture.transport.fake.requests.filter((r) => r.params.get('client_reference_id') === order.id)).toEqual(
    before,
  );
  expect(await fixture.state(order.id)).toMatchObject({ settlement: 'unknown' });
  expect([...fixture.transport.fake.sessions.values()].filter((s) => s.client_reference_id === order.id)).toHaveLength(
    1,
  );
});
