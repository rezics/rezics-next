import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { ConfigError, readCommerceConfig } from '../../src/commerce/config.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

setDefaultTimeout(60_000);

const env = {
  STRIPE_SECRET_KEY: 'sk_test_checkout_return',
  STRIPE_WEBHOOK_SECRETS: 'whsec_checkout_return',
  STRIPE_MANAGED_PAYMENTS: 'false',
  CHECKOUT_SUCCESS_URL: 'https://web.example.test/orders/{ORDER_ID}?session={CHECKOUT_SESSION_ID}',
  CHECKOUT_CANCEL_URL: 'https://web.example.test/orders/{ORDER_ID}/cancel?session={CHECKOUT_SESSION_ID}',
};
const actions = ['offer:create', 'offer:manage', 'offer:read', 'order:create', 'order:read'];
const seller = newId(0x2200);
const buyer = newId(0x3300);
const tokens = new Map<string, string>();
const configuration = { successUrl: env.CHECKOUT_SUCCESS_URL, cancelUrl: env.CHECKOUT_CANCEL_URL };

let db: GrowthDatabase;
let fake: ReturnType<typeof startFakeStripe>;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;
let app: ReturnType<typeof createKernel>;
let stripe: ReturnType<typeof createStripePort>;
let worker: ReturnType<typeof Bun.spawn> | undefined;
let workerOutput = '';
let workerErrors = '';

function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  return (async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the worker: ${workerErrors}`);
      await Bun.sleep(10);
    }
  })();
}

async function request(path: string, accountId: string, body: unknown, requestKey = crypto.randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.get(accountId)!}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      body: JSON.stringify(body),
    }),
  );
}

function workerScript(): string {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  return `
    import { composeWork } from ${module('../../src/work/registry.ts')};
    import { createWorkClient } from ${module('../../src/work/client.ts')};
    import { createPool } from ${module('../../src/database/pool.ts')};
    import { createCommerceWork } from ${module('../../src/commerce/work.ts')};
    import { createStripePort } from ${module('../../src/commerce/stripe.ts')};
    const databaseUrl = process.env.DATABASE_URL;
    const pool = createPool(databaseUrl);
    const client = await createWorkClient(databaseUrl);
    const stripe = createStripePort({
      apiKey: 'sk_test_checkout_return',
      managedPayments: false,
      host: '127.0.0.1',
      port: Number(process.env.WORK_STRIPE_PORT),
      protocol: 'http',
      maxNetworkRetries: 0,
      clock: () => new Date(),
    });
    const work = await composeWork(
      [createCommerceWork({
        stripe,
        checkout: {
          successUrl: process.env.CHECKOUT_SUCCESS_URL,
          cancelUrl: process.env.CHECKOUT_CANCEL_URL,
        },
      })],
      { pool, client, databaseUrl, executorId: process.env.KERNEL_EXECUTOR_ID },
    );
    await work.launch();
    console.log('ready');
  `;
}

async function startWorker() {
  const child = Bun.spawn([process.execPath, '--eval', workerScript()], {
    env: {
      ...process.env,
      ...workerTestEnv({
        DATABASE_URL: db.url,
        KERNEL_EXECUTOR_ID: 'checkout-return-test',
        WORK_STRIPE_PORT: String(fake.port),
        CHECKOUT_SUCCESS_URL: configuration.successUrl,
        CHECKOUT_CANCEL_URL: configuration.cancelUrl,
      }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  worker = child;
  workerOutput = '';
  workerErrors = '';
  void (async () => {
    for await (const bytes of child.stdout as ReadableStream<Uint8Array>)
      workerOutput += new TextDecoder().decode(bytes);
  })();
  void (async () => {
    for await (const bytes of child.stderr as ReadableStream<Uint8Array>)
      workerErrors += new TextDecoder().decode(bytes);
  })();
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`Commerce worker exited: ${workerErrors}`);
      return workerOutput;
    },
    (output) => output.includes('ready'),
  );
}

async function stopWorker() {
  if (!worker) return;
  worker.kill('SIGKILL');
  await worker.exited;
  worker = undefined;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: env.STRIPE_SECRET_KEY,
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeoutMs: 1000,
    clock: () => new Date(),
  });
  workClient = await createWorkClient(db.url);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'checkout-return', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
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
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
    commerce: {
      stripe,
      get successUrl() {
        return configuration.successUrl;
      },
      get cancelUrl() {
        return configuration.cancelUrl;
      },
      webhookSecrets: [fake.webhookSecret],
      work: { async enqueueStripeEvent() {} },
    },
  });
  for (const id of [seller, buyer]) {
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
        .setProtectedHeader({ alg: 'ES256', kid: 'checkout-return', typ: 'at+jwt' })
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
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
      }),
    );
    if (opened.status !== 200) throw new Error(`Opening ${group} failed: ${opened.status} ${await opened.text()}`);
  }
});

beforeEach(async () => {
  configuration.successUrl = env.CHECKOUT_SUCCESS_URL;
  configuration.cancelUrl = env.CHECKOUT_CANCEL_URL;
  fake.nextCreateFault = null;
  fake.requests.length = 0;
  await db.admin.query(
    'TRUNCATE commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer, access.resource_role_grant, access.resource_initialization, access.resource_grant, access.resource_denial, core.receipt, core.outbox',
  );
  await db.admin.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller],
  );
});

afterAll(async () => {
  await stopWorker();
  fake?.stop();
  await workClient?.close();
  await db?.close();
});

test('checkout return URLs substitute the order ID for HTTP creates and lost create reconciliation', async () => {
  configuration.successUrl = 'https://web.example.test/success?session={CHECKOUT_SESSION_ID}';
  configuration.cancelUrl = 'https://web.example.test/cancel?session={CHECKOUT_SESSION_ID}';
  const unchangedOfferResponse = await request('/v1/offers', seller, {
    targetSubjectId: newId(0x5500),
    title: 'Book without an order placeholder',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  });
  if (unchangedOfferResponse.status !== 201)
    throw new Error(`Offer creation failed: ${unchangedOfferResponse.status} ${await unchangedOfferResponse.text()}`);
  expect(unchangedOfferResponse.status).toBe(201);
  const unchangedOfferId = (await unchangedOfferResponse.json()).offer.id;
  const unchangedOfferRead = await app.handle(new Request(`http://kernel.test/v1/offers/${unchangedOfferId}`));
  expect(unchangedOfferRead.status).toBe(200);
  const unchangedOffer = (await unchangedOfferRead.json()).offer;
  const unchangedResponse = await request('/v1/orders', buyer, {
    offerId: unchangedOffer.id,
    expectedOfferRevision: unchangedOffer.revision,
  });
  expect(unchangedResponse.status).toBe(201);
  const unchangedOrder = (await unchangedResponse.json()).order;
  const unchangedCreate = fake.requests.find(
    (request) => request.method === 'POST' && request.params.get('client_reference_id') === unchangedOrder.id,
  )!;
  expect(unchangedCreate.params.get('success_url')).toBe(configuration.successUrl);
  expect(unchangedCreate.params.get('cancel_url')).toBe(configuration.cancelUrl);

  configuration.successUrl = env.CHECKOUT_SUCCESS_URL;
  configuration.cancelUrl = env.CHECKOUT_CANCEL_URL;
  const offerResponse = await request('/v1/offers', seller, {
    targetSubjectId: newId(0x5500),
    title: 'Book with an order placeholder',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  });
  expect(offerResponse.status).toBe(201);
  const offerId = (await offerResponse.json()).offer.id;
  const offerRead = await app.handle(new Request(`http://kernel.test/v1/offers/${offerId}`));
  expect(offerRead.status).toBe(200);
  const offer = (await offerRead.json()).offer;
  const createdResponse = await request('/v1/orders', buyer, {
    offerId: offer.id,
    expectedOfferRevision: offer.revision,
  });
  expect(createdResponse.status).toBe(201);
  const createdOrder = (await createdResponse.json()).order;
  const createdRequest = fake.requests.find(
    (request) => request.method === 'POST' && request.params.get('client_reference_id') === createdOrder.id,
  )!;
  expect(createdRequest.params.get('success_url')).toBe(
    `https://web.example.test/orders/${createdOrder.id}?session={CHECKOUT_SESSION_ID}`,
  );
  expect(createdRequest.params.get('cancel_url')).toBe(
    `https://web.example.test/orders/${createdOrder.id}/cancel?session={CHECKOUT_SESSION_ID}`,
  );

  fake.nextCreateFault = 'lost';
  const lostResponse = await request('/v1/orders', buyer, { offerId: offer.id, expectedOfferRevision: offer.revision });
  expect(lostResponse.status).toBe(503);
  const unknown = (await db.admin.query("SELECT order_id FROM commerce.purchase_order WHERE settlement='unknown'"))
    .rows;
  expect(unknown).toHaveLength(1);
  const orderId = unknown[0]!.order_id as string;
  const reconcileId = `order:${orderId}:reconcile`;
  await startWorker();
  const reconcile = await workClient.enqueue(
    { workflowName: 'commerce.reconcileOrder', workflowID: reconcileId, queueName: 'workflows' },
    orderId,
  );
  await reconcile.getResult();

  const creates = fake.requests.filter(
    (request) => request.method === 'POST' && request.params.get('client_reference_id') === orderId,
  );
  expect(creates).toHaveLength(2);
  expect(creates.every((request) => request.headers.get('idempotency-key') === `order:${orderId}`)).toBe(true);
  expect(creates.map((request) => request.params.get('success_url'))).toEqual([
    `https://web.example.test/orders/${orderId}?session={CHECKOUT_SESSION_ID}`,
    `https://web.example.test/orders/${orderId}?session={CHECKOUT_SESSION_ID}`,
  ]);
  expect(creates.map((request) => request.params.get('cancel_url'))).toEqual([
    `https://web.example.test/orders/${orderId}/cancel?session={CHECKOUT_SESSION_ID}`,
    `https://web.example.test/orders/${orderId}/cancel?session={CHECKOUT_SESSION_ID}`,
  ]);
  expect(creates[0]!.params.toString()).toBe(creates[1]!.params.toString());
});

test('checkout configuration rejects unknown placeholders and URLs invalid after substitution', () => {
  for (const [variable, value] of [
    ['CHECKOUT_SUCCESS_URL', 'https://web.example.test/orders/{ACCOUNT_ID}'],
    ['CHECKOUT_CANCEL_URL', 'http://web.example.test/orders/{ORDER_ID}'],
    ['CHECKOUT_SUCCESS_URL', 'https://web.example.test:{ORDER_ID}/orders'],
  ] as const) {
    let error: unknown;
    try {
      readCommerceConfig({ ...env, [variable]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`Invalid or missing ${variable}`);
    expect((error as Error).message).not.toContain(value);
  }
});
