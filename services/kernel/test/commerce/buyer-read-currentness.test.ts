import { afterAll, beforeAll, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { SESSION_HEADER } from '../../src/http/headers.ts';
import { encodeSession } from '../../src/tokens/session.ts';
import { testTokens } from '../support/test-kernel.ts';
import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { buyerReadCurrentnessFixture } from './support/buyer-read-currentness-fixture.ts';

let f: Awaited<ReturnType<typeof buyerReadCurrentnessFixture>>;
type SeededBuyerOrder = {
  orderId: string;
  entitlementId: string;
  targetSubjectId: string;
};
let aliceOrder: SeededBuyerOrder;
let aliceOtherOrder: SeededBuyerOrder;
let peerOrder: SeededBuyerOrder;

beforeAll(async () => {
  f = await buyerReadCurrentnessFixture();
  await f.openPurchases();
  aliceOrder = await f.seedRefundedOrder(f.people.alice, 'alice1');
  aliceOtherOrder = await f.seedRefundedOrder(f.people.alice, 'alice2');
  peerOrder = await f.seedRefundedOrder(f.peer, 'peer1');
}, 120_000);

afterAll(async () => f?.close());

test('mounted buyer pages and point reads retain refunded terms and current entitlement state', async () => {
  const ordersResponse = await f.request('/v1/orders?limit=1');
  expect(ordersResponse.status).toBe(200);
  expect(ordersResponse.headers.get('cache-control')).toBe('private, no-store');
  const orders = await ordersResponse.json();
  expect(orders.orders).toHaveLength(1);
  expect(orders.next).toBeString();
  expect(orders.orders[0]).toMatchObject({
    id: aliceOtherOrder.orderId,
    title: 'Captured alice2',
    settlement: 'paid',
    currency: 'usd',
    unitAmountMinor: 2500,
    amountTaxMinor: 0,
    entitlementId: aliceOtherOrder.entitlementId,
  });
  expect(orders.orders[0].moneyUnit).toEqual({
    system: 'stripe-api',
    exponent: 2,
    factsVersion: 'stripe-money-v1',
  });

  const orderResponse = await f.request(`/v1/orders/${aliceOrder.orderId}`);
  expect(orderResponse.status).toBe(200);
  expect(orderResponse.headers.get('cache-control')).toBe('private, no-store');
  expect((await orderResponse.json()).order).toMatchObject({
    id: aliceOrder.orderId,
    title: 'Captured alice1',
    settlement: 'paid',
    currency: 'usd',
    unitAmountMinor: 2500,
    amountTaxMinor: 0,
    entitlementId: aliceOrder.entitlementId,
    recordedCharge: {
      currency: 'usd',
      moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
      amountTotalMinor: 2500,
      amountTaxMinor: 0,
    },
    recordedPresentment: null,
  });

  const entitlementsResponse = await f.request('/v1/entitlements?limit=1');
  expect(entitlementsResponse.status).toBe(200);
  expect(entitlementsResponse.headers.get('cache-control')).toBe('private, no-store');
  const entitlements = await entitlementsResponse.json();
  expect(entitlements.entitlements).toHaveLength(1);
  expect(entitlements.next).toBeString();
  expect(entitlements.entitlements[0]).toMatchObject({
    id: aliceOtherOrder.entitlementId,
    orderId: aliceOtherOrder.orderId,
    active: false,
    revokeReason: 'refund',
  });

  const entitlementResponse = await f.request(`/v1/entitlements/${aliceOrder.entitlementId}`);
  expect(entitlementResponse.status).toBe(200);
  expect(entitlementResponse.headers.get('cache-control')).toBe('private, no-store');
  expect((await entitlementResponse.json()).entitlement).toMatchObject({
    id: aliceOrder.entitlementId,
    orderId: aliceOrder.orderId,
    active: false,
    revokeReason: 'refund',
  });
});

test('same-route owners stay concealed and native account/scope refusals precede private reads', async () => {
  expect(routeOf(f.peer.accountId)).toBe(routeOf(f.people.alice.accountId));
  const ownOrders = await f.request('/v1/orders', f.peer);
  expect(ownOrders.status).toBe(200);
  expect((await ownOrders.json()).orders.map((order: { id: string }) => order.id)).toEqual([peerOrder.orderId]);
  const ownEntitlements = await f.request('/v1/entitlements', f.peer);
  expect(ownEntitlements.status).toBe(200);
  expect((await ownEntitlements.json()).entitlements.map((entitlement: { id: string }) => entitlement.id)).toEqual([
    peerOrder.entitlementId,
  ]);
  expect((await f.request(`/v1/orders/${aliceOrder.orderId}`, f.peer)).status).toBe(404);
  expect((await f.request(`/v1/entitlements/${aliceOrder.entitlementId}`, f.peer)).status).toBe(404);

  expect((await f.request('/v1/orders', f.people.revoked)).status).toBe(401);
  expect((await f.request('/v1/orders', f.people.delegated)).status).toBe(403);
});

test('buyer home fences, session-ahead and stale signed continuations stop disclosure', async () => {
  const route = routeOf(f.people.alice.accountId)!;
  const partition = partitionOf(route);
  const state = await f.db.admin.query<{ epoch: number; position: string }>(
    'SELECT epoch, position::text FROM core.partition WHERE partition_no=$1',
    [partition],
  );
  const ahead = encodeSession(testTokens(), `account:${f.people.alice.accountId}`, [
    { partition, epoch: state.rows[0]!.epoch, position: BigInt(state.rows[0]!.position) + 1n },
  ]);
  expect((await f.request('/v1/orders', f.people.alice, { headers: { [SESSION_HEADER]: ahead } })).status).toBe(503);

  const orderPage = await f.request('/v1/orders?limit=1');
  const orderCursor = (await orderPage.json()).next as string;
  const entitlementPage = await f.request('/v1/entitlements?limit=1');
  const entitlementCursor = (await entitlementPage.json()).next as string;
  await f.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
  try {
    expect((await f.request(`/v1/orders?limit=1&cursor=${encodeURIComponent(orderCursor)}`)).status).toBe(409);
    expect((await f.request(`/v1/entitlements?limit=1&cursor=${encodeURIComponent(entitlementCursor)}`)).status).toBe(
      409,
    );
  } finally {
    await f.db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partition]);
  }

  for (const state of ['fenced', 'moved'] as const) {
    await f.db.admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
      partition,
      state,
      state === 'moved' ? 'buyer-history-moved' : null,
    ]);
    try {
      expect((await f.request(`/v1/orders/${aliceOrder.orderId}`)).status).toBe(503);
    } finally {
      await f.db.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [
        partition,
      ]);
    }
  }
});

test('suspension during a paused foreign summary prevents the point receipt from returning', async () => {
  const gate = await f.pauseSummary();
  const pending = f.request(`/v1/orders/${aliceOrder.orderId}`);
  try {
    await gate.entered;
    await suspendAccount(f.pool, f.people.alice.accountId);
    gate.release();
    expect((await pending).status).toBe(404);
  } finally {
    gate.release();
    await reinstateAccount(f.pool, f.people.alice.accountId);
  }
});

test('revoked native consent during a paused foreign summary prevents the point receipt from returning', async () => {
  const buyer = await f.signIn(f.people.alice.accountId);
  const gate = await f.pauseSummary();
  const pending = f.request(`/v1/orders/${aliceOrder.orderId}`, buyer);
  try {
    await gate.entered;
    await f.setConsent(buyer.accountId, []);
    gate.release();
    expect((await pending).status).toBe(404);
  } finally {
    gate.release();
    await f.setConsent(buyer.accountId, ['order:read', 'entitlement:list', 'entitlement:read']);
  }
});
