import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { refreshUserFixture } from './support/refresh-user-fixture.ts';

setDefaultTimeout(30_000);
let f: Awaited<ReturnType<typeof refreshUserFixture>>;
beforeAll(async () => {
  f = await refreshUserFixture();
});
afterAll(async () => {
  await f?.close();
});
const fullReads = (session: string) =>
  f.fake.requests.filter(
    (r) => r.path === `/v1/checkout/sessions/${session}` && (r.params.has('expand[0]') || r.params.has('expand[]')),
  ).length;

for (const completed of [false, true])
  test(`a real legacy ${completed ? 'committed effect' : 'cached financial read'} recovers through the default worker with the original stable intent`, async () => {
    await f.start('legacy-work');
    const { order, session } = await f.checkout();
    f.fake.pay(session);
    const event = await f.event('checkout.session.completed', session);
    const hold = await f.arm(event.child, completed ? 'commit' : 'order-lock');
    await event.submit();
    const reached = await hold.captured();
    expect((await f.client.listWorkflowSteps(event.child))?.map((s) => s.name)).toEqual([
      'commerce.clock',
      'commerce.readCheckout',
    ]);
    expect(await f.receipts(event.child)).toHaveLength(completed ? 1 : 0);
    const before = fullReads(session);
    expect(before).toBe(1);
    const applicationVersion = (await f.client.getWorkflow(event.id))!.applicationVersion;
    expect(applicationVersion).toBeTruthy();
    // Stop this owned process, rather than pretending SDK cancellation kills its physical body.
    expect((await f.stop())?.pid).toBe(reached.pid);
    f.fake.refund(session, { amount: 1200 });
    // The SDK's supported version configuration selects the compatible adapter for these old
    // histories; changing source alone computes a different version and cannot recover them.
    await f.start('default-work', applicationVersion);
    await f.finish(event.id);
    expect(await f.receipts(event.child)).toHaveLength(1);
    const steps = await f.client.listWorkflowSteps(event.child);
    expect(steps?.map((s) => s.name)).toEqual(['commerce.clock', 'commerce.readCheckout', 'commerce.applyCheckout']);
    expect(await f.client.getWorkflow(`${event.child}:refresh`)).toMatchObject({
      status: 'SUCCESS',
      queueName: 'effects',
      queuePartitionKey: `commerce:direct:test:${session}`,
    });
    expect(fullReads(session)).toBe(before + (completed ? 0 : 1));
    expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(completed ? 1 : 0);
    // A later named trigger reconciles the refund even when the legacy stable apply already completed.
    const repair = await f.enqueue.enqueueKnownOrderRepair(order.id, 'after-legacy-cutover');
    await f.finish(repair);
    const listed = await f.request('/v1/entitlements');
    const rows = (await listed.json()).entitlements.filter((row: { orderId: string }) => row.orderId === order.id);
    expect(rows.every((row: { active: boolean }) => !row.active)).toBe(true);
    expect(await f.receipts(event.child)).toHaveLength(1);
    await f.stop();
  });
