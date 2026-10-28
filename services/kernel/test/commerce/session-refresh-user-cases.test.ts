import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { orderExpiryWorkflowId } from '../../src/commerce/work-contract.ts';
import { refreshUserFixture } from './support/refresh-user-fixture.ts';
import { until } from './support/work-fixture.ts';

setDefaultTimeout(30_000);
let f: Awaited<ReturnType<typeof refreshUserFixture>>;
beforeAll(async () => {
  f = await refreshUserFixture();
  await f.start();
});
afterAll(async () => {
  await f?.close();
});

async function view(orderId: string, active: boolean) {
  const order = await f.request(`/v1/orders/${orderId}`);
  expect(order.status).toBe(200);
  const body = (await order.json()).order;
  expect(body.settlement).toBe('paid');
  const listed = await f.request('/v1/entitlements');
  expect(listed.status).toBe(200);
  const entitlement = (await listed.json()).entitlements.find((row: { orderId: string }) => row.orderId === orderId);
  expect(entitlement).toMatchObject({ orderId, active });
  expect(body.entitlementId).toBe(entitlement.id);
  const response = await f.request(`/v1/entitlements/${entitlement.id}`);
  expect(response.status).toBe(200);
  expect((await response.json()).entitlement).toEqual(entitlement);
  return entitlement;
}
async function paid() {
  const checkout = await f.checkout();
  f.fake.pay(checkout.session);
  const event = await f.event('checkout.session.completed', checkout.session);
  await event.submit();
  await f.finish(event.id);
  const entitlement = await view(checkout.order.id, true);
  expect(await f.events(checkout.order.id, 'entitlement.granted')).toHaveLength(1);
  return { ...checkout, event, entitlement };
}
async function sessionKey(workflow: string) {
  const row = await f.client.getWorkflow(workflow);
  expect(row?.queueName).toBe('effects');
  expect(row?.queuePartitionKey).toMatch(/^commerce:/);
  return row!.queuePartitionKey!;
}
async function cancelled(workflow: string) {
  await f.client.cancelWorkflow(workflow);
  expect((await f.client.getWorkflow(workflow))?.status).toBe('CANCELLED');
}

// These histories are created by this binary. Incompatible old split-step function IDs need an explicit
// deployment cutover; none of these tests silently replays old histories against a changed registration.
test('ordinary same-Session refresh children serialize on effects while another Session progresses and distinct triggers survive', async () => {
  const first = await f.checkout(),
    other = await f.checkout();
  f.fake.pay(first.session);
  f.fake.pay(other.session);
  const a = await f.event('checkout.session.completed', first.session);
  const hold = await f.arm(a.child, 'read');
  await a.submit();
  await hold.captured();
  try {
    const b = await f.event('checkout.session.completed', first.session);
    await b.submit();
    const independent = await f.event('checkout.session.completed', other.session);
    await independent.submit();
    await f.finish(independent.id);
    const aRow = await f.client.getWorkflow(a.child);
    const bRow = await until(() => f.client.getWorkflow(b.child), Boolean);
    expect(aRow).toMatchObject({ status: 'PENDING', queueName: 'effects' });
    expect(bRow).toMatchObject({
      status: 'ENQUEUED',
      queueName: 'effects',
      queuePartitionKey: aRow!.queuePartitionKey,
    });
    expect(a.child).not.toBe(b.child);
    const key = await sessionKey(a.child);
    expect(key).toContain(first.session);
    expect(await sessionKey(independent.child)).not.toBe(key);
    expect(f.reads(b.child)).toHaveLength(0);
    expect((await f.client.getWorkflow(a.id))?.queueName).toBe('workflows');
    expect((await f.client.getWorkflow(b.id))?.queueName).toBe('workflows');
    await view(other.order.id, true);
    hold.release();
    await f.finish(a.id);
    await f.finish(b.id);
    expect((await f.client.listWorkflowSteps(a.id))?.some((step) => step.childWorkflowID === a.child)).toBe(true);
    expect((await f.client.listWorkflowSteps(b.id))?.some((step) => step.childWorkflowID === b.child)).toBe(true);
    await view(first.order.id, true);
    expect(await f.events(first.order.id, 'entitlement.granted')).toHaveLength(1);
  } finally {
    hold.release();
  }
});

test('order and expiry parents stay on workflows and delegate refresh children without consuming effects capacity', async () => {
  const checkout = await f.checkout();
  const reconcile = `refresh-order:${checkout.order.id}`;
  await f.client.enqueue(
    { workflowName: 'commerce.reconcileOrder', queueName: 'workflows', workflowID: reconcile },
    checkout.order.id,
  );
  await f.finish(reconcile);
  const initialChildren = (await f.client.listWorkflowSteps(reconcile))?.filter((step) => step.childWorkflowID);
  expect(initialChildren?.length).toBeGreaterThan(0);
  const expiry = orderExpiryWorkflowId(checkout.order.id);
  const initial = initialChildren!.find((step) => step.childWorkflowID !== expiry)!;
  expect(initial).toBeDefined();
  const key = await sessionKey(initial.childWorkflowID!);
  expect((await f.client.getWorkflow(reconcile))?.queueName).toBe('workflows');
  // Exercise the actual expiry parent now, without altering Date or fabricating SDK rows.
  f.fake.expire(checkout.session);
  await f.client.setWorkflowDelay(expiry, { delayUntilEpochMS: Date.now() });
  await f.finish(expiry);
  expect((await f.client.getWorkflow(expiry))?.queueName).toBe('workflows');
  const expiryChild = (await f.client.listWorkflowSteps(expiry))?.find((step) => step.childWorkflowID);
  expect(expiryChild).toBeDefined();
  expect(await sessionKey(expiryChild!.childWorkflowID!)).toBe(key);
  expect(await f.state(checkout.order.id)).toMatchObject({ settlement: 'failed' });
});

for (const truth of ['pending full refund without balance', 'dispute without withdrawal'] as const) {
  test(`live obsolete ${truth} A loses native authority after newer unchanged paid B admission`, async () => {
    const { order, session, entitlement } = await paid();
    const before = await f.state(order.id);
    const transactions = await f.transactions(order.id);
    const pending = truth.startsWith('pending') ? f.pendingRefund(session) : undefined;
    const dispute = pending ? undefined : f.fake.dispute(session, { withdraw: false });
    const a = await f.event('checkout.session.completed', session);
    const hold = await f.arm(a.child, 'read');
    await a.submit();
    await hold.captured();
    try {
      const captured = f.reads(a.child)[0]!;
      expect(captured.transactions).toHaveLength(1); // Charge only: the entire real multi-GET read returned.
      expect(captured.observedAt).toBe(f.instant);
      if (pending) expect(captured.refunds).toMatchObject([{ status: 'pending', amountMinor: 1200 }]);
      else expect(captured.disputes).toMatchObject([{ status: 'needs_response' }]);
      await cancelled(a.child);
      await f.notice((n) => n.kind === 'cancel-signal' && n.workflow === a.child);
      if (pending) pending.cancel();
      else f.fake.updateDispute(dispute!, 'won');
      const b = await f.event('checkout.session.completed', session);
      await b.submit();
      await f.finish(b.id);
      const admitted = await f.state(order.id);
      // This must survive the business no-op. A DBOS cancellation/result discard is insufficient.
      expect(await f.receipts(b.child)).toHaveLength(0);
      expect(f.reads(b.child)[0]?.observedAt).toBe(captured.observedAt);
      hold.release();
      await hold.released();
      await f.notice((n) => n.kind === 'checkpoint' && n.workflow === a.child);
      expect(await view(order.id, true)).toEqual(entitlement);
      expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(0);
      expect(await f.transactions(order.id)).toEqual(transactions);
      expect(await f.receipts(a.child)).toHaveLength(0);
      expect((await f.state(order.id)).revision).toBe(admitted.revision);
      expect(admitted.revision).toBeGreaterThan(before.revision);
      expect(await f.ownReceiptEvents(order.id, admitted.revision)).toHaveLength(1);
    } finally {
      hold.release();
    }
  });
}

test('cancellation alone legally permits an already executing native apply to commit before any successor admission', async () => {
  const { order, session } = await paid();
  const pending = f.pendingRefund(session);
  const a = await f.event('checkout.session.completed', session);
  const lock = await f.arm(a.child, 'order-lock');
  await a.submit();
  await lock.captured();
  try {
    expect(f.reads(a.child)[0]?.refunds).toMatchObject([{ id: pending.id, status: 'pending' }]);
    await cancelled(a.child);
    // The latch is inside the native body, after its real receipt read. No later claim is supplied.
    lock.release();
    await lock.released();
    await f.notice((n) => n.kind === 'checkpoint' && n.workflow === a.child);
    await view(order.id, false);
    expect(await f.receipts(a.child)).toHaveLength(1);
    expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(1);
    expect((await f.client.getWorkflow(a.child))?.status).toBe('CANCELLED');
    pending.cancel();
    const restore = await f.event('checkout.session.completed', session);
    await restore.submit();
    await f.finish(restore.id);
    await view(order.id, true);
  } finally {
    lock.release();
  }
});

test('completed A terminal rewind checks its stable completion under the order lock before claiming over held B', async () => {
  const { order, session, event: a } = await paid();
  const aReceipts = await f.receipts(a.child);
  expect(aReceipts).toMatchObject([{ principal_id: f.buyer, partition_no: partitionOf(routeOf(order.id)!) }]);
  f.fake.refund(session, { amount: 1200 });
  const b = await f.event('checkout.session.completed', session);
  const hold = await f.arm(b.child, 'read');
  await b.submit();
  await hold.captured();
  const lock = await f.pool.connect();
  try {
    const revision = (await f.state(order.id)).revision;
    const aReads = f.reads(a.child).length;
    const steps = (await f.client.listWorkflowSteps(a.child))!;
    expect(steps.length).toBeGreaterThan(0);
    const startStep = Math.min(...steps.map((step) => step.functionID));
    const key = (await f.client.getWorkflow(b.child))?.queuePartitionKey;
    await lock.query('BEGIN');
    await lock.query('SELECT order_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2 FOR UPDATE', [
      routeOf(order.id),
      order.id,
    ]);
    const owner = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // Administrative queue bypass is intentional: native receipt admission must be safe even while B
    // occupies its Session slot. Rewind retains A's workflow ID and therefore its stable apply intent.
    await f.client.rewindWorkflow(a.child, {
      startStep,
      queueName: 'workflows',
      ...(key === undefined ? {} : { queuePartitionKey: key }),
    });
    const blocked = await until(
      async () => {
        const rows = await f.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))
         AND query LIKE '%commerce.purchase_order%' AND query LIKE '%FOR UPDATE%'`,
          [owner],
        );
        return { count: rows.rowCount, status: (await f.client.getWorkflow(a.child))?.status };
      },
      (value) => value.count === 1 || value.status === 'SUCCESS' || value.status === 'ERROR',
    );
    expect(blocked).toMatchObject({ count: 1, status: 'PENDING' });
    expect(f.reads(a.child)).toHaveLength(aReads);
    expect((await f.state(order.id)).revision).toBe(revision);
    await lock.query('ROLLBACK');
    await f.finish(a.child);
    expect((await f.state(order.id)).revision).toBe(revision);
    expect(f.reads(a.child)).toHaveLength(aReads);
    expect(await f.receipts(a.child)).toEqual(aReceipts);
    expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(1);
    expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(0);
    hold.release();
    await f.finish(b.id);
    await view(order.id, false);
    expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(1);
    expect(await f.receipts(b.child)).toHaveLength(1);
    expect((await f.state(order.id)).revision).toBeGreaterThan(revision);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    hold.release();
  }
});

test('physical worker death after complete provider read forces fresh refund reversal truth and one native application', async () => {
  const { order, session, entitlement } = await paid();
  const refund = f.fake.refund(session, { amount: 1200 });
  const a = await f.event('checkout.session.completed', session);
  // Inside the real apply transaction: old split implementations have already memoized their provider
  // bytes here; a combined implementation has not checkpointed an admission/read prefix.
  const hold = await f.arm(a.child, 'order-lock');
  await a.submit();
  const captured = await hold.captured();
  const previous = await f.state(order.id);
  expect(f.reads(a.child)[0]?.refunds).toMatchObject([{ status: 'succeeded' }]);
  expect(await f.receipts(a.child)).toHaveLength(0);
  const death = await f.stop();
  expect(death).toMatchObject({ pid: captured.pid, signal: 'SIGKILL' });
  f.fake.failRefund(refund);
  const restart = await f.start();
  expect(restart.pid).not.toBe(captured.pid);
  await f.finish(a.id);
  expect(f.reads(a.child)).toHaveLength(2);
  expect(f.reads(a.child)[1]?.refunds).toMatchObject([{ status: 'failed' }]);
  expect((await f.state(order.id)).revision).toBeGreaterThan(previous.revision);
  expect(await view(order.id, true)).toEqual(entitlement);
  expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(0);
  expect(await f.receipts(a.child)).toHaveLength(1);
  expect(await f.transactions(order.id)).toHaveLength(3);
});

test('DBOS result loss after actual native commit replays stable completion without another claim or provider read', async () => {
  const { order, session } = await f.checkout();
  f.fake.pay(session);
  const a = await f.event('checkout.session.completed', session);
  const hold = await f.arm(a.child, 'commit');
  await a.submit();
  const committed = await hold.captured();
  const receipt = await f.receipts(a.child);
  expect(receipt).toHaveLength(1); // Independent connection sees the committed envelope before SIGKILL.
  await view(order.id, true);
  const revision = (await f.state(order.id)).revision;
  const steps = await f.client.listWorkflowSteps(a.child);
  expect(steps?.some((step) => step.name === 'commerce.applyCheckout')).toBe(false);
  const death = await f.stop();
  expect(death).toMatchObject({ pid: committed.pid, signal: 'SIGKILL' });
  const restart = await f.start();
  expect(restart.pid).not.toBe(committed.pid);
  await f.finish(a.id);
  expect(f.reads(a.child)).toHaveLength(1);
  expect((await f.state(order.id)).revision).toBe(revision);
  expect(await f.receipts(a.child)).toEqual(receipt);
  expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await f.transactions(order.id)).toHaveLength(1);
  await view(order.id, true);
});

test('native SQL serialization retry retains admitted revision with old bytes while fresh physical retry claims and rereads', async () => {
  const { order, session, entitlement } = await paid();
  const pending = f.pendingRefund(session);
  const a = await f.event('checkout.session.completed', session);
  const lock = await f.arm(a.child, 'order-lock');
  await a.submit();
  await lock.captured();
  const aSnapshot = f.reads(a.child)[0]!;
  const admittedA = (await f.state(order.id)).revision;
  const after = f.notices.length;
  try {
    await cancelled(a.child);
    pending.cancel();
    const b = await f.event('checkout.session.completed', session);
    const holdB = await f.arm(b.child, 'read');
    await b.submit();
    await holdB.captured();
    try {
      expect(f.reads(b.child)[0]?.observedAt).toBe(aSnapshot.observedAt);
      const admittedB = (await f.state(order.id)).revision;
      expect(admittedB).toBeGreaterThan(admittedA);
      lock.release();
      await lock.released();
      // Real PostgreSQL 40001, not a thrown test exception or a timeout taken as proof of a retry.
      await f.notice((n) => n.kind === 'serialization' && n.workflow === a.child, after);
      await f.notice((n) => n.kind === 'checkpoint' && n.workflow === a.child, after);
      expect(f.reads(a.child)).toHaveLength(1);
      expect(await f.receipts(a.child)).toHaveLength(0);
      expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(0);
      expect((await f.state(order.id)).revision).toBe(admittedB);
      expect(await view(order.id, true)).toEqual(entitlement);
    } finally {
      holdB.release();
    }
    await f.finish(b.id);
    f.fake.refund(session, { amount: 1200 });
    const previous = (await f.state(order.id)).revision;
    const beforeRetry = f.reads(a.child).length;
    // Cancelled history may resume; the SDK preserves the stored partition key. Explicitly restore effects.
    await f.client.resumeWorkflow(a.child, { queueName: 'effects' });
    await f.finish(a.child);
    expect(f.reads(a.child)).toHaveLength(beforeRetry + 1);
    expect((await f.state(order.id)).revision).toBeGreaterThan(previous);
    expect(await f.receipts(a.child)).toHaveLength(1);
    expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(1);
    await view(order.id, false);
  } finally {
    lock.release();
  }
});

test('new paid refund dispute and legitimate later restore remain usable with identical provider and kernel clocks', async () => {
  const { order, session, entitlement } = await paid();
  const pending = f.pendingRefund(session);
  const refunded = await f.event('checkout.session.completed', session);
  await refunded.submit();
  await f.finish(refunded.id);
  await view(order.id, false);
  pending.cancel();
  const restore = await f.event('checkout.session.completed', session);
  await restore.submit();
  await f.finish(restore.id);
  await view(order.id, true);
  const dispute = f.fake.dispute(session, { withdraw: false });
  const disputed = await f.event('checkout.session.completed', session);
  await disputed.submit();
  await f.finish(disputed.id);
  await view(order.id, false);
  f.fake.updateDispute(dispute, 'won');
  const won = await f.event('checkout.session.completed', session);
  await won.submit();
  await f.finish(won.id);
  const final = await view(order.id, true);
  expect(final.id).toBe(entitlement.id);
  expect(await f.events(order.id, 'entitlement.granted')).toHaveLength(1);
  expect(await f.events(order.id, 'entitlement.revoked')).toHaveLength(2);
  expect(await f.events(order.id, 'entitlement.restored')).toHaveLength(2);
  for (const event of [refunded, restore, disputed, won]) expect(f.reads(event.child)[0]?.observedAt).toBe(f.instant);
  // Provider/kernel fixture clocks are one value. Order authority comes from native revisions, never time.
  expect((await f.state(order.id)).revision).toBeGreaterThan(order.revision);
});
