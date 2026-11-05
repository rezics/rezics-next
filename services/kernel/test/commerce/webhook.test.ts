import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import Stripe from 'stripe';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import { HANDLED_STRIPE_EVENTS, type StripeEventRef } from '../../src/commerce/model.ts';
import { classifyStripeEvent, verifyStripeEvent, WebhookSignatureError } from '../../src/commerce/webhook.ts';
import { stripeWebhookRoutes } from '../../src/commerce/webhook-routes.ts';
import { STRIPE_EVENT_WORKFLOW, WORKFLOWS_QUEUE } from '../../src/commerce/work-contract.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { declareKernelWriteRates } from '../../src/http/write-rate-routes.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const secret = 'whsec_webhookBoundaryTest';
const now = Math.floor(Date.now() / 1000);
const provider = Stripe.createSubtleCryptoProvider();
let client: DBOSClient;
let app: ReturnType<typeof makeApp>;
const eventId = () => `evt_${crypto.randomUUID().replaceAll('-', '')}`;

function makeApp(work = createCommerceWork(client), secrets: readonly string[] = [secret]) {
  const app = stripeWebhookRoutes(
    createApp({
      pool,
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
    }),
    { secrets, work, clock: () => now * 1000 },
  );
  declareKernelWriteRates(app);
  return app;
}

beforeAll(async () => {
  client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: 'dbos' });
  app = makeApp();
});
afterAll(async () => {
  await client?.destroy();
  await pool.end();
});

function event(type: string, object?: Record<string, unknown>) {
  const session = type.startsWith('checkout.session.');
  const dispute = type.startsWith('charge.dispute.');
  const refund = type.startsWith('refund.') || type === 'charge.refund.updated';
  return {
    id: eventId(),
    object: 'event',
    api_version: '2026-10-01',
    created: now - 10,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: object ?? {
        id: session ? 'cs_test_boundary123' : dispute ? 'du_boundary123' : refund ? 're_boundary123' : 'ch_boundary123',
        object: session ? 'checkout.session' : dispute ? 'dispute' : refund ? 'refund' : 'charge',
        payment_intent: 'pi_boundary123',
        ...(session
          ? { mode: 'payment', status: 'complete', payment_status: 'paid' }
          : { amount: 100, currency: 'usd' }),
        metadata: { private: 'never-store-or-echo-this' },
      },
    },
  };
}

async function sign(payload: string, signingSecret = secret, timestamp = now) {
  return Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: signingSecret,
    timestamp,
    cryptoProvider: provider,
  });
}

async function deliver(payload: string, header: string | null, target = app) {
  const response = await target.handle(
    new Request('http://kernel.test/v1/webhooks/stripe', {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'stripe-signature': header }) },
    }),
  );
  const text = await response.text();
  expect(text).not.toContain('never-store-or-echo-this');
  return { response, body: JSON.parse(text) };
}

async function rows(id: string) {
  return (await pool.query('SELECT * FROM dbos.workflow_status WHERE workflow_uuid = $1', [`stripe:${id}`])).rows;
}

for (const type of HANDLED_STRIPE_EVENTS) {
  test(`${type} enqueues exactly one durable workflow with identifiers only`, async () => {
    const input = event(type);
    const payload = JSON.stringify(input, null, 2);
    const result = await deliver(payload, await sign(payload));
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(await rows(input.id)).toHaveLength(1);
    const ref: StripeEventRef = {
      eventId: input.id,
      type,
      created: input.created,
      livemode: false,
      sessionId: type.startsWith('checkout.session.') ? 'cs_test_boundary123' : null,
      paymentIntentId: 'pi_boundary123',
    };
    expect(await client.getWorkflow(`stripe:${input.id}`)).toMatchObject({
      status: 'ENQUEUED',
      workflowName: STRIPE_EVENT_WORKFLOW,
      queueName: WORKFLOWS_QUEUE,
      queuePartitionKey: undefined,
      input: [ref],
    });
    expect((await client.getWorkflow(`stripe:${input.id}`))?.input).toEqual([ref]);
  });
}

test('redelivery, including concurrent requests, finds the same workflow by event ID', async () => {
  const input = event('checkout.session.completed');
  const payload = JSON.stringify(input);
  const header = await sign(payload);
  const results = await Promise.all([deliver(payload, header), deliver(payload, header), deliver(payload, header)]);
  expect(results.map(({ response }) => response.status)).toEqual([200, 200, 200]);
  expect(await rows(input.id)).toHaveLength(1);
});

for (const failure of ['wrong secret', 'tampered byte', 'missing header', 'malformed header', 'expired timestamp']) {
  test(`${failure} is invalid_signature and stores no workflow`, async () => {
    const input = event('checkout.session.completed');
    let payload = JSON.stringify(input);
    let header: string | null = await sign(
      payload,
      failure === 'wrong secret' ? 'whsec_wrong' : secret,
      failure === 'expired timestamp' ? now - 301 : now,
    );
    if (failure === 'tampered byte') payload = payload.replace('boundary123', 'boundary124');
    if (failure === 'missing header') header = null;
    if (failure === 'malformed header') header = 'not-a-stripe-signature';
    const result = await deliver(payload, header);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get('content-type')).toBe('application/problem+json');
    expect(result.body).toMatchObject({ code: 'invalid_signature', title: 'Invalid Signature', retryable: false });
    expect(await rows(input.id)).toHaveLength(0);
  });
}

test('the second configured secret verifies, and the 300-second boundary is accepted', async () => {
  const input = event('refund.updated');
  const payload = JSON.stringify(input);
  const result = await deliver(
    payload,
    await sign(payload, secret, now - 300),
    makeApp(undefined, ['whsec_old', secret]),
  );
  expect(result.response.status).toBe(200);
  expect(await rows(input.id)).toHaveLength(1);
});

for (const kind of ['unhandled', 'Connect', 'refund without PaymentIntent']) {
  test(`${kind} is acknowledged only after verification and enqueues nothing`, async () => {
    const input = {
      ...event(kind === 'unhandled' ? 'customer.created' : 'refund.created'),
      ...(kind === 'Connect' ? { account: 'acct_connected123' } : {}),
    };
    if (kind === 'refund without PaymentIntent') input.data.object.payment_intent = null;
    const payload = JSON.stringify(input);
    const forged = await deliver(payload, await sign(payload, 'whsec_forged'));
    expect(forged.response.status).toBe(400);
    expect(forged.body.code).toBe('invalid_signature');
    const result = await deliver(payload, await sign(payload));
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(await rows(input.id)).toHaveLength(0);
  });
}

test('oversized bytes are invalid_request without enqueueing', async () => {
  const input = event('checkout.session.completed');
  const payload = JSON.stringify({ ...input, padding: 'x'.repeat(256 * 1024) });
  const result = await deliver(payload, await sign(payload));
  expect(result.response.status).toBe(400);
  expect(result.body.code).toBe('invalid_request');
  expect(await rows(input.id)).toHaveLength(0);
});

test('a failing DBOS client returns dependency_unavailable so Stripe retries', async () => {
  const failing = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'missing_commerce_dbos',
  });
  try {
    const input = event('checkout.session.completed');
    const payload = JSON.stringify(input);
    const result = await deliver(payload, await sign(payload), makeApp(createCommerceWork(failing)));
    expect(result.response.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'dependency_unavailable', retryable: true });
    expect(await rows(input.id)).toHaveLength(0);
  } finally {
    await failing.destroy();
  }
});

test('the route declares no Access action and needs no bearer token', () => {
  expect(actionCatalogue(app)).toEqual(actionCatalogue(createApp({ pool })));
  expect(actionCatalogue(app).size).toBe(0);
});

test('classification accepts expanded PaymentIntents and sessions with no PaymentIntent', () => {
  for (const type of HANDLED_STRIPE_EVENTS) {
    const input = event(type);
    input.data.object.payment_intent = { id: 'pi_expanded123', object: 'payment_intent' };
    expect(classifyStripeEvent(input as unknown as Stripe.Event)?.paymentIntentId).toBe('pi_expanded123');
    input.data.object.payment_intent = null;
    const classified = classifyStripeEvent(input as unknown as Stripe.Event);
    if (type.startsWith('checkout.session.'))
      expect(classified).toMatchObject({ sessionId: 'cs_test_boundary123', paymentIntentId: null });
    else expect(classified).toBeNull();
  }
});

test('malformed identifiers never become durable work', () => {
  for (const bad of ['', 'evt_', 'pi_wrong', 'evt_has spaces', 'evt_path/part']) {
    expect(classifyStripeEvent({ ...event('refund.created'), id: bad } as unknown as Stripe.Event)).toBeNull();
  }
  for (const [type, object] of [
    ['checkout.session.completed', { id: 'pi_wrong', payment_intent: 'pi_valid123' }],
    ['refund.created', { id: 're_valid123', payment_intent: 'ch_wrong' }],
    ['charge.refunded', { id: 'ch_valid123', payment_intent: { id: 'pi_' } }],
  ] as const) {
    expect(classifyStripeEvent(event(type, object) as unknown as Stripe.Event)).toBeNull();
  }
});

test('verification normalizes failures and refuses an empty secret list', async () => {
  const payload = JSON.stringify(event('refund.created'));
  const raw = new TextEncoder().encode(payload);
  await expect(verifyStripeEvent(raw, await sign(payload), [], now * 1000)).rejects.toBeInstanceOf(
    WebhookSignatureError,
  );
  await expect(verifyStripeEvent(raw, null, [secret], now * 1000)).rejects.toBeInstanceOf(WebhookSignatureError);
  const invalidJson = '{invalid-json';
  await expect(
    verifyStripeEvent(new TextEncoder().encode(invalidJson), await sign(invalidJson), [secret], now * 1000),
  ).rejects.toBeInstanceOf(WebhookSignatureError);
});

test('Oversized signature input and excessive configured verification secrets are rejected without durable or payment effects', async () => {
  const input = event('checkout.session.completed');
  const payload = JSON.stringify(input);
  const header = `${await sign(payload)},v0=`;
  const paddingBytes = 8193 - Buffer.byteLength(header, 'utf8');
  const signatures = [
    header + 'x'.repeat(paddingBytes),
    header + 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2),
  ];
  const excessive = makeApp(undefined, [secret, 'whsec_two', 'whsec_three', 'whsec_four', 'whsec_five']);
  const validHeader = await sign(payload);
  const verifier = spyOn(Stripe.webhooks, 'constructEventAsync');
  try {
    for (const oversized of signatures) {
      expect(Buffer.byteLength(oversized, 'utf8')).toBe(8193);
      const result = await deliver(payload, oversized);
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get('content-type')).toBe('application/problem+json');
      expect(result.body).toMatchObject({ code: 'invalid_signature', retryable: false });
    }
    const result = await deliver(payload, validHeader, excessive);
    expect(result.response.status).toBe(400);
    expect(result.body.code).toBe('invalid_signature');
    expect(verifier).not.toHaveBeenCalled();
  } finally {
    verifier.mockRestore();
  }
  expect(await rows(input.id)).toHaveLength(0);
});

test('Valid bounded overlapping signatures retain raw-body verification rotation dedupe and durable acknowledgement', async () => {
  const input = event('checkout.session.completed');
  const payload = JSON.stringify(input, null, 2) + '\n';
  const previous = 'whsec_previous';
  const target = makeApp(undefined, [previous, 'whsec_inactiveOne', 'whsec_inactiveTwo', secret]);
  const oldHeader = await sign(payload, previous);
  const currentHeader = await sign(payload);
  const overlap = `${oldHeader},v1=${'0'.repeat(64)},${currentHeader.split(',')[1]}`;
  for (const [index, signed] of [oldHeader, currentHeader, overlap].entries()) {
    const prefix = `${signed},v0=`;
    const paddingBytes = 8192 - Buffer.byteLength(prefix, 'utf8');
    const header =
      prefix +
      (index === 1
        ? 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2)
        : 'x'.repeat(paddingBytes));
    expect(Buffer.byteLength(header, 'utf8')).toBe(8192);
    const result = await deliver(payload, header, target);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(await rows(input.id)).toHaveLength(1);
    expect((await client.getWorkflow(`stripe:${input.id}`))?.status).toBe('ENQUEUED');
  }
});
