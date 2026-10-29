import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import type { Entitlement, Offer, Order, StripeEventRef } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import * as store from '../../src/commerce/store.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Row,
} from '../support/growth.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

let db: GrowthDatabase;
let fake: ReturnType<typeof startFakeStripe>;
let app: ReturnType<typeof createKernel>;
let access: ReturnType<typeof createAccess>;
let stripe: ReturnType<typeof createStripePort>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const seller = newId(0x2200),
  buyer = newId(0x3300),
  other = newId(0x3300);
const actions = [
  'offer:create',
  'offer:manage',
  'offer:read',
  'order:create',
  'order:read',
  'entitlement:list',
  'entitlement:read',
];
const tokens = new Map<string, string>();
const queued: StripeEventRef[] = [];
const successUrl = 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}';
const cancelUrl = 'https://web.example.test/checkout/cancel';
const input = () => ({
  targetSubjectId: newId(0x5500),
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
});
const key = () => Bun.randomUUIDv7();
async function request(path: string, account: string | null = buyer, body?: unknown, requestKey = key()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-request-id': 'commerce-http',
        ...(account ? { authorization: `Bearer ${tokens.get(account)!}` } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(requestKey) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function offer(): Promise<Offer> {
  const response = await request('/v1/offers', seller, input());
  expect(response.status).toBe(201);
  return (await response.json()).offer;
}
async function order(offerId: string, requestKey = key()): Promise<Order> {
  const response = await request('/v1/orders', buyer, { offerId }, requestKey);
  expect(response.status).toBe(201);
  return (await response.json()).order;
}
async function paid(offerId: string): Promise<Entitlement> {
  const created = await order(offerId);
  const current = (await store.readOrder(db.pool, routeOf(created.id)!, created.id))!;
  fake.pay(current.checkoutSessionId!);
  await createCommerceCommands({ pool: db.pool, access }).applyCheckoutSnapshot(
    await stripe.readCheckout(current.checkoutSessionId!),
    key(),
  );
  return (await store.listEntitlements(db.pool, routeOf(buyer)!, buyer, { after: null, limit: 1 }))[0]!;
}
function stableProblem(body: Record<string, unknown>) {
  const { request_id: requestId, ...stable } = body;
  expect(typeof requestId).toBe('string');
  return stable;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: 'sk_test_local',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeoutMs: 1000,
    clock: () => new Date(),
  });
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'commerce', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) =>
      (access = createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      })),
    commerce: {
      stripe,
      successUrl,
      cancelUrl,
      webhookSecrets: [fake.webhookSecret],
      work: {
        async enqueueStripeEvent(ref) {
          queued.push(ref);
        },
      },
    },
  });
  for (const id of [seller, buyer, other]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
    tokens.set(
      id,
      await new SignJWT({
        client_id: 'web',
        scope: (id === seller ? [...actions, 'exposure:open'] : actions).join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'commerce', typ: 'at+jwt' })
        .setIssuer('https://auth.example.test')
        .setAudience('https://api.rezics.test')
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await bootstrapGovernance(db.pool, seller);
  for (const group of ['purchases', 'selling']) {
    const opened = await app.handle(
      new Request(`http://kernel.test/v1/platform/exposure/${group}:open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.get(seller)!}`,
          'idempotency-key': JSON.stringify(key()),
        },
      }),
    );
    if (opened.status !== 200) throw new Error(`Opening ${group} failed: ${opened.status} ${await opened.text()}`);
  }
});
beforeEach(async () => {
  fake.nextCreateFault = null;
  fake.requests.length = 0;
  queued.length = 0;
  await db.admin.query(
    'TRUNCATE commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer, access.resource_role_grant, access.resource_initialization, access.resource_grant, access.resource_denial, core.receipt, core.outbox',
  );
  await db.admin.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller],
  );
});
afterAll(async () => {
  fake?.stop();
  await db?.close();
});

test('the kernel mounts commerce and the signed webhook once with its Access catalogue', async () => {
  expect(app.routes.filter((r) => r.path === '/v1/webhooks/stripe')).toHaveLength(1);
  expect(new Set(app.routes.map((r) => `${r.method} ${r.path}`)).size).toBe(app.routes.length);
  for (const action of actions) expect(actionCatalogue(app).has(action)).toBe(true);
  const created = await order((await offer()).id);
  const current = (await store.readOrder(db.pool, routeOf(created.id)!, created.id))!;
  const signed = await fake.event('checkout.session.completed', current.checkoutSessionId!);
  const response = await app.handle(
    new Request('http://kernel.test/v1/webhooks/stripe', {
      method: 'POST',
      body: signed.bytes,
      headers: { 'stripe-signature': signed.signature, 'content-type': 'application/json' },
    }),
  );
  expect(response.status).toBe(200);
  expect(queued).toHaveLength(1);
});

test('buyers open inline priced hosted Checkout, replay the order, and conflict on changed input', async () => {
  const selling = await offer();
  expect(Object.keys(selling).sort()).toEqual([
    'currency',
    'id',
    'state',
    'summary',
    'targetSubjectId',
    'title',
    'unitAmountMinor',
  ]);
  const publicRead = await request(`/v1/offers/${selling.id}`, null);
  const { summary, ...offerFields } = selling as Offer & { summary: unknown };
  expect([publicRead.status, await publicRead.json()]).toEqual([200, { offer: { ...offerFields, subject: summary } }]);
  const requestKey = key();
  const response = await request('/v1/orders', buyer, { offerId: selling.id }, requestKey);
  expect(response.status).toBe(201);
  const created = (await response.json()).order;
  expect(response.headers.get('location')).toBe(`/v1/orders/${created.id}`);
  expect(Object.keys(created).sort()).toEqual([
    'checkoutExpiresAt',
    'checkoutUrl',
    'createdAt',
    'entitlementId',
    'id',
    'offerId',
    'settlement',
  ]);
  expect(created).toMatchObject({ offerId: selling.id, settlement: 'pending', entitlementId: null });
  expect(created.checkoutUrl).toStartWith('https://');
  const sent = fake.requests[0]!;
  expect(sent.path).toBe('/v1/checkout/sessions');
  expect(sent.headers.get('idempotency-key')).toBe(`order:${created.id}`);
  for (const [name, value] of Object.entries({
    mode: 'payment',
    client_reference_id: created.id,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': '1200',
    'line_items[0][price_data][product_data][name]': 'Book',
    'line_items[0][price_data][product_data][tax_code]': 'txcd_10302000',
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
  }))
    expect(sent.params.get(name)).toBe(value);
  expect(sent.params.has('line_items[0][price]')).toBe(false);
  expect(Number(sent.params.get('expires_at'))).toBe(Math.floor(Date.parse(created.createdAt) / 1000) + 3600);
  expect(await order(selling.id, requestKey)).toEqual(created);
  expect(fake.requests).toHaveLength(1);
  const changed = await request('/v1/orders', buyer, { offerId: (await offer()).id }, requestKey);
  expect(changed.status).toBe(422);
  expect((await changed.json()).code).toBe('idempotency_conflict');
});

test('unknown offers are hidden and delisted offers conflict, while existing orders replay', async () => {
  expect((await request('/v1/orders', buyer, { offerId: newId(0x2200) })).status).toBe(404);
  const selling = await offer(),
    requestKey = key();
  const created = await order(selling.id, requestKey);
  const delist = await request(`/v1/offers/${selling.id}:delist`, seller, {});
  expect(delist.status).toBe(200);
  expect((await delist.json()).offer.state).toBe('delisted');
  const refused = await request('/v1/orders', buyer, { offerId: selling.id });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'offer_unavailable', retryable: false });
  expect(await order(selling.id, requestKey)).toEqual(created);
});

test('delisted public offers are concealed as unknown while captured purchases and entitlements remain usable', async () => {
  const selling = await offer();
  const active = await capture(db, () => request(`/v1/offers/${selling.id}`, null));
  expect(active.value.status).toBe(200);
  expect((await active.value.json()).offer).toMatchObject({ id: selling.id, state: 'active', subject: null });
  expect(active.capture.statements.some((sql) => /semantic\./.test(sql))).toBe(true);

  const entitlement = await paid(selling.id);
  const captured = (await store.readOrder(db.pool, routeOf(entitlement.orderId)!, entitlement.orderId))!;
  expect(captured).toMatchObject({
    offerId: selling.id,
    targetSubjectId: selling.targetSubjectId,
    title: selling.title,
    currency: selling.currency,
    unitAmountMinor: selling.unitAmountMinor,
    settlement: 'paid',
  });
  const orderBefore = await request(`/v1/orders/${captured.id}`);
  const entitlementBefore = await request(`/v1/entitlements/${entitlement.id}`);
  expect(orderBefore.status).toBe(200);
  expect(entitlementBefore.status).toBe(200);
  const orderBody = await orderBefore.json();
  const entitlementBody = await entitlementBefore.json();
  expect(orderBody.order).toMatchObject({
    id: captured.id,
    title: captured.title,
    targetSubjectId: captured.targetSubjectId,
    settlement: 'paid',
    entitlementId: entitlement.id,
  });
  expect(entitlementBody.entitlement).toMatchObject({
    offerId: selling.id,
    orderId: captured.id,
    targetSubjectId: captured.targetSubjectId,
    active: true,
    revokedAt: null,
    revokeReason: null,
  });

  const delisted = await request(`/v1/offers/${selling.id}:delist`, seller, {});
  expect(delisted.status).toBe(200);
  expect((await delisted.json()).offer).toMatchObject({ id: selling.id, state: 'delisted' });
  const unknownId = newId(routeOf(selling.id)!);
  for (const account of [null, buyer, seller]) {
    const unknown = await capture(db, () => request(`/v1/offers/${unknownId}`, account));
    const concealed = await capture(db, () => request(`/v1/offers/${selling.id}`, account));
    for (const result of [unknown, concealed]) {
      expect(result.value.status).toBe(404);
      expect(result.value.headers.get('content-type')).toBe('application/problem+json');
      expect(result.capture.statements.some((sql) => /commerce\.offer\b/.test(sql))).toBe(true);
      expect(result.capture.statements.some((sql) => /semantic\./.test(sql))).toBe(false);
    }
    const problem = stableProblem(await unknown.value.json());
    expect(problem).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
    expect(stableProblem(await concealed.value.json())).toEqual(problem);
  }

  const providerCalls = fake.requests.length;
  const refused = await request('/v1/orders', buyer, { offerId: selling.id });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'offer_unavailable', retryable: false });
  expect(fake.requests).toHaveLength(providerCalls);
  const orderAfter = await request(`/v1/orders/${captured.id}`);
  const entitlementAfter = await request(`/v1/entitlements/${entitlement.id}`);
  expect(orderAfter.status).toBe(200);
  expect(await orderAfter.json()).toEqual(orderBody);
  expect(entitlementAfter.status).toBe(200);
  expect(await entitlementAfter.json()).toEqual(entitlementBody);
  expect(await store.readOrder(db.pool, routeOf(captured.id)!, captured.id)).toEqual(captured);
  expect(await store.readEntitlement(db.pool, routeOf(entitlement.id)!, entitlement.id)).toEqual(entitlement);
  expect(await store.readOffer(db.pool, routeOf(selling.id)!, selling.id)).toMatchObject({ state: 'delisted' });
});

test('rejected Checkout settles failed and lost creates settle unknown then reconcile under the same key', async () => {
  const selling = await offer();
  fake.nextCreateFault = 'rejected';
  const rejectedKey = key();
  const rejected = await order(selling.id, rejectedKey);
  expect(rejected).toMatchObject({ settlement: 'failed', checkoutUrl: null });
  expect(await order(selling.id, rejectedKey)).toEqual(rejected);
  expect(fake.requests).toHaveLength(1);
  fake.nextCreateFault = 'lost';
  const lostKey = key();
  const lost = await request('/v1/orders', buyer, { offerId: selling.id }, lostKey);
  expect(lost.status).toBe(503);
  expect(await lost.json()).toMatchObject({ code: 'dependency_unavailable', retryable: true });
  const unknown = (
    await db.admin.query("SELECT order_id AS id,settlement FROM commerce.purchase_order WHERE settlement='unknown'")
  ).rows;
  expect(unknown).toHaveLength(1);
  const reconciled = await order(selling.id, lostKey);
  expect(reconciled).toMatchObject({ id: unknown[0].id, settlement: 'pending' });
  expect(fake.requests).toHaveLength(3);
  expect(fake.requests[1]!.params.toString()).toBe(fake.requests[2]!.params.toString());
  expect(fake.requests[1]!.headers.get('idempotency-key')).toBe(fake.requests[2]!.headers.get('idempotency-key'));
});

test('single reads hide unknown, malformed UUID, other-account and anonymous IDs with identical problems', async () => {
  const selling = await offer(),
    entitlement = await paid(selling.id);
  for (const [path, id] of [
    ['orders', entitlement.orderId],
    ['entitlements', entitlement.id],
  ]) {
    const own = await request(`/v1/${path}/${id}`);
    expect(own.status).toBe(200);
    const problems = [];
    for (const [target, account] of [
      [id, other],
      [id, null],
      [newId(0x3300), buyer],
      ['00000000-0000-0000-0000-000000000000', buyer],
      [newId(0x4400), buyer],
    ] as const) {
      const response = await request(`/v1/${path}/${target}`, account);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      problems.push(stableProblem(await response.json()));
    }
    for (const problem of problems) expect(problem).toEqual(problems[0]!);
  }
  expect((await (await request(`/v1/orders/${entitlement.orderId}`)).json()).order.entitlementId).toBe(entitlement.id);
  const read = (await (await request(`/v1/entitlements/${entitlement.id}`)).json()).entitlement;
  expect(Object.keys(read).sort()).toEqual([
    'active',
    'grantedAt',
    'id',
    'offerId',
    'orderId',
    'revokeReason',
    'revokedAt',
    'summary',
    'targetSubjectId',
  ]);
  expect(read.active).toBe(true);
  for (const target of [newId(0x2200), '00000000-0000-0000-0000-000000000000'])
    expect((await request(`/v1/offers/${target}`, null)).status).toBe(404);
});

test('entitlement pages stay in the buyer partition and reject tampering and other-account cursors', async () => {
  const selling = await offer();
  const first = await paid(selling.id),
    second = await paid(selling.id);
  const page = await request('/v1/entitlements?limit=1');
  expect(page.status).toBe(200);
  const body = await page.json();
  expect(body.entitlements.map((e: Entitlement) => e.id)).toEqual([second.id]);
  expect(typeof body.next).toBe('string');
  const next = await request(`/v1/entitlements?limit=1&cursor=${body.next}`);
  expect(await next.json()).toMatchObject({ entitlements: [{ id: first.id }], next: null });
  expect(await (await request('/v1/entitlements', other)).json()).toEqual({ entitlements: [], next: null });
  for (const [cursor, account] of [
    [`${body.next.slice(0, -3)}abc`, buyer],
    [body.next, other],
  ]) {
    const invalid = await request(`/v1/entitlements?cursor=${cursor}`, account);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('invalid_cursor');
  }
  for (const query of ['limit=0', 'limit=101', 'limit=1.5'])
    expect((await request(`/v1/entitlements?${query}`)).status).toBe(400);
  expect((await request('/v1/entitlements', null)).status).toBe(401);
  expect((await request('/v1/orders', null, { offerId: selling.id })).status).toBe(401);
});

test('order creation proves its constant native point prefix row cost under the calibrated series rule after production-shaped neighbours and framework history are seeded before the first scale', async () => {
  const selling = await offer();
  await order(selling.id);
  // Clone only committed native envelopes, never Access or semantic/business evidence.
  const templates = (
    await db.admin.query<{ receipt: Row; events: Row[]; basis: Row | null }>(
      `SELECT to_jsonb(r) - 'actor_account_id' AS receipt,
         (SELECT jsonb_agg(to_jsonb(o)) FROM core.outbox o
          WHERE o.partition_no=r.partition_no AND o.position=r.position) AS events,
         (SELECT to_jsonb(b) - 'actor_account_id' FROM editorial.write_basis b
          WHERE b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id) AS basis
       FROM core.receipt r ORDER BY partition_no, position`,
    )
  ).rows;
  expect(templates.map(({ receipt }) => receipt.command_kind).sort()).toEqual([
    'commerce.checkout.record',
    'commerce.offer.create',
    'commerce.order.create',
  ]);
  expect(templates.filter(({ basis }) => basis !== null)).toHaveLength(2);
  const neighboursPerScale = 2048;
  const operation = async () => {
    const calls = fake.requests.length;
    const created = await order(selling.id, key());
    expect(created).toMatchObject({ settlement: 'pending' });
    expect(created.checkoutUrl).toStartWith('https://');
    expect(fake.requests).toHaveLength(calls + 1);
  };
  const report = await checkGrowth(db, {
    name: 'order creation: 2048/8192/32768 offer and order neighbours; 6144/24576/98304 native receipt and outbox neighbours; 4096/16384/65536 write bases',
    rule: 'series',
    scales: [1, 4, 16],
    // Commerce Cost: one parent offer point, one order insert; checkout reads/updates
    // one order and counts its c<=2 receipt prefix. Two k=1 command envelopes add
    // fixed rows/statements and B-tree depth per probe: R/S O(1), B O(L(N)).
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const range = { from: previous * neighboursPerScale, to: scale * neighboursPerScale };
      await seed(
        database,
        {
          name: 'commerce-http-order-neighbours',
          hotPartition: partitionOf(routeOf(buyer)!),
          async write(target, placement) {
            const sellerRoute = routeOf(seller)!;
            const buyerRoute = routeOf(buyer)!;
            const tx = { transactionId: newId(sellerRoute), time: new Date().toISOString() };
            const neighbour = await store.insertOffer(
              target.admin,
              sellerRoute,
              {
                ...input(),
                targetSubjectId: selling.targetSubjectId,
                id: newId(sellerRoute),
                creatorAccountId: seller,
                royaltyBasisPoints: 9000,
              },
              tx,
            );
            await store.insertOrder(
              target.admin,
              buyerRoute,
              {
                id: newId(buyerRoute),
                buyerAccountId: placement.hot ? buyer : other,
                offer: neighbour,
              },
              { ...tx, transactionId: newId(buyerRoute) },
            );
          },
        },
        range,
      );
      const heads = new Map(
        (
          await database.admin.query<{ partition_no: number; epoch: number; position: string }>(
            'SELECT partition_no, epoch, position::text FROM core.partition WHERE partition_no=ANY($1::integer[])',
            [[partitionOf(routeOf(seller)!), partitionOf(routeOf(buyer)!)]],
          )
        ).rows.map((head) => [head.partition_no, head]),
      );
      await seed(
        database,
        {
          name: 'commerce-http-native-envelopes',
          hotPartition: partitionOf(routeOf(buyer)!),
          rows({ ordinal }) {
            const receipts: Row[] = [],
              events: Row[] = [],
              bases: Row[] = [];
            for (const [index, template] of templates.entries()) {
              const head = heads.get(Number(template.receipt.partition_no))!;
              const position = (
                BigInt(head.position) + BigInt((ordinal - range.from) * templates.length + index + 1)
              ).toString();
              const transactionId = newId(head.partition_no * 16);
              const requestKey =
                template.receipt.command_kind === 'commerce.checkout.record'
                  ? `order:${newId(routeOf(buyer)!)}:checkout:0`
                  : `history:${key()}`;
              receipts.push({
                ...template.receipt,
                epoch: head.epoch,
                position,
                transaction_id: transactionId,
                idempotency_key: requestKey,
              });
              events.push(
                ...template.events.map((event) => ({
                  ...event,
                  epoch: head.epoch,
                  position,
                  id: newId(head.partition_no * 16),
                })),
              );
              if (template.basis)
                bases.push({ ...template.basis, epoch: head.epoch, position, transaction_id: transactionId });
            }
            return { 'core.receipt': receipts, 'core.outbox': events, 'editorial.write_basis': bases };
          },
          async finish(admin) {
            // The next real command must append after the cloned committed positions.
            for (const head of heads.values())
              await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
                head.partition_no,
                (BigInt(head.position) + BigInt((range.to - range.from) * templates.length)).toString(),
              ]);
          },
        },
        range,
      );
    },
    async warmup(_, scale) {
      const warmed = await capture(db, operation);
      const nodes = (value: unknown): Record<string, unknown>[] => {
        if (Array.isArray(value)) return value.flatMap(nodes);
        if (!value || typeof value !== 'object') return [];
        const node = value as Record<string, unknown>;
        return [node, ...Object.values(node).flatMap(nodes)];
      };
      const plans = nodes(warmed.capture.plans);
      const prefix = plans.filter(
        (node) => typeof node['Index Cond'] === 'string' && /idempotency_key >=/.test(node['Index Cond']),
      );
      console.info(
        'commerce order creation native access',
        JSON.stringify({
          neighbours: scale * neighboursPerScale,
          cost: costOf(warmed.capture),
          prefix,
        }),
      );
      expect(prefix).toHaveLength(1);
      expect(prefix[0]!['Index Name']).toBe('receipt_pkey');
      for (const column of ['partition_no', 'command_kind', 'idempotency_key'])
        expect(prefix[0]!['Index Cond']).toContain(column);
      expect(prefix[0]!['Index Cond']).toContain('commerce.checkout.record');
      expect(prefix[0]!['Index Cond']).toContain('idempotency_key <');
      expect(prefix[0]!['Actual Rows']).toBe(0);
      expect(prefix[0]!['Rows Removed by Filter']).toBe(0);
      for (const [index, columns] of [
        ['offer_pkey', ['route', 'offer_id']],
        ['purchase_order_pkey', ['route', 'order_id']],
        ['receipt_pkey', ['partition_no', 'principal_kind', 'principal_id', 'command_kind', 'idempotency_key']],
        ['partition_pkey', ['partition_no']],
      ] as const) {
        const point = plans.find((node) => node['Index Name'] === index && !prefix.includes(node));
        expect(point).toBeDefined();
        for (const column of columns) expect(point!['Index Cond']).toContain(`${column} =`);
      }
    },
    operation,
  });
  console.info('commerce order creation series', JSON.stringify(report));
  for (const sample of report.samples)
    for (const cost of sample.repetitions) {
      for (const relation of ['commerce.offer', 'commerce.purchase_order', 'core.receipt'])
        expect(cost.relations[relation]!.sequentialScans).toBe(0);
      // Per-relation Cost includes ModifyTable RETURNING rows: the create and
      // checkout envelopes insert two receipts. Fresh keys read no prior receipt.
      expect(cost.relations['core.receipt']!.rows).toBe(2);
    }
  expect(new Set(report.samples.flatMap((sample) => sample.repetitions.map((cost) => cost.statements))).size).toBe(1);
});

test('commerce request statement counts stay constant as total and buyer history grow', async () => {
  const selling = await offer(),
    entitlement = await paid(selling.id);
  const grow = async (_db: GrowthDatabase, scale: number, previous: number) =>
    seed(
      db,
      {
        name: 'commerce-http-history',
        hotPartition: partitionOf(routeOf(buyer)!),
        async write(target, placement) {
          const r = placement.hot ? routeOf(buyer)! : placement.route;
          const accountId = placement.hot ? buyer : newId(r);
          const offerId = newId(r);
          const tx = { transactionId: newId(r), time: new Date().toISOString() };
          const selling = await store.insertOffer(
            target.admin,
            r,
            { ...input(), id: offerId, creatorAccountId: accountId, royaltyBasisPoints: 9000 },
            tx,
          );
          const seededOrder = await store.insertOrder(
            target.admin,
            r,
            { id: newId(r), buyerAccountId: accountId, offer: selling },
            tx,
          );
          await target.admin.query(
            'INSERT INTO commerce.entitlement(route,entitlement_id,account_id,order_id,offer_id,target_subject_id,transaction_id,granted_at,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),1)',
            [r, newId(r), accountId, seededOrder.id, selling.id, selling.targetSubjectId, tx.transactionId],
          );
        },
      },
      { from: previous, to: scale },
    );
  for (const [name, operation] of [
    [
      'order read',
      async () => {
        expect((await request(`/v1/orders/${entitlement.orderId}`)).status).toBe(200);
      },
    ],
    [
      'entitlement page',
      async () => {
        expect((await request('/v1/entitlements')).status).toBe(200);
      },
    ],
  ] as const) {
    const report = await checkGrowth(db, {
      name,
      scales: [1, 8, 64],
      bounds: { statements: 'constant', rows: 'linear', blocks: 'linear' },
      grow,
      operation,
    });
    expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
  }
});
