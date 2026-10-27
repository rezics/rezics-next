import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import Stripe from 'stripe';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../src/database/pool.ts';
import { EFFECTS_CONSUMER, effectWorkflowId, type Effect } from '../src/events/effects.ts';
import type { Envelope } from '../src/events/log.ts';
import { createContext, contextTarget } from '../src/semantic/context.ts';
import { bootstrapRelease } from '../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../src/semantic/subject.ts';
import { readConfig, startServer } from '../src/server.ts';
import { createStripePort } from '../src/commerce/stripe.ts';
import { createCommerceWork } from '../src/commerce/work.ts';
import type { AccountActor } from '../src/request/access.ts';
import { readWorkerConfig, startWorker } from '../src/worker.ts';
import { createWorkClient } from '../src/work/client.ts';
import { WORK_QUEUES } from '../src/work/queues.ts';
import type { WorkContext, WorkModule } from '../src/work/registry.ts';
import { startWorkStripe } from './commerce/support/work-stripe.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const provider = Stripe.createSubtleCryptoProvider();
const secret = 'whsec_workerEffectsTest';
const SUBJECT_CREATED = 'com.rezics.subject.created.v1';
const CONTEXT_CREATED = 'com.rezics.semantic.context.created.v1';
const serverConfig = () =>
  readConfig({
    DATABASE_URL: databaseUrl,
    KERNEL_ROUTE_KEY: randomBytes(32).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${randomBytes(32).toString('base64url')}`,
    KERNEL_PORT: '0',
    STRIPE_SECRET_KEY: 'sk_test_worker_effects',
    STRIPE_MANAGED_PAYMENTS: 'false',
    STRIPE_WEBHOOK_SECRETS: secret,
    CHECKOUT_SUCCESS_URL: 'https://example.test/success',
    CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
    KERNEL_WRITE_RATE_SECRET: 'worker-effects-rate-test-secret-32',
  });

afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function checkpoint(partition: number): Promise<string | undefined> {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [EFFECTS_CONSUMER, partition],
  );
  return rows[0]?.position;
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

async function append(
  partition: number,
  type = SUBJECT_CREATED,
  data: unknown = { id: crypto.randomUUID() },
): Promise<{ epoch: number; position: bigint; subject: string }> {
  const subject = crypto.randomUUID();
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
      [partition, position, epoch, Bun.randomUUIDv7(), type, subject, JSON.stringify(data)],
    );
    await client.query('COMMIT');
    return { epoch, position: BigInt(position), subject };
  } finally {
    client.release();
  }
}

test("the worker relays every module's effects through one effect workflow", async () => {
  const seen: Array<{ module: string; id: string }> = [];
  let composedContext: WorkContext | undefined;
  const modules: WorkModule[] = [
    {
      name: 'subject_effect',
      register(context) {
        composedContext = context;
        context.addEffects([
          {
            name: 'subject_record',
            types: [SUBJECT_CREATED],
            async run(event) {
              seen.push({ module: 'subject', id: event.id });
            },
          },
        ]);
      },
    },
    {
      name: 'context_effect',
      register(context) {
        context.addEffects([
          {
            name: 'context_record',
            types: [CONTEXT_CREATED],
            async run(event) {
              seen.push({ module: 'context', id: event.id });
            },
          },
        ]);
      },
    },
  ];
  const registerWorkflow = spyOn(DBOS, 'registerWorkflow');
  const env = { DATABASE_URL: databaseUrl, KERNEL_EXECUTOR_ID: `worker-effects-${crypto.randomUUID()}` };
  const worker = await startWorker(readWorkerConfig(env), modules, env);
  const actor: AccountActor = {
    kind: 'account',
    accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
    clientId: 'worker-effects-test',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  };
  const routeKey = randomBytes(32);
  try {
    expect(() => composedContext!.addEffects([])).toThrow(/after work composition/);
    await bootstrapRelease(pool, bundledRelease);
    const subjectKey = crypto.randomUUID();
    const subject = await createSubject(pool, {
      actor,
      target: subjectTarget(routeKey, actor.accountId, subjectKey),
      idempotencyKey: subjectKey,
      digest: createHash('sha256').update(subjectKey).digest(),
      item: { type: 'schema:Person', labels: { en: 'Worker effect subject' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    const contextKey = crypto.randomUUID();
    const context = await createContext(pool, {
      actor,
      target: contextTarget(routeKey, actor.accountId, contextKey),
      idempotencyKey: contextKey,
      digest: createHash('sha256').update(contextKey).digest(),
      input: { labels: { en: 'Worker effect context' } },
      authorize: async () => true,
    });

    const subjectEnvelope: Envelope = { ...subject.component, events: [] };
    const contextEnvelope: Envelope = { ...context.component, events: [] };
    const subjectWorkflowId = effectWorkflowId(subjectEnvelope, 0, 'subject_record');
    const contextWorkflowId = effectWorkflowId(contextEnvelope, 0, 'context_record');
    await DBOS.retrieveWorkflow(subjectWorkflowId).getResult();
    await DBOS.retrieveWorkflow(contextWorkflowId).getResult();
    await until(() => seen.length === 2);
    expect(seen).toHaveLength(2);
    expect(seen.map(({ module }) => module).sort()).toEqual(['context', 'subject']);
    expect(await DBOS.getWorkflowStatus(subjectWorkflowId)).toMatchObject({
      workflowName: 'effect',
      queueName: 'effects',
      queuePartitionKey: `subject_record:${subject.component.partition}`,
    });
    expect(await DBOS.getWorkflowStatus(contextWorkflowId)).toMatchObject({
      workflowName: 'effect',
      queueName: 'effects',
      queuePartitionKey: `context_record:${context.component.partition}`,
    });
    expect(registerWorkflow.mock.calls.filter((call) => call[1]?.name === 'effect')).toHaveLength(1);
  } finally {
    registerWorkflow.mockRestore();
    await worker.stop();
  }
}, 45_000);

test('the HTTP server launches no work executor and runs no relay', async () => {
  const queueClient = await createWorkClient(databaseUrl);
  await queueClient.registerQueue('workflows', WORK_QUEUES.workflows);
  const server = await startServer(serverConfig());
  const partition = 3072 + Math.floor(Math.random() * 512);
  const eventId = `evt_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    const { position } = await append(partition, 'com.rezics.commerce.offer.created.v1', {
      offerId: crypto.randomUUID(),
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2026-10-01',
      created: timestamp,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_workerEffects123',
          object: 'checkout.session',
          payment_intent: 'pi_workerEffects123',
        },
      },
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
      timestamp,
      cryptoProvider: provider,
    });
    const response = await fetch(new URL('/v1/webhooks/stripe', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    const body = await response.text();
    expect(body).toContain('received');
    expect(response.status).toBe(200);
    await until(async () => {
      const { rows } = await admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid = $1', [
        `stripe:${eventId}`,
      ]);
      return rows.length === 1;
    });
    await Bun.sleep(500);
    expect(DBOS.isInitialized()).toBe(false);
    expect(await checkpoint(partition)).toBeUndefined();
    expect(position).toBeGreaterThan(0n);
  } finally {
    await server.stop();
    await queueClient.close();
  }
}, 30_000);

test('commerce registers its effects through the work context', async () => {
  const effects: Effect[] = [];
  const workflowNames: string[] = [];
  const registerStep = spyOn(DBOS, 'registerStep').mockImplementation(((fn: unknown) => fn) as never);
  const registerWorkflow = spyOn(DBOS, 'registerWorkflow').mockImplementation(((
    fn: unknown,
    options: { name?: string },
  ) => {
    if (options.name) workflowNames.push(options.name);
    return fn;
  }) as never);
  const transport = startWorkStripe();
  const stripe = createStripePort({
    apiKey: 'sk_test_work',
    managedPayments: false,
    host: '127.0.0.1',
    port: transport.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date('2000-01-01T00:00:00Z'),
  });
  const context = {
    pool,
    queues: WORK_QUEUES,
    client: { enqueue: async () => {} },
    env: {},
    addEffects(items: Effect[]) {
      effects.push(...items);
    },
  } as unknown as WorkContext;
  try {
    await createCommerceWork({
      stripe,
      checkout: { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' },
    }).register(context);
    expect(effects.map((effect) => effect.name)).toEqual(['commerce_royalty', 'commerce_reconcile_order']);
    expect(effects.map((effect) => effect.types)).toEqual([
      ['com.rezics.commerce.transactions.recorded.v1'],
      ['com.rezics.commerce.order.created.v1'],
    ]);
    expect(workflowNames).not.toContain('effect');
  } finally {
    transport.stop();
    registerStep.mockRestore();
    registerWorkflow.mockRestore();
  }
});

test('effect workflows run on the partitioned effects queue', () => {
  expect(WORK_QUEUES.effects).toMatchObject({ partitionConcurrency: 1 });
});
