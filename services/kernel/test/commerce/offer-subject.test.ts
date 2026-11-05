import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

let db: GrowthDatabase;
let fake: ReturnType<typeof startFakeStripe>;
let app: ReturnType<typeof createKernel>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const seller = newId(0x2200);
const buyer = newId(0x3300);
const other = newId(0x3300);
const routeKey = new Uint8Array(32).fill(38);
const actions = ['offer:create', 'offer:manage', 'offer:read', 'order:create', 'order:read'];
const tokens = new Map<string, string>();
const successUrl = 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}';
const cancelUrl = 'https://web.example.test/checkout/cancel';
const key = () => randomUUID();

async function request(path: string, account: string | null = buyer, body?: unknown) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-request-id': 'offer-subject',
        ...(account ? { authorization: `Bearer ${tokens.get(account)!}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createOffer(targetSubjectId: string, title = 'A captured book title') {
  const response = await request('/v1/offers', seller, {
    targetSubjectId,
    title,
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const created = (await response.json()).offer;
  const reviewed = await request(`/v1/offers/${created.id}`, null);
  expect(reviewed.status).toBe(200);
  return (await reviewed.json()).offer as { id: string; revision: number };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  fake = startFakeStripe();
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'offer-subject', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
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
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    commerce: {
      stripe: createStripePort({
        apiKey: 'sk_test_local',
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
  for (const accountId of [seller, buyer, other]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(accountId), accountId],
    );
    tokens.set(
      accountId,
      await new SignJWT({
        client_id: 'web',
        scope: (accountId === seller ? [...actions, 'exposure:open'] : actions).join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'offer-subject', typ: 'at+jwt' })
        .setIssuer('https://auth.example.test')
        .setAudience('https://api.rezics.test')
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await bootstrapGovernance(db.pool, seller);
  for (const group of ['purchases', 'selling']) {
    const response = await app.handle(
      new Request(`http://kernel.test/v1/platform/exposure/${group}:open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.get(seller)!}`, 'idempotency-key': JSON.stringify(key()) },
      }),
    );
    if (response.status !== 200)
      throw new Error(`Opening ${group} failed: ${response.status} ${await response.text()}`);
  }
});

beforeEach(async () => {
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

let bookId: string;
beforeAll(async () => {
  const actor: AccountActor = {
    kind: 'account',
    accountId: seller,
    clientId: 'offer-subject',
    scopes: ['subject:create', 'subject:read'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const idempotencyKey = key();
  bookId = (
    await createSubject(db.pool, {
      actor,
      target: subjectTarget(routeKey, seller, idempotencyKey),
      idempotencyKey,
      digest: createHash('sha256').update(idempotencyKey).digest(),
      item: { type: 'schema:Book', labels: { en: 'English title', ja: '日本語の題名' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
});

test("an offer read returns its subject summary in the reader's preferred language", async () => {
  const offer = await createOffer(bookId);
  const japanese = await request(`/v1/offers/${offer.id}?languages=ja,en`, null);
  expect(japanese.status, await japanese.clone().text()).toBe(200);
  expect((await japanese.json()).offer.subject).toMatchObject({
    id: bookId,
    type: 'schema:Book',
    label: { value: '日本語の題名', language: 'ja' },
    creativeWork: true,
    cover: null,
  });
  const english = await request(`/v1/offers/${offer.id}?languages=fr,en`, null);
  expect(english.status, await english.clone().text()).toBe(200);
  expect((await english.json()).offer.subject.label).toEqual({ value: 'English title', language: 'en' });
});

test("a buyer's order read returns its captured title, subject id and summary", async () => {
  const offer = await createOffer(bookId);
  const createdResponse = await request('/v1/orders', buyer, {
    offerId: offer.id,
    expectedOfferRevision: offer.revision,
  });
  expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
  const created = (await createdResponse.json()).order;
  const response = await request(`/v1/orders/${created.id}?languages=ja,en`);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).order).toMatchObject({
    title: 'A captured book title',
    targetSubjectId: bookId,
    subject: {
      id: bookId,
      label: { value: '日本語の題名', language: 'ja' },
      creativeWork: true,
      cover: null,
    },
  });
  expect((await request(`/v1/orders/${created.id}`, other)).status).toBe(404);
});

test('an offer with an unknown subject still reads with a null subject', async () => {
  const offer = await createOffer(newId(0x5500));
  const response = await request(`/v1/offers/${offer.id}`, null);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).offer.subject).toBeNull();
});

test('offer and order reads reject invalid language preference lists', async () => {
  const offer = await createOffer(bookId);
  const createdResponse = await request('/v1/orders', buyer, {
    offerId: offer.id,
    expectedOfferRevision: offer.revision,
  });
  expect(createdResponse.status).toBe(201);
  const order = (await createdResponse.json()).order;
  for (const path of [
    `/v1/offers/${offer.id}?languages=`,
    `/v1/orders/${order.id}?languages=en,ja,fr,de,it,es,ko,zh,ar`,
  ]) {
    const response = await request(path);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_request');
  }
});
