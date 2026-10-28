import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient, QueryConfig } from 'pg';
import { Value } from 'typebox/value';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { createPayouts } from '../../src/commerce/payouts.ts';
import { COMMERCE_EVENTS } from '../../src/commerce/events.ts';
import type { CheckoutSnapshot, Order, StripePort, StripeTransaction } from '../../src/commerce/model.ts';
import { statementPeriod, statementTotals, royaltyLines } from '../../src/commerce/royalty.ts';
import { readOrder } from '../../src/commerce/store.ts';
import { createCommerceWork } from '../../src/commerce/work.ts';
import { createPool } from '../../src/database/pool.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { ActionMetadata } from '../../src/request/access.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const connections = new Set<PoolClient>();
pool.on('connect', (connection) => connections.add(connection));
const creator = newId(0x2200);
// A different creator in the SAME route must also be unable to read the first creator's statements.
const otherCreator = newId(0x2200);
const buyer = newId(0x3300);
const operator = newId(0x1100);
const actions = [
  'offer:create',
  'offer:read',
  'offer:manage',
  'order:create',
  'payout_statement:list',
  'payout_statement:read',
  'payout_statement:mark_paid',
];
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let access: ReturnType<typeof createAccess>;
let app: ReturnType<typeof createKernel>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let now = new Date('2026-01-20T12:00:00Z');
const payouts = createPayouts({ pool, clock: () => now });
const key = () => Bun.randomUUIDv7();
const stripe: StripePort = {
  async createCheckoutSession() {
    throw new Error('Unexpected Stripe call from royalty effect');
  },
  async readCheckout() {
    throw new Error('Unexpected Stripe call from royalty effect');
  },
  async findCheckoutSession() {
    throw new Error('Unexpected Stripe call from royalty effect');
  },
};
async function token(id: string, scopes = actions) {
  return new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'payout', typ: 'at+jwt' })
    .setIssuer('https://auth.test')
    .setAudience('https://kernel.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
}
async function actor(id: string) {
  return access.authenticate(await token(id), { pool, deadline: Date.now() + 5000 });
}
async function request(path: string, id: string | null = creator, body?: unknown, requestKey = key()) {
  return app.handle(
    new Request(`https://kernel.test/v1/payoutStatements${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(id ? { authorization: `Bearer ${await token(id)}` } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(requestKey) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
beforeAll(async () => {
  signing = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'payout', alg: 'ES256' };
  const actionCatalogue = new Map<string, ActionMetadata>(
    actions.map((action) => [
      action,
      {
        anonymous: false,
        ...(action === 'offer:create' ? { 'x-resource-types': ['commerce.offer'] } : {}),
      },
    ]),
  );
  actionCatalogue.set('exposure:open', { anonymous: false });
  access = createAccess({
    actions: actionCatalogue,
    auth: {
      issuer: 'https://auth.test',
      audience: 'https://kernel.test',
      jwksUrl: 'https://auth.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    access,
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });
  for (const id of [creator, otherCreator, buyer, operator])
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  client = await createWorkClient(databaseUrl);
  worker = await composeWork(
    [
      createCommerceWork({
        stripe,
        checkout: { successUrl: 'https://test/success', cancelUrl: 'https://test/cancel' },
        royaltyClock: () => now,
      }),
    ],
    { pool, client, databaseUrl, executorId: 'payout-test' },
  );
  await worker.launch();
  await bootstrapGovernance(pool, operator);
  const opened = await app.handle(
    new Request('https://kernel.test/v1/platform/exposure/selling:open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(operator, ['exposure:open'])}`,
        'idempotency-key': JSON.stringify(key()),
      },
    }),
  );
  if (opened.status !== 200) throw new Error(`Opening selling failed: ${opened.status} ${await opened.text()}`);
}, 30_000);
beforeEach(async () => {
  now = new Date('2026-01-20T12:00:00Z');
  await pool.query(
    'TRUNCATE commerce.royalty_line, commerce.payout_statement, commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer, access.resource_grant, access.resource_role_grant, access.resource_initialization, access.resource_denial, core.outbox, core.receipt',
  );
  for (const [subject, action] of [
    [creator, 'offer:create'],
    [operator, 'payout_statement:mark_paid'],
  ])
    await pool.query(
      "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,$3,'(,)',$2)",
      [GLOBAL_CONTEXT, subject, action],
    );
});
afterAll(async () => {
  await worker?.shutdown();
  await client?.close();
  await pool.end();
}, 30_000);

// Signed amount, actual fee_details and net=amount-fee follow:
// https://docs.stripe.com/api/balance_transactions/object
// Refunds credit only documented returned fees: https://docs.stripe.com/refunds
function transaction(
  kind: StripeTransaction['kind'],
  amountMinor: number,
  feeMinor = 0,
  currency = 'usd',
): StripeTransaction {
  return {
    id: `txn_${key().replaceAll('-', '')}`,
    kind,
    sourceId: kind === 'charge' ? 'ch_sale' : kind === 'refund' ? 're_refund' : 'du_dispute',
    currency,
    amountMinor,
    feeMinor,
    netMinor: amountMinor - feeMinor,
    feeDetails: feeMinor ? [{ type: 'stripe_fee', amountMinor: feeMinor, description: null }] : [],
    exchangeRate: null,
    created: '2025-12-01T00:00:00.000Z',
  };
}
async function order(rate = 9000, unitAmountMinor = 1000) {
  const commands = createCommerceCommands({ pool, access, royaltyBasisPoints: rate });
  const offer = (
    await commands.createOffer(
      await actor(creator),
      { title: 'Book', targetSubjectId: newId(0x5500), currency: 'usd', unitAmountMinor, taxCode: 'txcd_10302000' },
      key(),
    )
  ).value;
  const result = (await commands.createOrder(await actor(buyer), offer.id, key())).value;
  await commands.recordCheckout(result.id, {
    session: {
      id: `cs_test_${key().replaceAll('-', '')}`,
      url: 'https://checkout.test',
      expiresAt: '2026-01-20T14:00:00Z',
    },
  });
  return (await readOrder(pool, routeOf(buyer)!, result.id))!;
}
// Checkout subtotal excludes tax; amount_tax is in the Session's integration currency:
// https://docs.stripe.com/api/checkout/sessions/object?query=total_details
function snapshot(o: Order, transactions: StripeTransaction[], tax = 200): CheckoutSnapshot {
  return {
    sessionId: o.checkoutSessionId!,
    clientReferenceId: o.id,
    metadataOrderId: o.id,
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: 'usd',
    amountSubtotalMinor: o.unitAmountMinor,
    amountTaxMinor: tax,
    amountTotalMinor: o.unitAmountMinor + tax,
    paymentIntentId: 'pi_sale',
    paymentIntentStatus: 'succeeded',
    chargeId: 'ch_sale',
    chargeAmountMinor: o.unitAmountMinor + tax,
    refunds: [],
    disputes: [],
    transactions,
    observedAt: now.toISOString(),
  };
}
async function settle(o: Order, transactions: StripeTransaction[], tax = 200, requestKey = key()) {
  return createCommerceCommands({ pool, access }).applyCheckoutSnapshot(snapshot(o, transactions, tax), requestKey);
}
async function effect(orderId: string) {
  const row = (
    await pool.query(
      "SELECT * FROM core.outbox WHERE type='com.rezics.commerce.transactions.recorded.v1' AND data->>'orderId'=$1 ORDER BY recorded_at DESC LIMIT 1",
      [orderId],
    )
  ).rows[0]!;
  const workflowID = `payout-test:${key()}`;
  await client.enqueue(
    {
      workflowName: 'effect',
      queueName: 'effects',
      queuePartitionKey: String(row.partition_no),
      workflowID,
      workflowIDReusePolicy: 'return-existing',
    },
    'commerce_royalty',
    {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: row.type,
      subject: orderId,
      time: row.recorded_at.toISOString(),
      datacontenttype: 'application/json',
      sequence: String(row.position),
      data: row.data,
    },
  );
  await client.retrieveWorkflow(workflowID).getResult();
}
async function statements() {
  const response = await request('');
  expect(response.status).toBe(200);
  return (await response.json()).payoutStatements as {
    id: string;
    period: string;
    currency: string;
    netReceiptsMinor: number;
    creatorShareMinor: number;
    revision: number;
  }[];
}
async function detail(id: string) {
  const response = await request(`/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()).statement;
}

test('royalty recording grants creator route access atomically and repeated recordings add no owner grant', async () => {
  const o = await order();
  const charge = transaction('charge', 1200, 50);
  const refund = transaction('refund', -100);
  await settle(o, [charge, refund]);
  const ownerGrants = async () =>
    (
      await pool.query(
        `SELECT subject_kind, subject_id, subject_role, grant_role, valid::text, transaction_id
         FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND grant_role='commerce.payout.owner'`,
        [routeOf(creator), creator],
      )
    ).rows;
  expect(await ownerGrants()).toEqual([]);
  const commandKey = key();
  await payouts.recordTransactions(o.id, [charge.id], commandKey);
  const [statement] = await statements();
  expect((await detail(statement!.id)).id).toBe(statement!.id);
  const response = await request(`/${statement!.id}/lines`);
  expect(response.status).toBe(200);
  expect((await response.json()).lines).toMatchObject([{ balanceTransactionId: charge.id }]);
  expect(
    (
      await pool.query(
        `SELECT g.xmin=s.xmin AND g.xmin=l.xmin AS same_transaction,
                lower(g.valid)=l.recorded_at AS starts_at_recording, upper_inf(g.valid) AS open
         FROM access.resource_role_grant g
         JOIN commerce.payout_statement s ON s.route=g.route AND s.creator_account_id=g.resource_id
         JOIN commerce.royalty_line l ON l.route=s.route AND l.statement_id=s.statement_id
         WHERE g.route=$1 AND g.resource_id=$2 AND g.grant_role='commerce.payout.owner'`,
        [routeOf(creator), creator],
      )
    ).rows,
  ).toEqual([{ same_transaction: true, starts_at_recording: true, open: true }]);
  for (const path of ['', `/${statement!.id}`, `/${statement!.id}/lines`])
    expect((await request(path, otherCreator)).status).toBe(404);
  const before = await ownerGrants();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    subject_kind: 'identity',
    subject_id: creator,
    subject_role: '',
    grant_role: 'commerce.payout.owner',
  });
  await payouts.recordTransactions(o.id, [charge.id], commandKey);
  await payouts.recordTransactions(o.id, [charge.id], key());
  await payouts.recordTransactions(o.id, [refund.id], key());
  expect(await ownerGrants()).toEqual(before);
});

test('legacy worked example runs through fulfilment, real royalty worker, exact creator statement and closed events', async () => {
  // legacy-final:docs/legal/creator-distribution-agreement-outline.md §4:
  // $12 received, $2 tax, $0.50 actual processing fee, $1 refund => $8.50 net, $7.65 creator.
  const o = await order();
  const charge = transaction('charge', 1200, 50),
    refund = transaction('refund', -100);
  await settle(o, [charge, refund]);
  expect((await readOrder(pool, routeOf(buyer)!, o.id))!.amountTaxMinor).toBe(200);
  await effect(o.id);
  const [statement] = await statements();
  expect(statement).toMatchObject({
    period: '2026-01',
    currency: 'usd',
    grossMinor: 1100,
    taxMinor: 200,
    feeMinor: 50,
    refundsMinor: 100,
    chargebacksMinor: 0,
    disputeFeeMinor: 0,
    netReceiptsMinor: 850,
    creatorShareMinor: 765,
    rezicsShareMinor: 85,
    state: 'open',
  });
  expect(routeOf(statement!.id)).toBe(routeOf(creator));
  const response = await request(`/${statement!.id}/lines`);
  expect(response.status).toBe(200);
  const lines = (await response.json()).lines;
  expect(lines).toHaveLength(2);
  expect(new Set(lines.map((line: { balanceTransactionId: string }) => line.balanceTransactionId))).toEqual(
    new Set([charge.id, refund.id]),
  );
  expect(
    lines.every(
      (line: { orderId: string; offerId: string; royaltyBasisPoints: number }) =>
        line.orderId === o.id && line.offerId === o.offerId && line.royaltyBasisPoints === 9000,
    ),
  ).toBe(true);
  for (const row of (
    await pool.query("SELECT type,data FROM core.outbox WHERE type LIKE 'com.rezics.commerce.payout_statement.%'")
  ).rows) {
    const schema = COMMERCE_EVENTS[row.type as keyof typeof COMMERCE_EVENTS];
    expect(EVENT_TYPES[row.type as keyof typeof EVENT_TYPES]).toBe(schema);
    expect(Value.Check(schema, row.data)).toBe(true);
    expect(Object.keys(row.data)).toEqual(['statementId']);
    expect(Value.Check(schema, { ...row.data, amount: 850 })).toBe(false);
  }
});

test('redelivered effects, command receipts, and a delayed command replay change no statement, line, receipt or event', async () => {
  const o = await order(),
    charge = transaction('charge', 1200, 50);
  const applyKey = key();
  await settle(o, [charge], 200, applyKey);
  const commandKey = key();
  await payouts.recordTransactions(o.id, [charge.id], commandKey);
  await effect(o.id);
  const before = await pool.query(
    'SELECT (SELECT jsonb_agg(s ORDER BY statement_id) FROM commerce.payout_statement s) statements, (SELECT count(*)::int FROM commerce.royalty_line) lines, (SELECT count(*)::int FROM core.outbox) events, (SELECT count(*)::int FROM core.receipt) receipts',
  );
  now = new Date('2026-02-20T12:00:00Z');
  await effect(o.id);
  await payouts.recordTransactions(o.id, [charge.id], commandKey);
  await settle(o, [charge], 200, applyKey);
  const after = await pool.query(
    'SELECT (SELECT jsonb_agg(s ORDER BY statement_id) FROM commerce.payout_statement s) statements, (SELECT count(*)::int FROM commerce.royalty_line) lines, (SELECT count(*)::int FROM core.outbox) events, (SELECT count(*)::int FROM core.receipt) receipts',
  );
  expect(after.rows).toEqual(before.rows);
});

test('a later refund goes to its recording UTC month even when the original statement is paid', async () => {
  const o = await order(),
    charge = transaction('charge', 1200, 50);
  await settle(o, [charge]);
  await effect(o.id);
  const original = (await statements())[0]!;
  expect((await request(`/${original.id}:markPaid`, operator, { paidReference: 'bank:January' })).status).toBe(200);
  now = new Date('2026-02-01T00:00:00Z');
  const refund = transaction('refund', -100);
  const updated = snapshot(o, [charge, refund]);
  updated.refunds = [{ id: 're_refund', status: 'succeeded', amountMinor: 100 }];
  await createCommerceCommands({ pool, access }).applyCheckoutSnapshot(updated, key());
  await effect(o.id);
  const all = await statements();
  expect(all).toHaveLength(2);
  expect(all.find((s) => s.period === '2026-02')).toMatchObject({
    grossMinor: -100,
    refundsMinor: 100,
    netReceiptsMinor: -100,
    creatorShareMinor: -90,
    rezicsShareMinor: -10,
  });
  expect(await detail(original.id)).toMatchObject({
    state: 'paid',
    netReceiptsMinor: 950,
    creatorShareMinor: 855,
    paidReference: 'bank:January',
  });
});

test('dispute fees are shown without deduction; mixed rates round once across the statement and currencies stay separate', async () => {
  // Managed Payments dispute fees are charged to the merchant account, not this creator's Net Receipts:
  // https://docs.stripe.com/payments/managed-payments/how-it-works#dispute-support
  const o = await order(),
    charge = transaction('charge', 1200, 50),
    dispute = transaction('dispute', -1200, 1500);
  await settle(o, [charge, dispute]);
  await effect(o.id);
  expect((await statements())[0]).toMatchObject({
    grossMinor: 0,
    taxMinor: 200,
    feeMinor: 50,
    disputeFeeMinor: 1500,
    chargebacksMinor: 1200,
    netReceiptsMinor: -250,
    creatorShareMinor: -225,
  });
  const small = await order(3333, 1),
    smallCharge = transaction('charge', 1);
  await settle(small, [smallCharge], 0);
  await effect(small.id);
  const another = await order(6667, 1),
    anotherCharge = transaction('charge', 1);
  await settle(another, [anotherCharge], 0);
  await effect(another.id);
  expect((await statements())[0]).toMatchObject({
    netReceiptsMinor: -248,
    creatorShareMinor: -224,
    rezicsShareMinor: -24,
  });
  const persisted = (
    await pool.query('SELECT weighted_net_minor::text FROM commerce.payout_statement WHERE route=$1', [
      routeOf(creator),
    ])
  ).rows;
  expect(persisted).toEqual([{ weighted_net_minor: '-2240000' }]);
  const converted = await order();
  // exchange_rate multiplies integration currency into settlement currency:
  // https://docs.stripe.com/api/balance_transactions/object#balance_transaction_object-exchange_rate
  const eur = { ...transaction('charge', 2400, 100, 'eur'), exchangeRate: 2 };
  await settle(converted, [eur]);
  await effect(converted.id);
  expect((await statements()).find((s) => s.currency === 'eur')).toMatchObject({
    grossMinor: 2400,
    taxMinor: 400,
    feeMinor: 100,
    netReceiptsMinor: 1900,
    creatorShareMinor: 1710,
  });
  expect(
    statementTotals([
      { ...royaltyLines(small, 0, [smallCharge])[0]!, royaltyBasisPoints: 3333 },
      { ...royaltyLines(another, 0, [anotherCharge])[0]!, royaltyBasisPoints: 6667 },
    ]),
  ).toMatchObject([{ netReceiptsMinor: 2, creatorShareMinor: 1 }]);
});

test('creator disclosure uses identical 404s; operator root grant, final month, once-only payment and receipt authorization', async () => {
  const o = await order();
  await settle(o, [transaction('charge', 1200, 50)]);
  await effect(o.id);
  const statement = (await statements())[0]!;
  let expected: unknown;
  for (const id of [creator, otherCreator, buyer, operator, null])
    for (const suffix of ['', '/lines']) {
      if (id === creator) continue;
      for (const statementId of [statement.id, newId(0x2200)]) {
        const response = await request(`/${statementId}${suffix}`, id);
        expect(response.status).toBe(404);
        const { request_id: _requestId, ...body } = await response.json();
        expected ??= body;
        expect(body).toEqual(expected);
      }
    }
  for (const id of [otherCreator, buyer, null])
    expect((await request(`/${statement.id}:markPaid`, id, { paidReference: 'bank:x' })).status).toBe(404);
  // A grant on another route-0 UUID is not platform-root authority.
  await pool.query('UPDATE access.resource_grant SET resource_id=$1 WHERE subject_id=$2', [
    '00000000-0000-8000-8000-000000000099',
    operator,
  ]);
  expect((await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:x' })).status).toBe(404);
  await pool.query('UPDATE access.resource_grant SET resource_id=$1 WHERE subject_id=$2', [GLOBAL_CONTEXT, operator]);
  const paymentKey = key();
  const first = await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:paid' }, paymentKey);
  expect(first.status).toBe(200);
  const paid = (await first.json()).statement;
  expect(paid).toMatchObject({ state: 'paid', paidReference: 'bank:paid', revision: statement.revision + 1 });
  expect(Number.isFinite(Date.parse(paid.paidAt))).toBe(true);
  expect(
    (await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:paid' }, paymentKey)).status,
  ).toBe(200);
  expect(
    (await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:changed' }, paymentKey)).status,
  ).toBe(422);
  expect((await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:second' })).status).toBe(409);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM core.outbox WHERE type='com.rezics.commerce.payout_statement.paid.v1'",
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  await pool.query('DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2', [
    GLOBAL_CONTEXT,
    operator,
  ]);
  expect(
    (await request(`/${statement.id}:markPaid`, operator, { paidReference: 'bank:paid' }, paymentKey)).status,
  ).toBe(404);
  now = new Date();
  const current = await order();
  await settle(current, [transaction('charge', 1200, 50)]);
  await effect(current.id);
  const open = (await statements()).find((s) => s.period === statementPeriod(now))!;
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'payout_statement:mark_paid','(,)',$2)",
    [GLOBAL_CONTEXT, operator],
  );
  expect((await request(`/${open.id}:markPaid`, operator, { paidReference: 'too-early' })).status).toBe(409);
});

async function seed(count: number) {
  await pool.query(
    `WITH ids AS (SELECT ('10000000-0000-7000-8000-2200' || lpad(to_hex(n),8,'0'))::uuid id FROM generate_series(1,$1::int) n),
    statements AS (INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) SELECT 8704,id,id,'2025-12','usd' FROM ids)
    INSERT INTO commerce.royalty_line(route,balance_transaction_id,creator_account_id,order_id,offer_id,kind,currency,gross_minor,tax_minor,fee_minor,dispute_fee_minor,net_receipts_minor,royalty_basis_points,period,statement_id,recorded_at)
    SELECT 8704,'txn_seed' || n::text,id,id,id,'charge','usd',1,0,0,0,1,9000,'2025-12',id,now() FROM ids JOIN generate_series(1,$1::int) n ON id=('10000000-0000-7000-8000-2200' || lpad(to_hex(n),8,'0'))::uuid ON CONFLICT DO NOTHING`,
    [count],
  );
  await pool.query('ANALYZE commerce.payout_statement');
  await pool.query('ANALYZE commerce.royalty_line');
}
test('one seed method at three scales: effect and keyset page SQL counts are independent of unrelated statement and line growth', async () => {
  const counts: number[][] = [];
  let captured: string[] | undefined;
  const originals = new Map();
  pool.on('connect', instrument);
  function instrument(connection: PoolClient) {
    if (originals.has(connection)) return;
    const original = connection.query;
    originals.set(connection, original);
    connection.query = ((sql: string | QueryConfig, ...args: unknown[]) => {
      captured?.push(typeof sql === 'string' ? sql : sql.text);
      return Reflect.apply(original, connection, [sql, ...args]);
    }) as typeof original;
  }
  // Include connections already acquired by the worker without trying to acquire its held clients.
  for (const connection of connections) instrument(connection);
  try {
    for (const scale of [0, 2000, 8000]) {
      await pool.query('TRUNCATE commerce.royalty_line, commerce.payout_statement');
      await seed(scale);
      const o = await order();
      await settle(o, [transaction('charge', 1200, 50)]);
      captured = [];
      await effect(o.id);
      const effectQueries = captured.filter((sql) => /commerce\./.test(sql));
      captured = undefined;
      const statement = (await statements())[0]!;
      captured = [];
      const response = await request('?limit=1');
      expect(response.status).toBe(200);
      const listQueries = captured.filter((sql) => /commerce\./.test(sql));
      captured = [];
      expect((await request(`/${statement.id}/lines?limit=1`)).status).toBe(200);
      const lineQueries = captured.filter((sql) => /commerce\./.test(sql));
      captured = undefined;
      counts.push([effectQueries.length, listQueries.length, lineQueries.length]);
      expect(effectQueries.some((sql) => /order_transaction/.test(sql))).toBe(true);
    }
  } finally {
    captured = undefined;
    pool.off('connect', instrument);
    for (const [connection, original] of originals) connection.query = original;
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
});

test('statement and line pages use stable keyset cursors without duplicates', async () => {
  for (let n = 0; n < 3; n++) {
    now = new Date(`2026-0${n + 1}-20T12:00:00Z`);
    const o = await order();
    await settle(o, [transaction('charge', 1200, 50), transaction('refund', -100)]);
    await effect(o.id);
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await request(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.payoutStatements).toHaveLength(1);
    expect(seen.has(page.payoutStatements[0].id)).toBe(false);
    seen.add(page.payoutStatements[0].id);
    cursor = page.next;
  } while (cursor);
  expect(seen.size).toBe(3);
  const id = [...seen][0]!;
  const first = await (await request(`/${id}/lines?limit=1`)).json();
  expect(first.next).toBeString();
  const second = await (await request(`/${id}/lines?limit=1&cursor=${encodeURIComponent(first.next)}`)).json();
  expect(second.next).toBeNull();
  expect(second.lines[0].balanceTransactionId).not.toBe(first.lines[0].balanceTransactionId);
});
