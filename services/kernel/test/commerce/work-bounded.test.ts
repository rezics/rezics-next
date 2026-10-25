import { expect, setDefaultTimeout, test } from 'bun:test';
import { Pool } from 'pg';
import { orderReconcileWorkflowId } from '../../src/commerce/work-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { workFixture } from './support/work-fixture.ts';

setDefaultTimeout(60_000);

async function enqueueReconciliation(fixture: Awaited<ReturnType<typeof workFixture>>, orderId: string) {
  const workflowID = orderReconcileWorkflowId(orderId);
  await fixture.client.enqueue(
    {
      workflowName: 'commerce.reconcileOrder',
      workflowID,
      workflowIDReusePolicy: 'return-existing',
      queueName: 'workflows',
    },
    orderId,
  );
  return workflowID;
}

test('a burst of reconciliations shares the workflows queue bound and creates one session per order', async () => {
  const fixture = await workFixture();
  await fixture.start();
  try {
    const orders = [];
    for (let index = 0; index < 200; index++) orders.push(await fixture.order());

    const lost = orders.slice(0, 100);
    for (const order of orders.slice(100)) {
      const session = await fixture.stripe.createCheckoutSession(fixture.request(order), `order:${order.id}`);
      await fixture.commands.recordCheckout(order.id, { session });
    }

    const workflowIDs = orders.map((order) => orderReconcileWorkflowId(order.id));
    let maximumPending = 0;
    const monitor = (async () => {
      const deadline = Date.now() + 55_000;
      for (;;) {
        const rows = await fixture.client.listWorkflows({ workflowIDs });
        maximumPending = Math.max(
          maximumPending,
          rows.filter(
            (row) =>
              row.status === 'PENDING' &&
              row.workflowName === 'commerce.reconcileOrder' &&
              row.queueName === 'workflows' &&
              row.executorId === 'commerce-test',
          ).length,
        );
        if (
          rows.length === workflowIDs.length &&
          rows.every((row) => row.status === 'SUCCESS' || row.status === 'ERROR')
        )
          return rows;
        if (Date.now() > deadline) throw new Error('Timed out waiting for the reconciliation burst');
        await Bun.sleep(10);
      }
    })();

    await Promise.all(orders.map((order) => enqueueReconciliation(fixture, order.id)));
    const rows = await monitor;
    expect(rows).toHaveLength(200);
    expect(rows.every((row) => row.status === 'SUCCESS')).toBe(true);
    expect(maximumPending).toBeLessThanOrEqual(8);

    const route = routeOf(orders[0]!.id)!;
    const saved = await fixture.pool.query(
      'SELECT order_id, checkout_session_id FROM commerce.purchase_order WHERE route=$1 AND order_id=ANY($2::uuid[])',
      [route, orders.map((order) => order.id)],
    );
    expect(saved.rows).toHaveLength(200);
    expect(saved.rows.every((row) => row.checkout_session_id !== null)).toBe(true);
    expect(new Set(saved.rows.map((row) => row.checkout_session_id)).size).toBe(200);

    for (const order of lost) {
      const creates = fixture.transport.fake.requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path === '/v1/checkout/sessions' &&
          request.params.get('client_reference_id') === order.id,
      );
      expect(creates).toHaveLength(1);
      expect(
        [...fixture.transport.fake.sessions.values()].filter((session) => session.client_reference_id === order.id),
      ).toHaveLength(1);
    }
    expect(
      fixture.transport.fake.requests.filter((request) => /^\/v1\/checkout\/sessions\/[^/]+$/.test(request.path)),
    ).toHaveLength(200);
  } finally {
    await fixture.close();
  }
});

test('reconciliation finishes after one sync and its delayed expiry workflow repairs a missed webhook', async () => {
  const fixture = await workFixture();
  await fixture.start();
  try {
    const { order, session } = await fixture.checkout();
    const reconcileID = await enqueueReconciliation(fixture, order.id);
    await fixture.finish(reconcileID);

    expect(await fixture.client.getWorkflow(reconcileID)).toMatchObject({
      status: 'SUCCESS',
      workflowName: 'commerce.reconcileOrder',
      queueName: 'workflows',
    });
    const expiryID = `order:${order.id}:expiry`;
    const expiry = await fixture.client.getWorkflow(expiryID);
    expect(expiry).toMatchObject({
      status: 'DELAYED',
      workflowName: 'commerce.expirySync',
      queueName: 'workflows',
    });
    const stored = await fixture.pool.query(
      'SELECT checkout_expires_at::text AS expires_at FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
      [routeOf(order.id), order.id],
    );
    const expectedDelayUntil = Date.parse(stored.rows[0]!.expires_at) + 600_000;
    expect(expiry!.delayUntilEpochMS).toBeGreaterThanOrEqual(expectedDelayUntil - 2_000);
    expect(expiry!.delayUntilEpochMS).toBeLessThanOrEqual(expectedDelayUntil + 2_000);
    expect(
      fixture.transport.fake.requests.filter((request) => request.path === `/v1/checkout/sessions/${session.id}`),
    ).toHaveLength(1);

    fixture.transport.fake.expire(session.id);
    await fixture.client.setWorkflowDelay(expiryID, { delayUntilEpochMS: Date.now() });
    await fixture.finish(expiryID);
    expect(await fixture.client.getWorkflow(expiryID)).toMatchObject({ status: 'SUCCESS' });
    expect(await fixture.state(order.id)).toMatchObject({ settlement: 'failed' });
    expect(await fixture.entitlements(order.id)).toHaveLength(0);
    expect(
      fixture.transport.fake.requests.filter((request) => request.path === `/v1/checkout/sessions/${session.id}`),
    ).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test('durable command steps recover after the buyer partition is briefly unavailable', async () => {
  const fixture = await workFixture();
  await fixture.start();
  const lost = await fixture.order();
  const paid = await fixture.checkout();
  fixture.transport.fake.pay(paid.session.id);
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: '-c idle_in_transaction_session_timeout=30000',
  });
  const connection = await admin.connect();
  let lockHeld = false;
  try {
    const partition = partitionOf(routeOf(lost.id)!);
    await connection.query('BEGIN');
    await connection.query('SELECT partition_no FROM core.partition WHERE partition_no=$1 FOR UPDATE', [partition]);
    lockHeld = true;

    const reconcileID = await enqueueReconciliation(fixture, lost.id);
    const event = await fixture.deliver('checkout.session.completed', paid.session.id);
    await Bun.sleep(6_500);
    await connection.query('ROLLBACK');
    lockHeld = false;

    await Promise.all([fixture.finish(reconcileID), fixture.finish(event.id)]);
    expect(await fixture.client.getWorkflow(reconcileID)).toMatchObject({ status: 'SUCCESS' });
    expect(await fixture.client.getWorkflow(event.id)).toMatchObject({ status: 'SUCCESS' });
    const saved = await fixture.pool.query(
      'SELECT checkout_session_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
      [routeOf(lost.id), lost.id],
    );
    expect(saved.rows[0]!.checkout_session_id).not.toBeNull();
    expect(
      fixture.transport.fake.requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path === '/v1/checkout/sessions' &&
          request.params.get('client_reference_id') === lost.id,
      ),
    ).toHaveLength(1);
    expect(await fixture.entitlements(paid.order.id)).toHaveLength(1);
    expect(await fixture.events(paid.order.id, 'entitlement.granted')).toHaveLength(1);
  } finally {
    if (lockHeld) await connection.query('ROLLBACK');
    connection.release();
    await admin.end();
    await fixture.close();
  }
});
