import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { stripeEventWorkflowId } from '../../src/commerce/work-contract.ts';
import { classifyStripeEvent, verifyStripeEvent } from '../../src/commerce/webhook.ts';
import { refreshUserFixture } from './support/refresh-user-fixture.ts';
import { until } from './support/work-fixture.ts';

setDefaultTimeout(30_000);
let f: Awaited<ReturnType<typeof refreshUserFixture>>;
beforeAll(async () => {
  f = await refreshUserFixture();
  await f.start('default-work');
});
afterAll(async () => {
  await f?.close();
});
const reads = (session: string) =>
  f.fake.requests.filter(
    (r) => r.path === `/v1/checkout/sessions/${session}` && (r.params.has('expand[0]') || r.params.has('expand[]')),
  );
async function active(orderId: string) {
  const response = await f.request('/v1/entitlements');
  expect(response.status).toBe(200);
  return (await response.json()).entitlements.find((e: { orderId: string }) => e.orderId === orderId)?.active;
}
async function paid() {
  const order = await f.checkout();
  f.fake.pay(order.session);
  const event = await f.event('checkout.session.completed', order.session);
  await event.submit();
  await f.finish(event.id);
  expect(await active(order.order.id)).toBe(true);
  return { ...order, event };
}

test('the default worker dedupes signed intake, refuses forgery and repairs a paid order by a new internal name', async () => {
  const { order, session, event } = await paid();
  const before = reads(session).length;
  await event.submit();
  await f.finish(event.id);
  expect(reads(session)).toHaveLength(before);
  const forged = await f.fake.event('checkout.session.completed', session);
  const response = await f.handle(
    new Request('http://kernel.test/v1/webhooks/stripe', {
      method: 'POST',
      headers: forged.headers,
      body: forged.bytes.replace('checkout.session.completed', 'checkout.session.expired'),
    }),
  );
  expect(response.status).toBe(400);
  expect(await f.client.getWorkflow(stripeEventWorkflowId(JSON.parse(forged.bytes).id))).toBeUndefined();
  const refund = f.fake.refund(session, { amount: 1200 });
  const repair = await f.enqueue.enqueueKnownOrderRepair(order.id, 'refund-outage');
  await f.finish(repair);
  expect(await active(order.id)).toBe(false);
  expect(await f.client.getWorkflow(`${repair}:refresh`)).toMatchObject({
    status: 'SUCCESS',
    queueName: 'effects',
    queuePartitionKey: `commerce:direct:test:${session}`,
  });
  expect(reads(session)).toHaveLength(before + 1);
  f.fake.failRefund(refund);
  // Reusing the same repair name is a replay, including for paid orders. A new name is a new trigger.
  expect(await f.enqueue.enqueueKnownOrderRepair(order.id, 'refund-outage')).toBe(repair);
  await f.finish(repair);
  expect(reads(session)).toHaveLength(before + 1);
  const restore = await f.enqueue.enqueueKnownOrderRepair(order.id, 'refund-reversed');
  await f.finish(restore);
  expect(restore).not.toBe(repair);
  expect(await active(order.id)).toBe(true);
  expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await f.events(order.id, 'entitlement.restored')).toHaveLength(1);
});

test('one finite verified outage page uses the ordinary dedupe; a bad page admits no event', async () => {
  const { order, session } = await paid();
  const refund = f.fake.refund(session, { amount: 1200 });
  const signed = await f.fake.event('refund.created', refund);
  const raw = new TextEncoder().encode(signed.bytes);
  const ref = classifyStripeEvent(await verifyStripeEvent(raw, signed.signature, [f.fake.webhookSecret], Date.now()))!;
  const page = [{ raw, signature: signed.signature }];
  const before = reads(session).length;
  expect(await f.enqueue.recoverSignedEventPage(page, [f.fake.webhookSecret])).toEqual({
    count: 1,
    afterEventId: ref.eventId,
  });
  await f.finish(stripeEventWorkflowId(ref.eventId));
  expect(await active(order.id)).toBe(false);
  await f.enqueue.recoverSignedEventPage(page, [f.fake.webhookSecret]);
  expect(reads(session)).toHaveLength(before + 1);
  const other = await f.fake.event('checkout.session.completed', session);
  const valid = { raw: Buffer.from(other.bytes), signature: other.signature };
  await expect(
    f.enqueue.recoverSignedEventPage([valid, { ...valid, signature: 'forged' }], [f.fake.webhookSecret]),
  ).rejects.toThrow();
  expect(await f.client.getWorkflow(stripeEventWorkflowId(JSON.parse(other.bytes).id))).toBeUndefined();
  await expect(
    f.enqueue.recoverSignedEventPage(
      Array.from({ length: 101 }, () => valid),
      [f.fake.webhookSecret],
    ),
  ).rejects.toThrow('bounds');
});

test('default effects serialize a Session, allow another Session, and failure retries claim and read afresh', async () => {
  const first = await f.checkout(),
    other = await f.checkout();
  f.fake.pay(first.session);
  f.fake.pay(other.session);
  const a = await f.event('checkout.session.completed', first.session);
  const hold = f.delayFullRead(first.session);
  await a.submit();
  await hold.captured;
  try {
    const b = await f.event('checkout.session.completed', first.session);
    await b.submit();
    const independent = await f.event('checkout.session.completed', other.session);
    await independent.submit();
    await f.finish(independent.id);
    const row = await until(() => f.client.getWorkflow(b.child), Boolean);
    expect(row).toMatchObject({ status: 'ENQUEUED', queueName: 'effects' });
    expect(reads(first.session)).toHaveLength(1);
    expect(await active(other.order.id)).toBe(true);
    hold.release();
    await f.finish(a.id);
    await f.finish(b.id);
  } finally {
    hold.release();
  }
  f.fake.refund(first.session, { amount: 1200 });
  const previous = (await f.state(first.order.id)).revision;
  f.failFullRead(first.session);
  const repair = await f.enqueue.enqueueKnownOrderRepair(first.order.id, 'retry-provider-outage');
  await f.finish(repair);
  // Failed physical admission and its fresh retry each advance the native fence; only apply produces a receipt.
  expect((await f.state(first.order.id)).revision).toBeGreaterThanOrEqual(previous + 3);
  expect(await f.receipts(`${repair}:refresh`)).toHaveLength(1);
  expect(await active(first.order.id)).toBe(false);
});
