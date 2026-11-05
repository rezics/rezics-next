import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { reconcileOrder } from '../../src/commerce/order-reconcile.ts';
import type { Offer } from '../../src/commerce/model.ts';
import * as store from '../../src/commerce/store.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountToken } from '../support/admitted-access.ts';
import {
  createProfileEntryFixture,
  entryKey,
  type NativeProfileFixture,
} from '../library/support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
setDefaultTimeout(30_000);
let buyer: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let peer: typeof buyer;
let orderId: string;
const scopes = ['order:reconcile', 'order:read', 'order:create'];
const path = (id = orderId) => `/v1/orders/${id}:reconcile`;

/** Historical recorded orders need no fresh sale or provider create to request repair. */
async function recordedOrder(person = buyer, session = true) {
  const route = routeOf(person.actor.accountId)!;
  const id = newId(route);
  const offer: Offer = {
    id: newId(route),
    creatorAccountId: person.actor.accountId,
    targetSubjectId: newId(route),
    title: 'Recorded purchase',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    state: 'active',
    revision: 1,
    contentEdition: null,
  };
  await runCommand(f.pool, { partition: partitionOf(route) }, async (tx, command) => {
    const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
    await store.insertOrder(tx, route, { id, buyerAccountId: person.actor.accountId, offer }, context);
    if (session)
      await store.recordCheckoutSession(
        tx,
        route,
        id,
        {
          id: `cs_test_${id.replaceAll('-', '')}`,
          url: 'https://checkout.stripe.com/c/pay/recorded',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
        context,
      );
    return {
      value: id,
      events: [{ type: 'com.rezics.commerce.order.created.v1', subject: id, data: { orderId: id } }],
    };
  });
  return id;
}

beforeAll(async () => {
  f = await createProfileEntryFixture({ projectLinks: false });
  buyer = await f.identity(scopes);
  // Real provisioned accounts, including a different buyer in the exact same home route.
  for (let n = 0; n < 256; n++) {
    const candidate = await f.identity(scopes, partitionOf(routeOf(buyer.actor.accountId)!));
    if (routeOf(candidate.actor.accountId) === routeOf(buyer.actor.accountId)) {
      peer = candidate;
      break;
    }
  }
  expect(peer).toBeDefined();
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/purchases:open', {})).status).toBe(200);
  orderId = await recordedOrder();
});
afterAll(async () => f?.close());

async function repairEvents(id = orderId) {
  const result = await f.pool.query(
    'SELECT type, data FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position',
    [partitionOf(routeOf(id)!), id],
  );
  return result.rows.filter((event) => event.type === 'com.rezics.commerce.order.repair_requested.v1');
}

test('An authorized buyer explicitly requests current known-order reconciliation once and sees queued rather than paid while foreign stale or unconsented requests enqueue nothing', async () => {
  // No provider port is installed or called by this native command.
  const config = { pool: f.pool, access: f.access, deadline: Date.now() + 30_000, repairAvailable: true };
  const key = entryKey();
  const first = await reconcileOrder(config, buyer.actor, orderId, key);
  expect(first.value).toEqual({ orderId, reconciliation: 'queued' });
  expect((await store.readOrder(f.pool, routeOf(orderId)!, orderId))?.settlement).toBe('pending');
  expect(await repairEvents()).toHaveLength(1);
  // A worker revision does not turn the same command into a new effect or changed response.
  await f.pool.query('UPDATE commerce.purchase_order SET revision=revision+1 WHERE route=$1 AND order_id=$2', [
    routeOf(orderId),
    orderId,
  ]);
  const replay = await reconcileOrder(config, buyer.actor, orderId, key);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(first.value);
  expect(await repairEvents()).toHaveLength(1);
  const another = await recordedOrder();
  await expect(reconcileOrder(config, buyer.actor, another, key)).rejects.toMatchObject({
    name: 'IdempotencyConflictError',
  });

  const before = await repairEvents();
  for (const [actor, target] of [
    [peer.actor, orderId],
    [buyer.actor, newId(routeOf(orderId)!)],
  ] as const)
    await expect(reconcileOrder(config, actor, target, entryKey())).rejects.toMatchObject({ name: 'GrantDeniedError' });
  for (const claims of [
    { ...buyer.actor, scopes: ['order:read', 'order:create'] },
    { ...buyer.actor, requestedBy: peer.actor.accountId },
  ]) {
    const token = await accountToken(claims);
    const actor = await f.access.authenticate(token, { pool: f.pool, deadline: Date.now() + 30_000 });
    await expect(reconcileOrder(config, actor, orderId, key)).rejects.toMatchObject({ name: 'GrantDeniedError' });
  }
  expect(await repairEvents()).toEqual(before);
  const stale = await f.identity(scopes);
  const staleOrder = await recordedOrder(stale);
  await f.revokeIdentity(stale.actor.accountId);
  await expect(reconcileOrder(config, stale.actor, staleOrder, entryKey())).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
  expect(await repairEvents(staleOrder)).toHaveLength(0);
  expect(await repairEvents()).toEqual(before);
});

test('the public route conceals foreign/unknown orders and rejects locator or permission fields', async () => {
  const foreign = await recordedOrder(peer);
  for (const id of [foreign, newId(routeOf(orderId)!)])
    expect((await f.send(buyer.bearer, 'POST', path(id), {})).status).toBe(404);
  for (const body of [{ buyerAccountId: peer.actor.accountId }, { sessionId: 'cs_test_candidate' }, { allow: true }])
    expect((await f.send(peer.bearer, 'POST', path(foreign), body)).status).toBe(400);
  expect(await repairEvents(foreign)).toHaveLength(0);
});

test('missing Session and unavailable repair infrastructure preserve unknown purchase truth without an intent', async () => {
  const missing = await recordedOrder(peer, false);
  const config = { pool: f.pool, access: f.access, deadline: Date.now() + 30_000, repairAvailable: true };
  await expect(reconcileOrder(config, peer.actor, missing, entryKey())).rejects.toMatchObject({
    name: 'StripeUnavailableError',
  });
  expect(await repairEvents(missing)).toHaveLength(0);
  const known = await recordedOrder(peer);
  await expect(
    reconcileOrder({ ...config, repairAvailable: false }, peer.actor, known, entryKey()),
  ).rejects.toMatchObject({ name: 'StripeUnavailableError' });
  expect(await repairEvents(known)).toHaveLength(0);
  await f.pool.query(
    "UPDATE commerce.purchase_order SET settlement='paid', revision=revision+1 WHERE route=$1 AND order_id=$2",
    [routeOf(known), known],
  );
  expect((await reconcileOrder(config, peer.actor, known, entryKey())).value).toEqual({
    orderId: known,
    reconciliation: 'queued',
  });
  expect((await store.readOrder(f.pool, routeOf(known)!, known))?.settlement).toBe('paid');
});
