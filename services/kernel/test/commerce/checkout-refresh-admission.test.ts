import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Pool, type PoolClient } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { createCommerceCommands, stepCommandKey, type CheckoutRefreshClaim } from '../../src/commerce/commands.ts';
import type { Order } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createProfileEntryFixture,
  entryKey,
  type NativeProfileFixture,
} from '../library/support/profile-entry-fixture.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

setDefaultTimeout(30_000);
let f: NativeProfileFixture;
let pool: Pool;
let reader: Pool;
let fake: ReturnType<typeof startFakeStripe>;
let stripe: ReturnType<typeof createStripePort>;
let proxy: ReturnType<typeof Bun.serve>;
const refundBytes = new Map<string, 'pending' | 'canceled'>();
let commands: ReturnType<typeof createCommerceCommands>;
let otherCommands: ReturnType<typeof createCommerceCommands>;
let buyer: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let offerId: string;
let instant = '2026-10-29T12:00:00.000Z';
type Trace = { statement: string; values: unknown[]; error?: string };
const trace: Trace[] = [];
let armed:
  | { point: 'before-lock' | 'before-fence' | 'after-commit'; captured(): void; wait: Promise<void> }
  | undefined;
function arm(point: 'before-lock' | 'before-fence' | 'after-commit') {
  const captured = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  armed = { point, captured: captured.resolve, wait: released.promise };
  return { captured: captured.promise, release: released.resolve };
}

beforeAll(async () => {
  f = await createProfileEntryFixture();
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  reader = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    options: '-c default_transaction_read_only=on',
  });
  // Scheduling and observation only. Every statement/result/error and native retry is unchanged.
  pool.on('connect', (client: PoolClient) => {
    const query = client.query.bind(client);
    let native = false;
    client.query = (async (...args: unknown[]) => {
      const config = args[0] as { text?: string; values?: unknown[] };
      const statement = typeof args[0] === 'string' ? args[0] : (config?.text ?? '');
      const values = (Array.isArray(args[1]) ? args[1] : config?.values) ?? [];
      if (/^BEGIN/i.test(statement)) native = /SERIALIZABLE/i.test(statement);
      const row: Trace = { statement, values };
      if (native) trace.push(row);
      if (
        native &&
        ((armed?.point === 'before-lock' && /commerce\.purchase_order.*FOR UPDATE/is.test(statement)) ||
          (armed?.point === 'before-fence' && /UPDATE core\.partition/is.test(statement)))
      ) {
        const gate = armed!;
        armed = undefined;
        gate.captured();
        await gate.wait;
      }
      try {
        const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args);
        if (native && /^COMMIT/i.test(statement) && armed?.point === 'after-commit') {
          const gate = armed;
          armed = undefined;
          gate.captured();
          await gate.wait;
        }
        return result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code) row.error = code;
        throw error;
      } finally {
        if (/^(COMMIT|ROLLBACK)/i.test(statement)) native = false;
      }
    }) as PoolClient['query'];
  });
  commands = createCommerceCommands({ pool, access: f.access });
  otherCommands = createCommerceCommands({ pool: f.pool, access: f.access });
  buyer = await f.identity(['order:create', 'order:read', 'entitlement:read', 'entitlement:list']);
  for (const group of ['selling', 'purchases'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`, {})).status).toBe(200);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: Date.now() + 30_000 },
    {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: f.steward.actor.accountId },
      actions: ['offer:create'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  offerId = (
    await otherCommands.createOffer(
      f.steward.actor,
      {
        targetSubjectId: await f.createSubject('game'),
        title: 'Native refresh book',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      entryKey(),
    )
  ).value.id;
  fake = startFakeStripe();
  // Existing loopback provider, with legal no-balance pending/canceled refund bytes.
  proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(`http://127.0.0.1:${fake.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'POST' ? { body: await request.text() } : {}),
      });
      if (url.pathname !== '/v1/refunds' || !response.ok) return response;
      const body = await response.json();
      for (const refund of body.data)
        if (refundBytes.has(refund.id)) {
          refund.status = refundBytes.get(refund.id);
          refund.balance_transaction = null;
          refund.failure_balance_transaction = null;
        }
      return Response.json(body);
    },
  });
  stripe = createStripePort({
    apiKey: 'sk_test_native_refresh',
    managedPayments: false,
    host: '127.0.0.1',
    port: proxy.port!,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(instant),
  });
});
afterAll(async () => {
  await proxy?.stop(true);
  fake?.stop();
  await Promise.all([pool?.end(), reader?.end(), f?.close()]);
});

async function checkout() {
  // Verified actors are admitted to the fixture's pool; the scheduling pool hosts service commands only.
  const order = (await otherCommands.createOrder(buyer.actor, offerId, entryKey())).value;
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
  return (await commands.readOrderForAccount(buyer.actor.accountId, order.id))!;
}
async function begin(order: Order, workflowId = `wf:${entryKey()}`, executor = commands) {
  const result = await executor.beginCheckoutRefresh({
    orderId: order.id,
    sessionId: order.checkoutSessionId!,
    workflowId,
  });
  expect(result.kind).toBe('claimed');
  if (result.kind !== 'claimed') throw new Error('Expected fresh native admission');
  return result;
}
async function apply(claim: CheckoutRefreshClaim) {
  return commands.applyClaimedCheckoutSnapshot(await stripe.readCheckout(claim.order.checkoutSessionId!), claim);
}
async function paid() {
  const order = await checkout();
  fake.pay(order.checkoutSessionId!);
  const a = await begin(order);
  expect((await apply(a.command.value)).changed).toBe(true);
  return { order, a, session: order.checkoutSessionId! };
}
async function receipt(order: Order, kind: string, key: string) {
  return (
    await reader.query(
      `SELECT request_digest, transaction_id, epoch, position, response FROM core.receipt
    WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
      [partitionOf(routeOf(order.id)!), order.buyerAccountId, kind, key],
    )
  ).rows;
}
async function applyReceipt(claim: CheckoutRefreshClaim) {
  return receipt(claim.order, 'commerce.checkout.apply', stepCommandKey(claim.workflowId, 'apply'));
}
async function state(order: Order) {
  const params = [routeOf(order.id), order.id];
  const row = (
    await reader.query(
      'SELECT revision, settlement, observed_at::text, transaction_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
      params,
    )
  ).rows[0];
  const entitlement = (
    await reader.query(
      'SELECT entitlement_id, revision, revoked_at, revoke_reason FROM commerce.entitlement WHERE route=$1 AND order_id=$2',
      params,
    )
  ).rows;
  const transactions = (
    await reader.query(
      'SELECT balance_transaction_id, kind FROM commerce.order_transaction WHERE route=$1 AND order_id=$2 ORDER BY balance_transaction_id',
      params,
    )
  ).rows;
  const events = (
    await reader.query(
      'SELECT o.id, r.transaction_id, o.epoch, o.position, o.type, o.data FROM core.outbox o LEFT JOIN core.receipt r USING (partition_no,epoch,position) WHERE o.partition_no=$1 AND o.subject=$2 ORDER BY o.position,o.event_seq',
      [partitionOf(routeOf(order.id)!), order.id],
    )
  ).rows;
  const head = (
    await reader.query('SELECT epoch, position FROM core.partition WHERE partition_no=$1', [
      partitionOf(routeOf(order.id)!),
    ])
  ).rows;
  return { row, entitlement, transactions, events, head };
}

// This is a native prerequisite proof. It does not run or replace the frozen full DBOS user cases.
test('native refresh admission locks the immutable order and stable apply completion before a real revision claim and stale physical attempts cannot apply after a newer no-op admission or overtake a completed retry', async () => {
  const { order, a, session } = await paid();
  const old = await state(order);
  const capturedOrder = (await commands.readOrderForAccount(order.buyerAccountId, order.id))!;
  const start = trace.length;
  const noReads = fake.requests.length;
  const b = await begin(order);
  expect(fake.requests.length).toBe(noReads);
  const claimed = b.command.value;
  expect(claimed.order.revision).toBe(old.row.revision + 1);
  expect({ ...claimed.order, revision: capturedOrder.revision }).toEqual(capturedOrder);
  const after = await state(order);
  expect(after.events.length).toBe(old.events.length + 1);
  expect(after.transactions).toEqual(old.transactions);
  expect(after.entitlement).toEqual(old.entitlement);
  const admission = await receipt(order, 'commerce.checkout.refresh', claimed.attemptId);
  expect(admission).toHaveLength(1);
  expect(admission[0]).toMatchObject({ transaction_id: b.command.transactionId });
  expect(after.events.at(-1)).toMatchObject({
    transaction_id: b.command.transactionId,
    epoch: admission[0].epoch,
    position: admission[0].position,
    type: 'com.rezics.commerce.order.updated.v1',
    data: { orderId: order.id, revision: claimed.order.revision },
  });
  const statements = trace.slice(start);
  const lock = statements.findIndex((row) => /purchase_order.*FOR UPDATE/is.test(row.statement));
  const completion = statements.findIndex(
    (row) => /SELECT request_digest AS/is.test(row.statement) && row.values.includes('commerce.checkout.apply'),
  );
  const write = statements.findIndex((row) => /UPDATE commerce.purchase_order/is.test(row.statement));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(completion).toBeGreaterThan(lock);
  expect(write).toBeGreaterThan(completion);
  expect(statements[completion]!.values).toContain(stepCommandKey(claimed.workflowId, 'apply'));
  expect(statements[completion]!.statement).not.toMatch(/response/);
  expect((await apply(claimed)).changed).toBe(false);
  expect(await state(order)).toEqual(after); // Business rollback leaves the admission envelope committed.
  expect(await applyReceipt(claimed)).toHaveLength(0);

  // New physical B admission/read is parked while a completed A retry obtains that same lock.
  fake.refund(session, { amount: 1200 });
  const inflight = (await begin(order)).command.value;
  const refundBytes = await stripe.readCheckout(session);
  const admitted = await state(order);
  const gate = arm('before-lock');
  const retry = commands.beginCheckoutRefresh({
    orderId: order.id,
    sessionId: session,
    workflowId: a.command.value.workflowId,
  });
  await gate.captured;
  const reads = fake.requests.length;
  try {
    expect(await state(order)).toEqual(admitted);
  } finally {
    gate.release();
  }
  expect(await retry).toEqual({ kind: 'completed' });
  expect(await state(order)).toEqual(admitted);
  expect(fake.requests.length).toBe(reads);
  const originalReceipt = await applyReceipt(a.command.value);
  expect(originalReceipt).toHaveLength(1);
  expect(Buffer.from(originalReceipt[0].request_digest)).toEqual(
    createHash('sha256')
      .update(canonicalize({ orderId: order.id })!)
      .digest(),
  );
  expect(stepCommandKey(a.command.value.workflowId, 'apply')).not.toContain('wf:wf:');

  // B applies its captured bytes after the completed retry, without another admission/read.
  expect((await commands.applyClaimedCheckoutSnapshot(refundBytes, inflight)).changed).toBe(true);
  const refunded = await state(order);
  expect(refunded.entitlement[0].revoke_reason).toBe('refund');
  expect((await commands.applyClaimedCheckoutSnapshot(refundBytes, inflight)).changed).toBe(true); // Stable receipt acknowledges the original effect.
  expect(await state(order)).toEqual(refunded);
  expect(await applyReceipt(inflight)).toHaveLength(1);
  console.log(
    `native admission: revision ${old.row.revision}->${claimed.order.revision}->${refunded.row.revision}; completion retry +0; stable apply receipts 1`,
  );
});

for (const mode of ['pending-refund', 'dispute'] as const) {
  test(`old ${mode} loses to a newer no-op admission; equal/backward-clock refund and reversal apply once`, async () => {
    instant = '2026-10-29T12:00:00.000Z';
    const { order, session } = await paid();
    const a = await begin(order);
    let cancel: () => void;
    if (mode === 'dispute') {
      const dispute = fake.dispute(session, { withdraw: false });
      cancel = () => fake.updateDispute(dispute, 'won');
    } else {
      const refund = fake.refund(session, { amount: 1200, status: 'pending' });
      refundBytes.set(refund, 'pending');
      cancel = () => {
        fake.failRefund(refund);
        refundBytes.set(refund, 'canceled');
      };
    }
    const oldBytes = await stripe.readCheckout(session);
    expect(oldBytes.transactions).toHaveLength(1); // Charge only, no refund/dispute balances.
    cancel();
    const b = await begin(order);
    expect((await apply(b.command.value)).changed).toBe(false);
    expect(await applyReceipt(b.command.value)).toHaveLength(0);
    const beforeStale = await state(order);
    expect(beforeStale.row.revision).toBe(b.command.value.order.revision);
    expect(beforeStale.transactions).toHaveLength(1);
    expect(await commands.applyClaimedCheckoutSnapshot(oldBytes, a.command.value)).toEqual({
      changed: false,
      superseded: true,
    });
    expect(await applyReceipt(a.command.value)).toHaveLength(0);
    expect(await state(order)).toEqual(beforeStale);
    const refund = fake.refund(session, { amount: 1200 });
    const c = await begin(order);
    expect((await apply(c.command.value)).changed).toBe(true);
    const revoked = await state(order);
    expect(revoked.entitlement[0].revoke_reason).toBe('refund');
    expect(revoked.transactions).toHaveLength(2);
    expect(revoked.row.observed_at).toContain('2026-10-29');
    expect((await apply(c.command.value)).changed).toBe(true);
    expect(await state(order)).toEqual(revoked);
    fake.failRefund(refund);
    instant = '2026-10-28T12:00:00.000Z';
    const d = await begin(order);
    expect((await apply(d.command.value)).changed).toBe(true);
    const restored = await state(order);
    expect(restored.entitlement[0].revoked_at).toBeNull();
    expect(restored.transactions).toHaveLength(3);
    expect(restored.entitlement[0].entitlement_id).toBe(revoked.entitlement[0].entitlement_id);
    expect(restored.row.observed_at).toContain('2026-10-28');
    expect((await apply(d.command.value)).changed).toBe(true);
    expect(await state(order)).toEqual(restored);
    expect(await applyReceipt(c.command.value)).toHaveLength(1);
    expect(await applyReceipt(d.command.value)).toHaveLength(1);
    console.log(`native ${mode}: stale receipts 0; refund/reversal receipts 1/1; backward observation restored`);
  });
}

test('native serialization retries reuse one physical admission key and never refresh captured apply authority', async () => {
  const { order, session } = await paid();
  const start = trace.length;
  const gate = arm('before-lock');
  const pending = begin(order);
  await gate.captured;
  const b = await begin(order, undefined, otherCommands);
  gate.release();
  const a = await pending;
  expect(a.command.value.attemptId).not.toBe(b.command.value.attemptId);
  expect(a.command.value.order.revision).toBe(b.command.value.order.revision + 1);
  const retryTrace = trace.slice(start);
  expect(retryTrace.some((row) => row.error === '40001')).toBe(true);
  expect(await receipt(order, 'commerce.checkout.refresh', a.command.value.attemptId)).toHaveLength(1);
  const refreshLookups = retryTrace.filter((row) => row.values.includes(a.command.value.attemptId));
  expect(refreshLookups.length).toBeGreaterThan(0);
  const oldBytes = await stripe.readCheckout(session);
  const applyGate = arm('before-lock');
  const applying = commands.applyClaimedCheckoutSnapshot(oldBytes, a.command.value);
  await applyGate.captured;
  const c = await begin(order, undefined, otherCommands);
  applyGate.release();
  expect(await applying).toEqual({ changed: false, superseded: true });
  expect(trace.filter((row) => row.error === '40001').length).toBeGreaterThan(1);
  expect((await state(order)).row.revision).toBe(c.command.value.order.revision);
  expect(await applyReceipt(a.command.value)).toHaveLength(0);
  expect((await apply(c.command.value)).changed).toBe(false);
  console.log(
    'native PostgreSQL 40001: admission advanced once; stale apply retried with original revision and rolled back',
  );
});

test('a physical claim retried after its real conditional write uses the same receipt key and advances only once', async () => {
  const order = await checkout();
  const unrelated = await checkout(); // Same buyer partition, different immutable order lock.
  const before = await state(order);
  const start = trace.length;
  const gate = arm('before-fence');
  const pending = begin(order);
  await gate.captured;
  try {
    await begin(unrelated, undefined, otherCommands);
  } finally {
    gate.release();
  }
  const claimed = await pending;
  const rows = trace.slice(start);
  expect(rows.some((row) => row.error === '40001')).toBe(true);
  const lookups = rows.filter(
    (row) => /FROM core.receipt/i.test(row.statement) && row.values.includes(claimed.command.value.attemptId),
  );
  expect(lookups).toHaveLength(2);
  expect(rows.filter((row) => /UPDATE commerce.purchase_order/i.test(row.statement))).toHaveLength(2);
  const after = await state(order);
  expect(after.row.revision).toBe(before.row.revision + 1);
  expect(after.events.length).toBe(before.events.length + 1);
  expect(await receipt(order, 'commerce.checkout.refresh', claimed.command.value.attemptId)).toHaveLength(1);
  console.log(
    'native physical claim receipt retry: 2 conditional writes, 2 identical-key receipt lookups, 1 committed revision/event/receipt',
  );
});

test('a real committed apply precedes a successor admission even before its acknowledgement returns', async () => {
  const order = await checkout();
  fake.pay(order.checkoutSessionId!);
  const a = await begin(order);
  const snapshot = await stripe.readCheckout(order.checkoutSessionId!);
  const gate = arm('after-commit');
  const applying = commands.applyClaimedCheckoutSnapshot(snapshot, a.command.value);
  await gate.captured;
  try {
    expect(await applyReceipt(a.command.value)).toHaveLength(1);
    const committed = await state(order);
    expect(committed.entitlement).toHaveLength(1);
    const b = await begin(order, undefined, otherCommands);
    expect(b.command.value.order.revision).toBe(committed.row.revision + 1);
    const before = await state(order);
    expect(
      await otherCommands.beginCheckoutRefresh({
        orderId: order.id,
        sessionId: order.checkoutSessionId!,
        workflowId: a.command.value.workflowId,
      }),
    ).toEqual({ kind: 'completed' });
    expect(await state(order)).toEqual(before);
    expect(
      (
        await otherCommands.applyClaimedCheckoutSnapshot(
          await stripe.readCheckout(order.checkoutSessionId!),
          b.command.value,
        )
      ).changed,
    ).toBe(false);
  } finally {
    gate.release();
  }
  expect((await applying).changed).toBe(true);
});

test('invalid immutable binding, stable digest, native key length and revision exhaustion leave no claim effects', async () => {
  const { order, session, a } = await paid();
  const before = await state(order);
  for (const input of [
    { orderId: order.id, sessionId: 'cs_foreign', workflowId: entryKey() },
    { orderId: 'invalid', sessionId: session, workflowId: entryKey() },
  ])
    await expect(commands.beginCheckoutRefresh(input)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    commands.beginCheckoutRefresh({ orderId: order.id, sessionId: session, workflowId: 'x'.repeat(250) }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(await state(order)).toEqual(before);
  const other = await checkout();
  const previousOther = await state(other);
  // Same buyer, same partition, same stable key, different order digest: core conflict, no Commerce receipt SQL.
  await expect(
    commands.beginCheckoutRefresh({
      orderId: other.id,
      sessionId: other.checkoutSessionId!,
      workflowId: a.command.value.workflowId,
    }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await state(other)).toEqual(previousOther);
  const claim = (await begin(order)).command.value;
  const bytes = await stripe.readCheckout(session);
  const beforeInvalid = await state(order);
  await expect(
    commands.applyClaimedCheckoutSnapshot({ ...bytes, metadataOrderId: other.id }, claim),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await state(order)).toEqual(beforeInvalid);
  expect(await applyReceipt(claim)).toHaveLength(0);
  // Raw setup is confined to the storage integer boundary, never a positive actor/grant/business fact.
  await f.pool.query('UPDATE commerce.purchase_order SET revision=2147483647 WHERE route=$1 AND order_id=$2', [
    routeOf(other.id),
    other.id,
  ]);
  const exhausted = await state(other);
  await expect(
    commands.beginCheckoutRefresh({ orderId: other.id, sessionId: other.checkoutSessionId!, workflowId: entryKey() }),
  ).rejects.toThrow('Commerce order revision exhausted');
  expect(await state(other)).toEqual(exhausted);
});
