import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import * as model from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { CheckoutMismatchError } from '../../src/commerce/settlement.ts';
import { readOrder, readOrderTransactions } from '../../src/commerce/store.ts';
import { createCommerceWork } from '../../src/commerce/work.ts';
import { routeOf } from '../../src/route/route.ts';
import { composeWork } from '../../src/work/registry.ts';
import { workFixture } from './support/work-fixture.ts';

let fixture: Awaited<ReturnType<typeof workFixture>>;
let proxy: ReturnType<typeof Bun.serve>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let stripe: ReturnType<typeof createStripePort>;
let transactionCount = 256;
beforeAll(async () => {
  fixture = await workFixture();
  // A dispute can embed many balance transactions even with the existing ten-dispute object cap.
  proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/disputes')
        return Response.json({
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'du_bounds',
              status: 'won',
              amount: 0,
              balance_transactions: Array.from({ length: transactionCount - 1 }, (_, n) => ({
                id: `txn_bounds${n}`,
                amount: 1,
                fee: 0,
                net: 1,
                currency: 'usd',
                fee_details: [],
                exchange_rate: null,
                created: 1767225600,
              })),
            },
          ],
        });
      return fetch(`http://127.0.0.1:${fixture.transport.port}${url.pathname}${url.search}`, request);
    },
  });
  stripe = createStripePort({
    apiKey: 'sk_test_bounds',
    managedPayments: false,
    host: '127.0.0.1',
    port: proxy.port!,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
  worker = await composeWork(
    [
      createCommerceWork({
        stripe,
        checkout: { successUrl: 'https://test/success', cancelUrl: 'https://test/cancel' },
      }),
    ],
    { pool: fixture.pool, client: fixture.client, databaseUrl: process.env.DATABASE_URL!, executorId: 'order-bounds' },
  );
  await worker.launch();
}, 30_000);
afterAll(async () => {
  await worker?.shutdown();
  await proxy?.stop(true);
  await fixture?.close();
}, 30_000);

async function contents(orderId: string) {
  const result: unknown[] = [];
  for (const table of ['purchase_order', 'order_transaction', 'entitlement']) {
    result.push(
      (
        await fixture.pool.query(`SELECT * FROM commerce.${table} WHERE route=$1 AND order_id=$2 ORDER BY 1,2,3`, [
          routeOf(orderId),
          orderId,
        ])
      ).rows,
    );
  }
  result.push(
    (await fixture.pool.query("SELECT * FROM core.outbox WHERE data->>'orderId'=$1 ORDER BY id", [orderId])).rows,
  );
  result.push((await fixture.pool.query('SELECT * FROM core.receipt ORDER BY partition_no, idempotency_key')).rows);
  return result;
}

test('an order at the 256 transaction cap records every transaction and replay changes nothing', async () => {
  expect(model).toMatchObject({ MAX_ORDER_TRANSACTIONS: 256 });
  transactionCount = 256;
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const snapshot = await stripe.readCheckout(session.id);
  expect(snapshot.transactions).toHaveLength(256);
  await fixture.commands.applyCheckoutSnapshot(snapshot, 'bounds:cap');
  expect(await readOrderTransactions(fixture.pool, routeOf(order.id)!, order.id)).toHaveLength(256);
  const before = await contents(order.id);
  expect(await fixture.commands.applyCheckoutSnapshot(snapshot, 'bounds:replay')).toMatchObject({ changed: false });
  expect(await contents(order.id)).toEqual(before);
});

test('one over the cap is a visible adapter and workflow failure and writes nothing', async () => {
  transactionCount = 257;
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const before = await contents(order.id);
  // Commerce README's physical provider limits classify an incomplete over-cap read as unavailable.
  // Keep the native trusted-snapshot mismatch assertion below and every no-write/workflow assertion.
  await expect(stripe.readCheckout(session.id)).rejects.toBeInstanceOf(model.StripeUnavailableError);
  const event = await fixture.deliver('checkout.session.completed', session.id);
  await expect(fixture.finish(event.id)).rejects.toThrow();
  expect(await fixture.client.getWorkflow(event.id)).toMatchObject({ status: 'ERROR' });
  expect(await contents(order.id)).toEqual(before);
});

test('the trusted snapshot command also rejects an over-cap snapshot before any SQL', async () => {
  transactionCount = 256;
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const snapshot = await stripe.readCheckout(session.id);
  snapshot.transactions.push({ ...snapshot.transactions[0]!, id: 'txn_overcap' });
  const before = await contents(order.id);
  let queries = 0;
  const original = fixture.pool.query;
  fixture.pool.query = ((...args: Parameters<typeof original>) => {
    queries++;
    return Reflect.apply(original, fixture.pool, args);
  }) as typeof original;
  try {
    await expect(fixture.commands.applyCheckoutSnapshot(snapshot, 'bounds:command')).rejects.toBeInstanceOf(
      CheckoutMismatchError,
    );
    expect(queries).toBe(0);
  } finally {
    fixture.pool.query = original;
  }
  expect(await contents(order.id)).toEqual(before);
});

test('stored order transactions stay within the cap across snapshots with different IDs', async () => {
  transactionCount = 200;
  const rejectedOrder = await fixture.checkout();
  fixture.transport.fake.pay(rejectedOrder.session.id);
  const rawInitial = await stripe.readCheckout(rejectedOrder.session.id);
  const initial = {
    ...rawInitial,
    transactions: rawInitial.transactions.map((transaction) => ({
      ...transaction,
      id: `txn_${transaction.id.slice(4)}${rejectedOrder.order.id.replaceAll('-', '')}`,
    })),
  };
  await fixture.commands.applyCheckoutSnapshot(initial, 'bounds:seed-rejected');
  const extra = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      ...initial.transactions[0]!,
      id: `txn_boundsnew${rejectedOrder.order.id.replaceAll('-', '')}${n}`,
    }));
  const tooMany = {
    ...initial,
    observedAt: new Date(Date.parse(initial.observedAt) + 1_000).toISOString(),
    transactions: extra(57),
  };
  const before = await contents(rejectedOrder.order.id);
  await expect(fixture.commands.applyCheckoutSnapshot(tooMany, 'bounds:stored-over-cap')).rejects.toBeInstanceOf(
    CheckoutMismatchError,
  );
  expect(await contents(rejectedOrder.order.id)).toEqual(before);

  const acceptedOrder = await fixture.checkout();
  fixture.transport.fake.pay(acceptedOrder.session.id);
  const rawAcceptedInitial = await stripe.readCheckout(acceptedOrder.session.id);
  const acceptedInitial = {
    ...rawAcceptedInitial,
    transactions: rawAcceptedInitial.transactions.map((transaction) => ({
      ...transaction,
      id: `txn_${transaction.id.slice(4)}${acceptedOrder.order.id.replaceAll('-', '')}`,
    })),
  };
  await fixture.commands.applyCheckoutSnapshot(acceptedInitial, 'bounds:seed-accepted');
  const acceptedSnapshot = {
    ...acceptedInitial,
    observedAt: new Date(Date.parse(acceptedInitial.observedAt) + 1_000).toISOString(),
    transactions: Array.from({ length: 56 }, (_, n) => ({
      ...acceptedInitial.transactions[0]!,
      id: `txn_boundsaccepted${acceptedOrder.order.id.replaceAll('-', '')}${n}`,
    })),
  };
  await fixture.commands.applyCheckoutSnapshot(acceptedSnapshot, 'bounds:stored-at-cap');
  expect(
    await readOrderTransactions(fixture.pool, routeOf(acceptedOrder.order.id)!, acceptedOrder.order.id),
  ).toHaveLength(256);
});

test('fulfilment without new transactions does not add a transaction-count statement', async () => {
  transactionCount = 2;
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const rawSnapshot = await stripe.readCheckout(session.id);
  const snapshot = {
    ...rawSnapshot,
    transactions: rawSnapshot.transactions.map((transaction) => ({
      ...transaction,
      id: `txn_${transaction.id.slice(4)}${order.id.replaceAll('-', '')}`,
    })),
  };
  await fixture.commands.applyCheckoutSnapshot(snapshot, 'bounds:statement-seed');
  const later = {
    ...snapshot,
    observedAt: new Date(Date.parse(snapshot.observedAt) + 1_000).toISOString(),
    disputes: [{ ...snapshot.disputes[0]!, status: 'lost' }],
  };
  let queries = 0;
  const tracked = new WeakSet<object>();
  const onAcquire = (client: PoolClient) => {
    if (tracked.has(client)) return;
    tracked.add(client);
    const originalQuery = client.query.bind(client);
    client.query = ((...queryArgs: Parameters<typeof originalQuery>) => {
      queries++;
      return Reflect.apply(originalQuery, client, queryArgs);
    }) as typeof client.query;
  };
  fixture.pool.on('acquire', onAcquire);
  try {
    await fixture.commands.applyCheckoutSnapshot(later, 'bounds:no-new-transaction');
  } finally {
    fixture.pool.removeListener('acquire', onAcquire);
  }
  expect(queries).toBe(17);
  expect(await readOrderTransactions(fixture.pool, routeOf(order.id)!, order.id)).toHaveLength(
    snapshot.transactions.length,
  );
});

test('grant uses the target captured at order creation when the creator offer is gone', async () => {
  transactionCount = 1;
  const { order, session } = await fixture.checkout();
  const offer = (
    await fixture.pool.query('SELECT target_subject_id FROM commerce.offer WHERE route=$1 AND offer_id=$2', [
      routeOf(order.offerId),
      order.offerId,
    ])
  ).rows[0]!;
  expect(await readOrder(fixture.pool, routeOf(order.id)!, order.id)).toMatchObject({
    targetSubjectId: offer.target_subject_id,
  });
  await fixture.pool.query('DELETE FROM commerce.offer WHERE route=$1 AND offer_id=$2', [
    routeOf(order.offerId),
    order.offerId,
  ]);
  fixture.transport.fake.pay(session.id);
  await fixture.commands.applyCheckoutSnapshot(await stripe.readCheckout(session.id), 'bounds:missing-offer');
  expect(await fixture.entitlements(order.id)).toMatchObject([
    { target_subject_id: offer.target_subject_id, revoked_at: null },
  ]);
});
