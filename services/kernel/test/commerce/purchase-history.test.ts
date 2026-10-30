import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Order } from '../../src/commerce/model.ts';
import { partitionOf, newId, routeOf } from '../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { capture } from '../support/growth.ts';
import { purchaseHistoryFixture, type HistoryFixture } from './support/purchase-history-fixture.ts';

setDefaultTimeout(360_000);
let f: HistoryFixture;
const purchases: Order[] = [];
let foreign: Order;

beforeAll(async () => {
  f = await purchaseHistoryFixture();
  for (let i = 0; i < 103; i++) purchases.push(await f.checkout());
  foreign = await f.checkout(f.peer);
  await f.checkout(f.people.bob);
}, 360_000);
afterAll(async () => f?.close());

async function page(query: { limit?: number; cursor?: string } = {}) {
  const response = await f.client().orders.get({ query });
  expect(response.status).toBe(200);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.data!;
}
async function denied(path: string, as: { bearer: string | null }, status: number, code?: string) {
  const result = await capture(f.db, () => f.request(path, as));
  expect(result.value.status).toBe(status);
  if (code) expect((await result.value.json()).code).toBe(code);
  expect(
    result.capture.statements.filter((sql) => /(?:FROM|JOIN) commerce\.(?:purchase_order|entitlement)/i.test(sql)),
  ).toEqual([]);
}

test('the real typed caller discovers captured orders after Checkout and follows exact payment/refund entitlement state', async () => {
  const order = purchases[0]!;
  expect(f.fake.sessions.get(order.checkoutSessionId!)?.success_url).toContain(order.id);
  f.fake.pay(order.checkoutSessionId!);
  await f.event('checkout.session.completed', order.checkoutSessionId!);
  const seller = await f.actor(f.people.staff);
  await f.commands.reviseOffer(seller, f.offer.id, { unitAmountMinor: 9900 }, Bun.randomUUIDv7());
  await f.commands.delistOffer(seller, f.offer.id, Bun.randomUUIDv7());
  expect((await f.request(`/v1/offers/${f.offer.id}`)).status).toBe(404);

  // Visit every captured row using the shipped client, including a deep page after a Checkout return.
  let cursor: string | undefined;
  const seen: string[] = [];
  let paidRow: Awaited<ReturnType<typeof page>>['orders'][number] | undefined;
  do {
    const history = await page({ limit: 20, ...(cursor ? { cursor } : {}) });
    expect(history.orders.length).toBeLessThanOrEqual(20);
    for (const row of history.orders) {
      expect(row).toMatchObject({
        title: 'Captured purchase',
        offerId: f.offer.id,
        offerRevision: f.offer.revision,
        targetSubjectId: f.offer.targetSubjectId,
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      });
      expect(Object.keys(row)).not.toContain('buyerAccountId');
      expect(Object.keys(row)).not.toContain('checkoutSessionId');
      const exact = await f.client().orders({ orderId: row.id }).get();
      expect(exact.status).toBe(200);
      if (exact.error) throw new Error(JSON.stringify(exact.error));
      expect(exact.data!.order).toMatchObject({
        id: row.id,
        title: row.title,
        settlement: row.settlement,
        entitlementId: row.entitlementId,
      });
      seen.push(row.id);
      if (row.id === order.id) paidRow = row;
    }
    cursor = history.next ?? undefined;
  } while (cursor);
  expect(seen).toEqual(
    purchases
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
  expect(new Set(seen).size).toBe(103);
  expect(paidRow).toMatchObject({ settlement: 'paid', amountTaxMinor: 0 });
  expect(paidRow!.entitlementId).toBeString();
  const entitlementId = paidRow!.entitlementId!;
  const granted = await f.client().entitlements({ entitlementId }).get();
  expect(granted.status).toBe(200);
  expect(granted.data?.entitlement).toMatchObject({ orderId: order.id, active: true, revokedAt: null });

  f.fake.refundRemaining(order.checkoutSessionId!, 'remaining');
  await f.event('charge.refunded', f.fake.chargeId(order.checkoutSessionId!));
  const exact = await f.client().orders({ orderId: order.id }).get();
  expect(exact.data?.order).toMatchObject({ settlement: 'paid', entitlementId });
  const revoked = await f.client().entitlements({ entitlementId }).get();
  expect(revoked.data?.entitlement).toMatchObject({ orderId: order.id, active: false, revokeReason: 'refund' });
  expect(revoked.data?.entitlement.revokedAt).toBeString();
  // Reload the same final history page: captured terms survive both price changes and refund.
  const final = await page({ limit: 100 });
  const tail = await page({ limit: 100, cursor: final.next! });
  expect(tail.orders.find((row) => row.id === order.id)).toMatchObject({
    settlement: 'paid',
    entitlementId,
    unitAmountMinor: 1200,
  });
});

test('default/max limits, complete exclusive keysets, empty history and no foreign account selector', async () => {
  const normal = await page();
  expect(Object.keys(normal).sort()).toEqual(['next', 'orders']);
  expect(normal.orders).toHaveLength(20);
  expect(normal.next).toBeString();
  const maximum = await page({ limit: 100 });
  expect(maximum.orders).toHaveLength(100);
  const tail = await page({ cursor: maximum.next!, limit: 100 });
  expect(tail.orders).toHaveLength(3);
  expect(tail.next).toBeNull();
  const other = await f.client(f.peer).orders.get();
  expect(other.data?.orders.map((row) => row.id)).toEqual([foreign.id]);
  const empty = await f.client(f.people.orgOwner).orders.get();
  expect(empty.data).toEqual({ orders: [], next: null });
  for (const limit of [0, 101, -1, 1.5]) {
    const response = await f.request(`/v1/orders?limit=${limit}`);
    expect(response.status).toBe(400);
  }
  // Unknown account filters cannot select the victim's rows, regardless of schema stripping/rejection.
  const attempted = await f.request(`/v1/orders?accountId=${f.people.alice.accountId}`, f.peer);
  if (attempted.status === 200)
    expect((await attempted.json()).orders.map((row: { id: string }) => row.id)).toEqual([foreign.id]);
  else expect(attempted.status).toBe(400);
  expect((await f.request(`/v1/orders/${purchases[0]!.id}`, f.peer)).status).toBe(404);
  expect((await f.request(`/v1/orders/${newId(routeOf(f.people.alice.accountId)!)}`, f.peer)).status).toBe(404);
});

test('anonymous, unrelated scope, real suspended and revoked credentials refuse before private SQL', async () => {
  await denied('/v1/orders', f.people.anonymous, 401);
  await denied('/v1/orders', f.people.suspended, 401);
  await denied('/v1/orders', f.people.revoked, 401);
  const unscoped = await f.people.unscoped('order:read');
  await denied('/v1/orders', unscoped, 403, 'forbidden');
});

test('cursor signatures bind viewer and operation; invalid shapes and changed epochs fail closed', async () => {
  const first = await page({ limit: 1 });
  const token = first.next!;
  for (const invalid of ['malformed', first.orders[0]!.id, `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`])
    await denied(`/v1/orders?cursor=${encodeURIComponent(invalid)}`, f.people.alice, 400, 'invalid_cursor');
  await denied(`/v1/orders?cursor=${encodeURIComponent(token)}`, f.peer, 400, 'invalid_cursor');
  await denied(`/v1/entitlements?cursor=${encodeURIComponent(token)}`, f.people.alice, 400, 'invalid_cursor');
  const binding = { operation: 'order.list', parameters: { accountId: f.people.alice.accountId } };
  const decoded = decodeCursor(f.keys, binding, token);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Expected a signed native cursor');
  for (const after of [
    [],
    [123],
    ['invalid'],
    [newId((routeOf(f.people.alice.accountId)! + 16) % 65536)],
    ['one', 'two'],
  ]) {
    const invalid = encodeCursor(f.keys, binding, { epoch: decoded.epoch, after });
    await denied(`/v1/orders?cursor=${encodeURIComponent(invalid)}`, f.people.alice, 400, 'invalid_cursor');
  }
  const expired = encodeCursor(
    f.keys,
    binding,
    { epoch: decoded.epoch, after: decoded.after },
    Date.now() - 16 * 60_000,
  );
  await denied(`/v1/orders?cursor=${encodeURIComponent(expired)}`, f.people.alice, 400, 'invalid_cursor');
  const partition = partitionOf(routeOf(f.people.alice.accountId)!);
  await f.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
  try {
    await denied(`/v1/orders?cursor=${encodeURIComponent(token)}`, f.people.alice, 409, 'stale_cursor');
  } finally {
    await f.db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partition]);
  }
});

test('native account deletion invalidates its existing purchase-history credentials before private SQL', async () => {
  await deletePersona({ pool: f.db.pool, auth: f.auth }, f.peer);
  await denied('/v1/orders', f.peer, 401);
});
