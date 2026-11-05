import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PoolClient } from 'pg';
import { createCommerceWork } from '../../../src/commerce/work.ts';
import { readCommerceWorkerConfig } from '../../../src/commerce/config.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../../src/work/registry.ts';
import type { Boundary, Control, Notice } from './refresh-user-fixture.ts';

// Test scheduling only: no replacement command, receipt, queue, revision or settlement implementation.
const gates = new Map<string, { token: string; release(): void; wait: Promise<void> }>();
const send = (message: Notice) => process.send?.({ ...message, pid: process.pid });
const gateKey = (workflow: string, point: Boundary) => `${workflow}/${point}`;
async function boundary(workflow: string, point: Boundary) {
  const key = gateKey(workflow, point);
  const gate = gates.get(key);
  if (!gate) return;
  gates.delete(key);
  send({ kind: 'boundary', workflow, point, token: gate.token });
  await gate.wait;
  send({ kind: 'released', workflow, point, token: gate.token });
}
const returned = new Set<string>();
const releases = new Map<string, () => void>();
process.on('message', (message: Control) => {
  if (message.kind === 'arm') {
    if (gates.size >= 12 || message.workflow.length > 255) throw new Error('Fixture barrier bound exceeded');
    const wait = Promise.withResolvers<void>();
    gates.set(gateKey(message.workflow, message.point), {
      token: message.token,
      wait: wait.promise,
      release: wait.resolve,
    });
    releases.set(message.token, wait.resolve);
    send({ kind: 'armed', token: message.token });
  } else if (message.kind === 'release') {
    releases.get(message.token)?.();
    releases.delete(message.token);
  }
});

const env = process.env;
const config = readCommerceWorkerConfig(env)!;
const realStripe = createStripePort({
  ...config.stripe,
  maxNetworkRetries: 0,
  clock: () => new Date(env.REFRESH_TIME!),
});
const module: WorkModule = {
  name: 'commerce',
  async register(context) {
    // Observe SQL without changing a statement, result, error, retry policy or transaction boundary.
    // A before-lock latch is reached only inside a real native SERIALIZABLE transaction.
    const instrumented = new WeakSet<PoolClient>();
    context.pool.on('acquire', (client) => {
      if (instrumented.has(client)) return;
      instrumented.add(client);
      const query = client.query.bind(client);
      let native = false;
      let applying = false;
      let admission = false;
      client.query = (async (...args: unknown[]) => {
        const config = args[0] as { text?: string; values?: unknown[] };
        const statement = typeof args[0] === 'string' ? args[0] : (config?.text ?? '');
        const values = Array.isArray(args[1]) ? args[1] : config?.values;
        const workflow = DBOS.workflowID;
        if (/^BEGIN/i.test(statement)) {
          native = /SERIALIZABLE/i.test(statement);
          applying = false;
          admission = false;
        }
        if (native && values?.includes('commerce.checkout.apply')) applying = true;
        if (native && values?.includes('commerce.checkout.refresh')) admission = true;
        // Admission precedes the full read. Apply's authorization locks the order before
        // its receipt lookup, so the receipt kind cannot identify that first lock.
        if (
          workflow &&
          returned.has(workflow) &&
          native &&
          /commerce\.purchase_order/i.test(statement) &&
          /FOR UPDATE/i.test(statement)
        ) {
          await boundary(workflow, 'order-lock');
        }
        try {
          const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args);
          if (workflow && returned.has(workflow) && /SELECT owner_xid FROM/i.test(statement))
            send({ kind: 'checkpoint', workflow });
          if (workflow && native && applying && !admission && /^COMMIT/i.test(statement)) {
            native = false;
            await boundary(workflow, 'commit');
          }
          return result;
        } catch (error) {
          if (workflow && (error as { code?: string }).code === '40001') send({ kind: 'serialization', workflow });
          throw error;
        } finally {
          if (/^ROLLBACK/i.test(statement)) native = false;
        }
      }) as PoolClient['query'];
    });
    await createCommerceWork({
      checkout: { successUrl: config.successUrl, cancelUrl: config.cancelUrl },
      stripe: {
        ...realStripe,
        async readCheckout(...args) {
          const snapshot = await realStripe.readCheckout(...args);
          const workflow = DBOS.workflowID!;
          send({
            kind: 'read',
            workflow,
            session: snapshot.sessionId,
            observedAt: snapshot.observedAt,
            refunds: snapshot.refunds,
            disputes: snapshot.disputes,
            transactions: snapshot.transactions.map((t) => t.id),
          });
          const signal = DBOS.stepStatus?.cancelSignal;
          signal?.addEventListener('abort', () => send({ kind: 'cancel-signal', workflow }), { once: true });
          await boundary(workflow, 'read');
          returned.add(workflow);
          return snapshot; // Entire real adapter result, untouched, after every provider request completed.
        },
      },
    }).register(context);
  },
};
// Match the existing native Commerce fixture's production registration. Webhook commands enqueue
// through the real client; unrelated outbox relays are not part of these selected refresh schedules.
const pool = createPool(env.DATABASE_URL!);
pool.on('error', () => {});
const client = await createWorkClient(env.DATABASE_URL!);
const worker = await composeWork([module], {
  pool,
  client,
  databaseUrl: env.DATABASE_URL!,
  executorId: env.KERNEL_EXECUTOR_ID!,
  clock: () => new Date(env.REFRESH_TIME!),
});
await worker.launch();
for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
send({ kind: 'ready' });
