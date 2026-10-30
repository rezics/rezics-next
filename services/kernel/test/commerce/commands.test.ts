import { AuthenticationError } from '../../src/request/access.ts';
import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { QueryConfig } from 'pg';
import { Value } from 'typebox/value';
import { createAccess } from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCheck, type Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { COMMERCE_EVENTS } from '../../src/commerce/events.ts';
import { createCommerceCommands, OfferUnavailableError } from '../../src/commerce/commands.ts';
import type { CheckoutSnapshot, Order, StripeTransaction } from '../../src/commerce/model.ts';
import * as store from '../../src/commerce/store.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const operator = newId(0x1100);
const seller = newId(0x2200);
const buyer = newId(0x3300);
const other = newId(0x3300);
const suspended = newId(0x4400);
const root = { route: 0, id: GLOBAL_CONTEXT };
const unrelatedRoot = '00000000-0000-8000-8000-000000000099';
const actions = ['access:grant', 'offer:create', 'offer:read', 'offer:manage', 'order:create'];
let access: ReturnType<typeof createAccess>;
let commands: ReturnType<typeof createCommerceCommands>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const key = () => Bun.randomUUIDv7();
const input = () => ({
  targetSubjectId: newId(0x5500),
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
});
async function actor(id: string): Promise<Actor> {
  const current = await pool.query(
    'SELECT minimum_authn_epoch::text AS epoch FROM access.account WHERE route=$1 AND account_id=$2',
    [routeOf(id), id],
  );
  const token = await new SignJWT({
    client_id: 'web',
    scope: actions.join(' '),
    authn_epoch: Number(current.rows[0].epoch),
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'commerce', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  return access.authenticate(token, { pool, deadline: Date.now() + 5000 });
}
beforeAll(async () => {
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'commerce', alg: 'ES256' };
  access = createAccess({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: false,
          ...(action === 'offer:create' ? { 'x-resource-types': ['commerce.offer'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  commands = createCommerceCommands({ pool, access });
  for (const id of [operator, seller, buyer, other, suspended])
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer, access.resource_role_grant, access.resource_initialization, access.resource_grant, access.resource_denial, core.receipt, core.outbox',
  );
  await pool.query("UPDATE access.account SET state='active'");
  // Privileged fixture bootstrap gives the operator ordinary authority on the platform root.
  for (const action of ['access:grant', 'offer:create'])
    await pool.query(
      "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,$3,'(,)',$2)",
      [GLOBAL_CONTEXT, operator, action],
    );
  await createGrantCommands({ pool, access, managementAction: 'access:grant' }).create(
    { pool, deadline: Date.now() + 5000, actor: await actor(operator) },
    { resource: root, subject: { kind: 'account', id: seller }, actions: ['offer:create'], valid: '(,)', key: key() },
  );
});
afterAll(() => pool.end());
async function offer() {
  return (await commands.createOffer(await actor(seller), input(), key())).value;
}
async function order() {
  return (await commands.createOrder(await actor(buyer), (await offer()).id, key())).value;
}
async function footprint() {
  return (
    await pool.query(`SELECT (SELECT count(*)::int FROM core.outbox) AS events, (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM commerce.purchase_order) AS orders, (SELECT count(*)::int FROM commerce.order_transaction) AS transactions,
    (SELECT count(*)::int FROM commerce.entitlement) AS entitlements`)
  ).rows[0];
}
async function events(transactionId: string) {
  const receipt = (
    await pool.query('SELECT partition_no,position FROM core.receipt WHERE transaction_id=$1', [transactionId])
  ).rows[0];
  return (
    await pool.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq', [
      receipt.partition_no,
      receipt.position,
    ])
  ).rows;
}
const event = (name: string, data: unknown) => ({ type: `com.rezics.commerce.${name}.v1`, data });
function transaction(id: string, kind: StripeTransaction['kind'] = 'charge'): StripeTransaction {
  const amountMinor = kind === 'refund' ? -1200 : 1200;
  return {
    id,
    kind,
    sourceId: kind === 'charge' ? 'ch_paid' : 're_refund',
    currency: 'usd',
    amountMinor,
    feeMinor: 0,
    netMinor: amountMinor,
    feeDetails: [],
    exchangeRate: null,
    created: '2026-01-01T00:00:00.000Z',
  };
}
// Normalized documented Checkout Session: subtotal excludes tax; total and charge include tax.
function snapshot(o: Order): CheckoutSnapshot {
  return {
    sessionId: 'cs_test_paid',
    clientReferenceId: o.id,
    metadataOrderId: o.id,
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: 'usd',
    amountSubtotalMinor: 1200,
    amountTaxMinor: 120,
    amountTotalMinor: 1320,
    paymentIntentId: 'pi_paid',
    paymentIntentStatus: 'succeeded',
    chargeId: 'ch_paid',
    chargeAmountMinor: 1320,
    refunds: [],
    disputes: [],
    transactions: [{ ...transaction('txn_charge'), amountMinor: 1320, feeMinor: 60, netMinor: 1260 }],
    observedAt: '2026-01-01T01:00:00.000Z',
  };
}

test('offers are created under the platform root and commerce defines no root of its own', async () => {
  await pool.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [GLOBAL_CONTEXT, seller, 'offer:create'],
  );
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [unrelatedRoot, seller],
  );
  await expect(commands.createOffer(await actor(seller), input(), key())).rejects.toBeInstanceOf(GrantDeniedError);
  await pool.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [unrelatedRoot, seller, 'offer:create'],
  );
  await createGrantCommands({ pool, access, managementAction: 'access:grant' }).create(
    { pool, deadline: Date.now() + 5000, actor: await actor(operator) },
    { resource: root, subject: { kind: 'account', id: seller }, actions: ['offer:create'], valid: '(,)', key: key() },
  );
  const created = await commands.createOffer(await actor(seller), input(), key());
  expect(created.value.creatorAccountId).toBe(seller);
});

test('offers are created by approved sellers and orders by any active account on an active offer at T', async () => {
  const body = { ...input(), royaltyBasisPoints: 1 };
  const created = await commands.createOffer(await actor(seller), body, key());
  const o = created.value;
  expect(o).toMatchObject({ creatorAccountId: seller, royaltyBasisPoints: 9000, state: 'active', revision: 1 });
  expect(routeOf(o.id)).toBe(routeOf(seller));
  expect(await events(created.transactionId)).toEqual([event('offer.created', { offerId: o.id })]);
  for (const action of ['offer:read', 'offer:manage']) {
    const check = await accessCheck(
      access,
      await actor(seller),
      action,
      { route: routeOf(o.id)!, id: o.id },
      { pool, deadline: Date.now() + 5000 },
    );
    expect(await check(pool)).toBe(true);
  }
  for (const id of [buyer, other]) {
    await expect(commands.createOffer(await actor(id), input(), key())).rejects.toBeInstanceOf(GrantDeniedError);
    const purchase = (await commands.createOrder(await actor(id), o.id, key())).value;
    expect(routeOf(purchase.id)).toBe(routeOf(id));
    expect(purchase).toMatchObject({
      offerId: o.id,
      offerRevision: 1,
      buyerAccountId: id,
      title: o.title,
      currency: o.currency,
      unitAmountMinor: o.unitAmountMinor,
      taxCode: o.taxCode,
      royaltyBasisPoints: 9000,
    });
  }
  const suspendedActor = await actor(suspended);
  await suspendAccount(pool, suspended);
  const before = await footprint();
  await expect(commands.createOrder(suspendedActor, o.id, key())).rejects.toBeInstanceOf(AuthenticationError);
  await expect(commands.createOrder({ kind: 'anonymous' }, o.id, key())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.createOrder(await actor(buyer), newId(0x2200), key())).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await footprint()).toEqual(before);
  expect(await commands.readOffer(o.id)).toEqual(o);
  expect(await commands.readOffer(newId(0x2200))).toBeNull();
  const custom = createCommerceCommands({ pool, access, royaltyBasisPoints: 8500 });
  expect((await custom.createOffer(await actor(seller), body, key())).value.royaltyBasisPoints).toBe(8500);
});

test('order creation and checkout recording are idempotent and authorized before receipt lookup', async () => {
  const o = await offer();
  const a = await actor(buyer);
  const requestKey = key();
  const first = await commands.createOrder(a, o.id, requestKey);
  const before = await footprint();
  expect(await commands.createOrder(a, o.id, requestKey)).toEqual({ ...first, replayed: true });
  expect(await footprint()).toEqual(before);
  await expect(commands.createOrder(a, (await offer()).id, requestKey)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  await suspendAccount(pool, buyer);
  await expect(commands.createOrder(a, o.id, requestKey)).rejects.toBeInstanceOf(AuthenticationError);
  await reinstateAccount(pool, buyer);
  const delisted = await commands.delistOffer(await actor(seller), o.id, key());
  expect(delisted.value).toMatchObject({ state: 'delisted', revision: 2 });
  expect(await events(delisted.transactionId)).toEqual([event('offer.delisted', { offerId: o.id })]);
  // Delisting removes availability, not the standing order:create grant. Replay is authorized, then returns its receipt.
  expect((await commands.createOrder(await actor(buyer), o.id, requestKey)).value).toEqual(first.value);
  await expect(commands.createOrder(await actor(buyer), o.id, key())).rejects.toBeInstanceOf(OfferUnavailableError);
  await expect(commands.delistOffer(await actor(other), o.id, key())).rejects.toBeInstanceOf(GrantDeniedError);
  await pool.query(
    "INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'order:create','resource','(,)',$3)",
    [routeOf(o.id), o.id, buyer],
  );
  await expect(commands.createOrder(await actor(buyer), o.id, requestKey)).rejects.toBeInstanceOf(GrantDeniedError);
  const id = first.value.id;
  await commands.recordCheckout(id, { kind: 'unknown' });
  expect(await commands.readOrderForAccount(buyer, id)).toMatchObject({ settlement: 'unknown', revision: 2 });
  await commands.recordCheckout(id, {
    session: { id: 'cs_test_paid', url: 'https://checkout.example.test', expiresAt: '2026-01-02T00:00:00.000Z' },
  });
  expect(await commands.readOrderForAccount(buyer, id)).toMatchObject({
    settlement: 'pending',
    checkoutSessionId: 'cs_test_paid',
    revision: 3,
  });
  const recorded = await footprint();
  for (const outcome of [
    { kind: 'failed' },
    { kind: 'unknown' },
    { session: { id: 'cs_test_other', url: 'https://other.test', expiresAt: '2026-01-02T00:00:00.000Z' } },
  ] as const)
    await commands.recordCheckout(id, outcome);
  expect(await footprint()).toEqual(recorded);
  expect(
    (
      await pool.query(
        "SELECT actor_account_id,idempotency_key FROM core.receipt WHERE command_kind='commerce.checkout.record' ORDER BY idempotency_key",
      )
    ).rows,
  ).toEqual([
    { actor_account_id: buyer, idempotency_key: `order:${id}:checkout:0` },
    { actor_account_id: buyer, idempotency_key: `order:${id}:checkout:1` },
  ]);
  const rejected = await order();
  await commands.recordCheckout(rejected.id, { kind: 'failed' });
  const rejectedBefore = await footprint();
  await commands.recordCheckout(rejected.id, {
    session: { id: 'cs_test_late', url: 'https://late.test', expiresAt: '2026-01-02T00:00:00.000Z' },
  });
  expect(await footprint()).toEqual(rejectedBefore);
  expect(await commands.readOrderForAccount(buyer, rejected.id)).toMatchObject({ settlement: 'failed' });
});

test('a fulfilment command writes order state transactions and entitlement together in the buyer partition and emits their events', async () => {
  const o = await order();
  await commands.recordCheckout(o.id, {
    session: { id: 'cs_test_paid', url: 'https://checkout.example.test', expiresAt: '2026-01-02T00:00:00.000Z' },
  });
  const paid = snapshot(o);
  const before = await footprint();
  for (const wrong of [
    { ...paid, clientReferenceId: newId(0x3300) },
    { ...paid, sessionId: 'cs_test_wrong' },
  ])
    expect(await commands.applyCheckoutSnapshot(wrong, key())).toEqual({ changed: false });
  expect(await footprint()).toEqual(before);
  // A rejected entitlement write must roll back payment state, transactions, events and receipt.
  await pool.query(`CREATE FUNCTION public.reject_commerce_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture grant failure'; END $$;
    CREATE TRIGGER reject_commerce_grant BEFORE INSERT ON commerce.entitlement FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_grant()`);
  try {
    await expect(commands.applyCheckoutSnapshot(paid, key())).rejects.toThrow('fixture grant failure');
  } finally {
    await pool.query(
      'DROP TRIGGER reject_commerce_grant ON commerce.entitlement; DROP FUNCTION public.reject_commerce_grant()',
    );
  }
  expect(await footprint()).toEqual(before);
  expect(await commands.readOrderForAccount(buyer, o.id)).toMatchObject({ settlement: 'pending', revision: 2 });
  const workflow = key();
  const granted = await commands.applyCheckoutSnapshot(paid, workflow);
  expect(granted).toMatchObject({ changed: true, partition: partitionOf(routeOf(buyer)!) });
  const entitlement = (await commands.listEntitlementsForAccount(buyer, { after: null, limit: 10 }))[0]!;
  expect(entitlement).toMatchObject({ orderId: o.id, accountId: buyer, revokedAt: null, revision: 1 });
  expect(routeOf(entitlement.id)).toBe(routeOf(buyer));
  const receipt = (
    await pool.query(
      "SELECT transaction_id FROM core.receipt WHERE command_kind='commerce.checkout.apply' ORDER BY position DESC LIMIT 1",
    )
  ).rows[0];
  expect(await events(receipt.transaction_id)).toEqual([
    event('order.updated', { orderId: o.id, revision: 3 }),
    event('transactions.recorded', { orderId: o.id, creatorAccountId: seller, transactionIds: ['txn_charge'] }),
    event('entitlement.granted', { entitlementId: entitlement.id, orderId: o.id }),
  ]);
  const once = await footprint();
  await commands.applyCheckoutSnapshot(paid, workflow);
  expect(await commands.applyCheckoutSnapshot(paid, key())).toEqual({ changed: false });
  expect(await footprint()).toEqual(once);
  const refund = {
    ...paid,
    observedAt: '2026-01-01T02:00:00.000Z',
    refunds: [{ id: 're_refund', status: 'succeeded', amountMinor: 1320 }],
    transactions: [
      ...paid.transactions,
      { ...transaction('txn_refund', 'refund'), amountMinor: -1320, netMinor: -1320 },
    ],
  };
  await commands.applyCheckoutSnapshot(refund, key());
  expect(await commands.readEntitlementForAccount(buyer, entitlement.id)).toMatchObject({
    revokeReason: 'refund',
    revision: 2,
  });
  const restored = {
    ...refund,
    observedAt: '2026-01-01T03:00:00.000Z',
    refunds: [{ id: 're_refund', status: 'failed', amountMinor: 1320 }],
    transactions: [...refund.transactions, transaction('txn_restore', 'refund_reversal')],
  };
  await commands.applyCheckoutSnapshot(restored, key());
  expect(await commands.readEntitlementForAccount(buyer, entitlement.id)).toMatchObject({
    revokedAt: null,
    revision: 3,
  });
  const all = (
    await pool.query(
      "SELECT type FROM core.outbox WHERE type LIKE 'com.rezics.commerce.%' ORDER BY recorded_at,event_seq",
    )
  ).rows.map((r) => r.type);
  expect(all).toEqual(
    [
      'offer.created',
      'order.created',
      'order.updated',
      'order.updated',
      'transactions.recorded',
      'entitlement.granted',
      'order.updated',
      'transactions.recorded',
      'entitlement.revoked',
      'order.updated',
      'transactions.recorded',
      'entitlement.restored',
    ].map((n) => `com.rezics.commerce.${n}.v1`),
  );
  expect(await store.readOrderTransactions(pool, routeOf(buyer)!, o.id)).toEqual(restored.transactions);
  for (const id of [newId(0x3300), o.id]) expect(await commands.readOrderForAccount(other, id)).toBeNull();
  for (const id of [newId(0x3300), entitlement.id])
    expect(await commands.readEntitlementForAccount(other, id)).toBeNull();
  expect(await commands.listEntitlementsForAccount(other, { after: null, limit: 10 })).toEqual([]);
  expect(
    (
      await pool.query('SELECT 1 FROM access.resource_role_grant WHERE resource_id=ANY($1::uuid[])', [
        [o.id, entitlement.id],
      ])
    ).rowCount,
  ).toBe(0);
  const persisted = await pool.query("SELECT type,data FROM core.outbox WHERE type LIKE 'com.rezics.commerce.%'");
  for (const row of persisted.rows) {
    const schema = COMMERCE_EVENTS[row.type as keyof typeof COMMERCE_EVENTS];
    expect(EVENT_TYPES[row.type as keyof typeof EVENT_TYPES]).toBe(schema);
    expect(Value.Check(schema, row.data)).toBe(true);
    expect(Value.Check(schema, { ...row.data, title: 'unexpected' })).toBe(false);
  }
});

async function seed(count: number) {
  for (const route of [routeOf(seller)!, routeOf(buyer)!])
    await pool.query(
      `WITH ids AS (SELECT ('10000000-0000-7000-8000-' || lpad(to_hex($1::int),4,'0') || lpad(to_hex(n),8,'0'))::uuid id FROM generate_series(1,$2::int) n),
      offers AS (INSERT INTO commerce.offer SELECT $1,id,id,id,'Other','usd',100,'txcd_10302000',9000,'active',1,now(),now(),id FROM ids),
      orders AS (INSERT INTO commerce.purchase_order(route,order_id,buyer_account_id,offer_id,offer_revision,target_subject_id,creator_account_id,title,currency,unit_amount_minor,tax_code,royalty_basis_points,settlement,created_at,updated_at,revision,transaction_id) SELECT $1,id,id,id,1,id,id,'Other','usd',100,'txcd_10302000',9000,'pending',now(),now(),1,id FROM ids)
      INSERT INTO commerce.entitlement SELECT $1,id,id,id,id,id,now(),NULL,NULL,1,id FROM ids ON CONFLICT DO NOTHING`,
      [route, count],
    );
  for (const table of ['offer', 'purchase_order', 'entitlement']) await pool.query(`ANALYZE commerce.${table}`);
}
test('command statement counts do not grow with unrelated rows', async () => {
  const counts: number[][] = [],
    buffers: number[] = [];
  const client = await pool.connect();
  const original = client.query;
  let captured: { text: string; values: unknown[] }[] | undefined;
  client.query = ((sql: string | QueryConfig, values?: unknown[], callback?: unknown) => {
    const q =
      typeof sql === 'string' ? { text: sql, values: values ?? [] } : { text: sql.text, values: sql.values ?? [] };
    captured?.push(q);
    return Reflect.apply(original, client, [sql, values, callback]);
  }) as typeof client.query;
  client.release();
  try {
    for (const scale of [0, 2000, 8000]) {
      // One seed method, applied incrementally at each scale, also populates the buyer's own partition.
      await pool.query(
        'TRUNCATE commerce.offer, commerce.purchase_order, commerce.entitlement, commerce.order_transaction',
      );
      await seed(scale);
      const o = await offer();
      const a = await actor(buyer);
      captured = [];
      const created = await commands.createOrder(a, o.id, key());
      const createStatements = captured;
      captured = undefined;
      expect(createStatements.filter((q) => /FROM commerce.offer WHERE/.test(q.text))).toHaveLength(1);
      await commands.recordCheckout(created.value.id, {
        session: { id: 'cs_test_paid', url: 'https://checkout.test', expiresAt: '2026-01-02T00:00:00.000Z' },
      });
      captured = [];
      await commands.applyCheckoutSnapshot(snapshot(created.value), key());
      const applyStatements = captured;
      captured = undefined;
      counts.push([createStatements.length, applyStatements.length]);
      let used = 0;
      for (const q of [...createStatements, ...applyStatements].filter(
        (q) => /^SELECT/.test(q.text) && /FROM commerce\./.test(q.text),
      )) {
        const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`, q.values)).rows[0][
          'QUERY PLAN'
        ][0].Plan;
        used += plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
      }
      buffers.push(used);
    }
  } finally {
    client.query = original;
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
  expect(buffers[2]!).toBeLessThanOrEqual(buffers[1]! + 24);
});
