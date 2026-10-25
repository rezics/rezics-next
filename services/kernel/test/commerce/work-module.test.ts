import { expect, test } from 'bun:test';
import { STRIPE_EVENT_WORKFLOW } from '../../src/commerce/work-contract.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { startWorker, readWorkerConfig } from '../../src/worker.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('the configured commerce module runs a workflow using the worker environment', async () => {
  const stripe = startFakeStripe();
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    STRIPE_SECRET_KEY: 'sk_test_commerce_worker',
    STRIPE_MANAGED_PAYMENTS: 'false',
    STRIPE_API_HOST: `http://127.0.0.1:${stripe.port}`,
    CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
    CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
  };
  delete env.STRIPE_WEBHOOK_SECRETS;

  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  try {
    worker = await startWorker(readWorkerConfig(env), undefined, env);
    client = await createWorkClient(databaseUrl);
    const workflowID = `commerce-worker:${crypto.randomUUID()}`;
    const handle = await client.enqueue(
      { workflowName: STRIPE_EVENT_WORKFLOW, queueName: 'workflows', workflowID },
      {
        eventId: `evt_${crypto.randomUUID()}`,
        type: 'refund.created',
        created: 0,
        livemode: false,
        sessionId: null,
        paymentIntentId: 'pi_missing',
      },
    );

    expect(await handle.getResult()).toBeUndefined();
    expect(
      stripe.requests.some((request) => request.method === 'GET' && request.path === '/v1/checkout/sessions'),
    ).toBe(true);
  } finally {
    await worker?.stop();
    await client?.close();
    stripe.stop();
  }
  expect(commerceWorkModule.name).toBe('commerce');
}, 30_000);
