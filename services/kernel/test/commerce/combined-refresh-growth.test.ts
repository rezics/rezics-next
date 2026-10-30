import { DBOS } from '@dbos-inc/dbos-sdk';
import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createCommerceWork } from '../../src/commerce/enqueue.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { checkGrowth } from '../support/growth.ts';
import { nativeAnchorFixture } from './support/checkout-anchor.ts';

test('combined SDK/native paid refresh stays anchored as unrelated native, provider and workflow histories grow separately', async () => {
  const f = await nativeAnchorFixture();
  const db = f.db;
  const client = await createWorkClient(db.url, db.pool);
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  let nativeClients = 0,
    maximumNativeClients = 0,
    retries = 0,
    attempts = 0;
  const instruments = new WeakSet<PoolClient>();
  db.pool.on('acquire', (connection) => {
    if (instruments.has(connection)) return;
    instruments.add(connection);
    const query = connection.query.bind(connection);
    let native = false;
    connection.query = (async (...args: unknown[]) => {
      const config = args[0] as { text?: string };
      const text = typeof args[0] === 'string' ? args[0] : (config?.text ?? '');
      if (/^BEGIN.*SERIALIZABLE/i.test(text)) {
        native = true;
        nativeClients++;
        attempts++;
        maximumNativeClients = Math.max(maximumNativeClients, nativeClients);
      }
      try {
        return await (query as (...args: unknown[]) => Promise<unknown>)(...args);
      } catch (e) {
        if ((e as { code?: string }).code === '40001') retries++;
        throw e;
      } finally {
        if (native && /^(COMMIT|ROLLBACK)/i.test(text)) {
          native = false;
          nativeClients--;
        }
      }
    }) as PoolClient['query'];
  });
  const sends: { requestBytes: number; responseBytes: number; nativeClients: number }[] = [];
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(`http://127.0.0.1:${f.fake.port}${url.pathname}${url.search}`, {
        headers: request.headers,
      });
      const bytes = await response.arrayBuffer();
      sends.push({
        requestBytes: Buffer.byteLength(url.pathname + url.search),
        responseBytes: bytes.byteLength,
        nativeClients,
      });
      expect(nativeClients).toBe(0); // Both native transactions release their client before provider I/O.
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  });
  try {
    const selected = await f.checkout(true, true);
    const historyOrder = await f.checkout(true, true);
    runtime = await composeWork([commerceWorkModule], {
      pool: db.pool,
      client,
      databaseUrl: db.url,
      executorId: 'commerce-combined-growth',
      env: {
        STRIPE_SECRET_KEY: 'sk_test_combined_growth',
        STRIPE_MANAGED_PAYMENTS: 'false',
        STRIPE_API_HOST: `http://127.0.0.1:${proxy.port}`,
        STRIPE_ACCOUNT_NAMESPACE: 'growth-direct',
        STRIPE_LIVEMODE: 'false',
        CHECKOUT_SUCCESS_URL: 'https://web.test/success',
        CHECKOUT_CANCEL_URL: 'https://web.test/cancel',
      },
    });
    await runtime.launch();
    for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
    const work = createCommerceWork(client);
    let sequence = 0;
    for (const axis of ['native', 'provider', 'workflow'] as const) {
      const report = await checkGrowth(db, {
        name: `Combined checkout refresh / unrelated ${axis} history`,
        scales: [64, 512, 4096],
        includeBackends: true,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        counted: {
          read: (value) => value as Record<string, number>,
          // Paid no-op: one locator, one expanded Session, one refund page and one dispute page.
          limits: { maximumNativeClients: 1, heldNativeAtProvider: 0, retries: 0, nativeAttempts: 2, providerSends: 4 },
          bounds: { providerSends: 'constant', providerRequestBytes: 'constant', providerResponseBytes: 'constant' },
        },
        async grow(_, scale, previous) {
          const pending: Promise<unknown>[] = [];
          for (let i = previous; i < scale; i++) {
            if (axis === 'native') {
              // Each unrelated native request authenticates again. The fixture's original actor
              // belongs to its setup request and must not be reused beyond that request deadline.
              const actor = await f.f.access.authenticate(f.buyer.bearer, {
                pool: db.pool,
                deadline: Date.now() + 5000,
              });
              await f.commands.createOrder(actor, f.offer.id, crypto.randomUUID());
            } else if (axis === 'provider')
              await f.stripe.createCheckoutSession(
                {
                  orderId: newId(routeOf(selected.id)!),
                  buyerAccountId: selected.buyerAccountId,
                  title: selected.title,
                  currency: selected.currency,
                  unitAmountMinor: selected.unitAmountMinor,
                  taxCode: selected.taxCode,
                  successUrl: 'https://web.test/success',
                  cancelUrl: 'https://web.test/cancel',
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
                `unrelated:${i}`,
              );
            else {
              // Genuine installed-SDK histories: same production internal caller, missing native anchors,
              // no financial facts/receipts or DBOS checkpoint rows inserted by a test wrapper.
              const id = await work.enqueueKnownOrderRepair(newId(routeOf(historyOrder.id)!), `history-${i}`);
              pending.push(client.retrieveWorkflow(id).getResult());
              if (pending.length === 64) await Promise.all(pending.splice(0));
            }
          }
          await Promise.all(pending);
        },
        async operation() {
          sends.length = 0;
          maximumNativeClients = nativeClients;
          retries = 0;
          attempts = 0;
          const id = await work.enqueueKnownOrderRepair(
            selected.id,
            `measurement-${String(sequence++).padStart(8, '0')}`,
          );
          await client.retrieveWorkflow(id).getResult();
          expect(nativeClients).toBe(0);
          const steps = await client.listWorkflowSteps(`${id}:refresh`);
          expect(steps?.map((s) => s.name)).toEqual(['commerce.refreshCheckout']);
          return {
            providerSends: sends.length,
            providerRequestBytes: sends.reduce((n, s) => n + s.requestBytes, 0),
            providerResponseBytes: sends.reduce((n, s) => n + s.responseBytes, 0),
            maximumNativeClients,
            heldNativeAtProvider: Math.max(0, ...sends.map((s) => s.nativeClients)),
            retries,
            nativeAttempts: attempts,
          };
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
      for (const sample of report.samples) {
        expect(sample.cost.rows).toBeGreaterThan(0);
        expect(sample.cost.statements).toBeGreaterThan(0);
        expect(Object.keys(sample.cost.relations).some((name) => name.includes('purchase_order'))).toBe(true);
        expect(sample.occurrenceRepetitions.every((run) => run.statements.every((s) => s.backend !== undefined))).toBe(
          true,
        );
      }
      console.log(JSON.stringify({ axis, orderId: selected.id, sessionId: selected.checkoutSessionId, report }));
    }
  } finally {
    await runtime?.shutdown();
    await client.close();
    proxy.stop(true);
    await f.close();
  }
}, 600000);
