import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const governor = newId(0x1100);
const seller = newId(0x2200);
const buyer = newId(0x3300);
const sellerScopes = ['offer:create', 'offer:manage', 'offer:read'];
const buyerScopes = ['offer:read', 'order:create', 'order:read', 'entitlement:list', 'entitlement:read'];
const tokens = new Map<string, string>();
const successUrl = 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}';
const cancelUrl = 'https://web.example.test/checkout/cancel';
type Persona = 'governor' | 'seller' | 'buyer' | 'anonymous';

let db: GrowthDatabase;
let fake: ReturnType<typeof startFakeStripe>;
let app: ReturnType<typeof createKernel>;
let purchasesObserved!: () => void;
const purchasesClosed = new Promise<void>((resolve) => {
  purchasesObserved = resolve;
});
let sellingObserved!: () => void;
const sellingClosed = new Promise<void>((resolve) => {
  sellingObserved = resolve;
});

function accountId(as: Persona) {
  if (as === 'governor') return governor;
  if (as === 'seller') return seller;
  if (as === 'buyer') return buyer;
  return null;
}

async function request(method: 'GET' | 'POST', path: string, as: Persona, body?: unknown) {
  const account = accountId(as);
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(account ? { authorization: `Bearer ${tokens.get(account)!}` } : {}),
        ...(method === 'POST'
          ? {
              'idempotency-key': JSON.stringify(crypto.randomUUID()),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            }
          : {}),
      },
      ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function closedProblem(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  const body = (await response.json()) as Record<string, unknown>;
  const { request_id: requestId, ...stable } = body;
  expect(requestId).toBeString();
  return stable;
}

async function commerceWrites() {
  const row = (
    await db.admin.query(
      `SELECT
         (SELECT count(*)::int FROM commerce.purchase_order) AS orders,
         (SELECT count(*)::int FROM core.receipt) AS receipts,
         (SELECT count(*)::int FROM core.outbox) AS outbox`,
    )
  ).rows[0] as { orders: number; receipts: number; outbox: number };
  return row;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fake = startFakeStripe();
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'commerce-exposure', alg: 'ES256' };
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
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.exposure.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.exposure.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    commerce: {
      stripe: createStripePort({
        apiKey: 'sk_test_exposure',
        managedPayments: false,
        host: '127.0.0.1',
        port: fake.port,
        protocol: 'http',
        maxNetworkRetries: 0,
        timeoutMs: 1000,
        clock: () => new Date(),
      }),
      successUrl,
      cancelUrl,
      webhookSecrets: [fake.webhookSecret],
      work: { async enqueueStripeEvent() {} },
    },
  });
  const scopes = new Map<string, string[]>([
    [governor, ['exposure:open']],
    [seller, sellerScopes],
    [buyer, buyerScopes],
  ]);
  for (const id of [governor, seller, buyer]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
    tokens.set(
      id,
      await new SignJWT({
        client_id: 'web',
        scope: scopes.get(id)!.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'commerce-exposure', typ: 'at+jwt' })
        .setIssuer('https://auth.exposure.test')
        .setAudience('https://api.rezics.test')
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
});

afterAll(async () => {
  purchasesObserved();
  sellingObserved();
  fake?.stop();
  await db?.close();
});

test('every buyer route declares gate purchases and offer creation and delisting declare gate selling while the Stripe webhook stays public', () => {
  const document = openApiDocument(app);
  const purchases = {
    '/v1/offers/{offerId}': ['get'],
    '/v1/orders': ['post'],
    '/v1/orders/{orderId}': ['get'],
    '/v1/entitlements': ['get'],
    '/v1/entitlements/{entitlementId}': ['get'],
  };
  for (const [path, methods] of Object.entries(purchases))
    for (const method of methods) expect(document.paths[path]?.[method]?.['x-exposure']).toBe('gate:purchases');
  expect(document.paths['/v1/offers']?.post?.['x-exposure']).toBe('gate:selling');
  expect(document.paths['/v1/offers/{offerId}:delist']?.post?.['x-exposure']).toBe('gate:selling');
  const webhook = app.routes.filter((route) => route.path === '/v1/webhooks/stripe');
  expect(webhook).toHaveLength(1);
  expect(webhook[0]?.hooks.detail?.['x-exposure']).toBe('public');
  const published = document.paths['/v1/webhooks/stripe']?.post?.['x-exposure'];
  if (published !== undefined) expect(published).toBe('public');
});

test('every payout statement route declares gate selling', () => {
  const document = openApiDocument(app);
  const routes = {
    '/v1/payoutStatements': ['get'],
    '/v1/payoutStatements/{statementId}': ['get'],
    '/v1/payoutStatements/{statementId}/lines': ['get'],
    '/v1/payoutStatements/{statementId}:markPaid': ['post'],
  };
  for (const [path, methods] of Object.entries(routes))
    for (const method of methods) expect(document.paths[path]?.[method]?.['x-exposure']).toBe('gate:selling');
});

test('a closed selling group answers 403 platform_closed identically to anonymous callers and ordinary accounts on payout routes and marks nothing paid', async () => {
  const statementId = newId(0x2200);
  await db.admin.query(
    "INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) VALUES ($1,$2,$3,'2025-12','usd')",
    [routeOf(statementId), statementId, seller],
  );
  const before = (
    await db.admin.query('SELECT state, revision FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2', [
      routeOf(statementId),
      statementId,
    ])
  ).rows[0];
  const calls = [
    { method: 'GET' as const, path: '/v1/payoutStatements' },
    { method: 'GET' as const, path: `/v1/payoutStatements/${statementId}` },
    { method: 'GET' as const, path: `/v1/payoutStatements/${statementId}/lines` },
    {
      method: 'POST' as const,
      path: `/v1/payoutStatements/${statementId}:markPaid`,
      body: { paidReference: 'bank:must-not-be-applied' },
    },
  ];
  try {
    for (const call of calls) {
      const anonymous = await closedProblem(await request(call.method, call.path, 'anonymous', call.body));
      const ordinary = await closedProblem(await request(call.method, call.path, 'seller', call.body));
      expect(anonymous).toEqual(ordinary);
      expect(anonymous).toEqual({
        type: 'https://rezics.com/problems/platform_closed',
        title: 'Platform Closed',
        status: 403,
        code: 'platform_closed',
        retryable: false,
        effect_status: call.method === 'POST' ? 'not_applied' : 'not_applicable',
      });
    }
    const after = (
      await db.admin.query('SELECT state, revision FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2', [
        routeOf(statementId),
        statementId,
      ])
    ).rows[0];
    expect(after).toEqual(before);
  } finally {
    sellingObserved();
  }
});

test('a closed purchases group answers 403 platform_closed identically to anonymous callers and ordinary accounts and changes nothing', async () => {
  try {
    const before = await commerceWrites();
    const calls = [
      { method: 'GET' as const, path: `/v1/offers/${newId(0x5500)}` },
      { method: 'POST' as const, path: '/v1/orders', body: { offerId: newId(0x5500) } },
      { method: 'GET' as const, path: `/v1/orders/${newId(0x3300)}` },
      { method: 'GET' as const, path: '/v1/entitlements' },
      { method: 'GET' as const, path: `/v1/entitlements/${newId(0x3300)}` },
    ];
    for (const call of calls) {
      const anonymous = await closedProblem(await request(call.method, call.path, 'anonymous', call.body));
      const ordinary = await closedProblem(await request(call.method, call.path, 'buyer', call.body));
      expect(anonymous).toEqual(ordinary);
      expect(anonymous).toEqual({
        type: 'https://rezics.com/problems/platform_closed',
        title: 'Platform Closed',
        status: 403,
        code: 'platform_closed',
        retryable: false,
        effect_status: call.method === 'POST' ? 'not_applied' : 'not_applicable',
      });
    }
    expect(await commerceWrites()).toEqual(before);
  } finally {
    purchasesObserved();
  }
});

test('after the purchases and selling groups are opened by data the offer and checkout flow works as before', async () => {
  await Promise.all([purchasesClosed, sellingClosed]);
  await bootstrapGovernance(db.pool, governor);
  for (const group of ['purchases', 'selling']) {
    const opened = await request('POST', `/v1/platform/exposure/${group}:open`, 'governor');
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ exposure: { group, open: true, changed: true } });
  }
  await db.admin.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller],
  );
  const input = {
    targetSubjectId: newId(0x5500),
    title: 'Book',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  const created = await request('POST', '/v1/offers', 'seller', input);
  expect(created.status).toBe(201);
  const offer = (await created.json()).offer;
  expect(Object.keys(offer).sort()).toEqual([
    'currency',
    'id',
    'state',
    'summary',
    'targetSubjectId',
    'title',
    'unitAmountMinor',
  ]);
  const { summary, ...offerFields } = offer;
  expect(summary).toBeNull();
  const listed = await request('GET', `/v1/offers/${offer.id}`, 'anonymous');
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ offer: { ...offerFields, revision: 1, subject: summary } });
  const checkout = await request('POST', '/v1/orders', 'buyer', { offerId: offer.id, expectedOfferRevision: 1 });
  expect(checkout.status).toBe(201);
  const order = (await checkout.json()).order;
  expect(checkout.headers.get('location')).toBe(`/v1/orders/${order.id}`);
  expect(order).toMatchObject({ offerId: offer.id, settlement: 'pending', entitlementId: null });
  expect(order.checkoutUrl).toStartWith('https://');
  const read = await request('GET', `/v1/orders/${order.id}`, 'buyer');
  expect(read.status).toBe(200);
  expect((await read.json()).order.id).toBe(order.id);
  const entitlements = await request('GET', '/v1/entitlements', 'buyer');
  expect(entitlements.status).toBe(200);
  expect(await entitlements.json()).toEqual({ entitlements: [], next: null });
  const delisted = await request('POST', `/v1/offers/${offer.id}:delist`, 'seller', { expectedRevision: 1 });
  expect(delisted.status).toBe(200);
  expect((await delisted.json()).offer).toMatchObject({ id: offer.id, state: 'delisted' });
});
