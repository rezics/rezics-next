import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { createPersonas, PERSONAS_VERSION, type Persona } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startFakeStripe } from './support/fake-stripe.ts';
import { until } from './support/work-fixture.ts';

test('the actual default worker reconciles retained refund reversals after real Auth deletion without restoring benefits', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 6 });
  const auth = await nativeFixture(pool);
  const fake = startFakeStripe();
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const service = auth.host.service;
    const kernel = testKernel({
      pool,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({ secret: 'default-refresh-terminal-rate-secret-32-bytes' }),
    });
    const options = { version: PERSONAS_VERSION, pool, auth } as const;
    const people = await createPersonas(kernel, options);
    async function post(persona: Persona, path: string, body: unknown) {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${persona.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify(body),
        }),
      );
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    }
    for (const group of ['purchases', 'selling']) await post(people.staff, `/v1/platform/exposure/${group}:open`, {});
    for (const [resource, actions] of [
      [PLATFORM_RESOURCE, ['offer:create']],
      [{ route: 0, id: GLOBAL_CONTEXT }, ['subject:create']],
    ] as const)
      await post(people.staff, '/v1/grants', {
        resource,
        subject: { kind: 'account', id: people.staff.accountId },
        actions,
        valid: '(,)',
      });
    // The full default worker also consumes account-agent effects from these real accounts.
    await bootstrapRelease(pool, bundledRelease);
    const target = (
      await post(people.staff, '/v1/subjects', { type: 'schema:Book', labels: { en: 'Retained financial book' } })
    ).subject.id;
    const offer = (
      await post(people.staff, '/v1/offers', {
        targetSubjectId: target,
        title: 'Retained book',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      })
    ).offer;
    const commands = createCommerceCommands({ pool, access: kernel.testAccess });
    const actor = await kernel.testAccess.authenticate(people.alice.bearer, { pool, deadline: Date.now() + 10000 });
    const order = (await commands.createOrder(actor, offer.id, crypto.randomUUID())).value;
    const stripe = createStripePort({
      apiKey: 'sk_test_terminal_default',
      managedPayments: false,
      host: '127.0.0.1',
      port: fake.port,
      protocol: 'http',
      maxNetworkRetries: 0,
      clock: () => new Date(),
    });
    const session = await stripe.createCheckoutSession(
      {
        orderId: order.id,
        buyerAccountId: order.buyerAccountId,
        title: order.title,
        currency: order.currency,
        unitAmountMinor: order.unitAmountMinor,
        taxCode: order.taxCode,
        successUrl: 'https://web.test/success',
        cancelUrl: 'https://web.test/cancel',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      `order:${order.id}`,
    );
    await commands.recordCheckout(order.id, { session });
    let ready = false;
    let diagnostics = '';
    worker = Bun.spawn([process.execPath, `${import.meta.dir}/support/default-work-runtime.ts`], {
      env: {
        ...process.env,
        ...workerTestEnv({
          STRIPE_SECRET_KEY: 'sk_test_terminal_default',
          STRIPE_MANAGED_PAYMENTS: 'false',
          STRIPE_API_HOST: `http://127.0.0.1:${fake.port}`,
          CHECKOUT_SUCCESS_URL: 'https://web.test/success',
          CHECKOUT_CANCEL_URL: 'https://web.test/cancel',
          REFRESH_TIME: new Date().toISOString(),
          KERNEL_EXECUTOR_ID: 'commerce-terminal-default',
        }),
      },
      stdout: 'ignore',
      stderr: 'pipe',
      ipc(message: { kind: string }) {
        if (message.kind === 'ready') ready = true;
      },
    });
    const owned = worker;
    void (async () => {
      for await (const bytes of owned.stderr as ReadableStream<Uint8Array>)
        diagnostics += new TextDecoder().decode(bytes);
    })();
    await until(async () => {
      if (owned.exitCode !== null) throw new Error(diagnostics);
      return ready;
    }, Boolean);
    const work = createCommerceWork(client);
    async function repair(name: string) {
      const id = await work.enqueueKnownOrderRepair(order.id, name);
      try {
        await until(
          () => client.getWorkflow(id),
          (row) => row?.status === 'SUCCESS' || row?.status === 'ERROR',
        );
      } catch (error) {
        throw new Error(
          JSON.stringify({
            child: await client.getWorkflow(`${id}:refresh`),
            parentSteps: await client.listWorkflowSteps(id),
            childSteps: await client.listWorkflowSteps(`${id}:refresh`),
            diagnostics,
          }),
          { cause: error },
        );
      }
      await client.retrieveWorkflow(id).getResult();
    }
    fake.pay(session.id);
    await repair('initial-payment');
    const refund = fake.refund(session.id, { amount: 1200 });
    await repair('full-refund');
    expect(
      await pool
        .query('SELECT revoked_at FROM commerce.entitlement WHERE route=$1 AND order_id=$2', [
          routeOf(order.id),
          order.id,
        ])
        .then((r) => r.rows[0]?.revoked_at),
    ).not.toBeNull();
    const terminal = await deletePersona(options, people.alice);
    expect(terminal.accountId).toBe(order.buyerAccountId);
    fake.failRefund(refund);
    await repair('post-terminal-reversal');
    const retained = await pool.query('SELECT settlement FROM commerce.purchase_order WHERE route=$1 AND order_id=$2', [
      routeOf(order.id),
      order.id,
    ]);
    expect(retained.rows[0].settlement).toBe('paid');
    const entitlements = await pool.query(
      'SELECT revoked_at FROM commerce.entitlement WHERE route=$1 AND order_id=$2',
      [routeOf(order.id), order.id],
    );
    expect(entitlements.rows.every((r) => r.revoked_at !== null)).toBe(true);
    const tx = await pool.query(
      'SELECT balance_transaction_id FROM commerce.order_transaction WHERE route=$1 AND order_id=$2',
      [routeOf(order.id), order.id],
    );
    expect(tx.rows).toHaveLength(3); // Charge, refund, refund failure: financial truth continues after T.
  } finally {
    if (worker) {
      worker.kill('SIGKILL');
      await worker.exited;
    }
    await client.close();
    fake.stop();
    await auth.close();
    await pool.end();
  }
}, 360000);
