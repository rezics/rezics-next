import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { RELEASE_FORMAT, type Release } from '@rezics/definitions';
import canonicalize from 'canonicalize';
import { Pool, type PoolClient } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import { createCommerceCommands, stepCommandKey } from '../../src/commerce/commands.ts';
import type { CheckoutSnapshot, Order } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { createPersonas, PERSONAS_VERSION, type Persona, type PersonasOptions } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

// Native command safety only: no DBOS routing/cutover, participant completion or retention claim.
setDefaultTimeout(30_000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const servicePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const reader = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  options: '-c default_transaction_read_only=on',
});
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let options: PersonasOptions;
let first: Awaited<ReturnType<typeof createPersonas>>;
let second: typeof first;
let commands: ReturnType<typeof createCommerceCommands>;
let scheduled: typeof commands;
let fake: ReturnType<typeof startFakeStripe>;
let stripe: ReturnType<typeof createStripePort>;
let offerId: string;
let targetSubjectId: string;
const key = () => Bun.randomUUIDv7();
type Trace = { pid: number; tx: number; sql: string; values: unknown[]; code?: string };
const trace: Trace[] = [];
let txSequence = 0;
let failShare = false;
let gate: { orderId: string; beforeAccount: boolean; reached(pid: number): void; wait: Promise<void> } | undefined;
const accountShare = (sql: string) => /FROM access\.account\b[\s\S]*FOR SHARE/i.test(sql);
const orderLock = (sql: string) => /FROM commerce\.purchase_order\b[\s\S]*FOR UPDATE/i.test(sql);
// Commerce needs a real target subject, with no catalogue properties or library profile.
// Keep its native definition input independent of unrelated bundled catalogue validation.
const targetRelease: Release = {
  format: RELEASE_FORMAT,
  catalogue: { id: 'https://kernel.test/terminal-benefit', version: '1' },
  generator: { name: 'terminal-benefit-native-fixture', version: '1' },
  prefixes: { schema: 'http://schema.org/' },
  types: {
    'schema:Book': {
      iri: 'http://schema.org/Book',
      labels: { en: 'Book' },
      mappings: [],
      bases: [],
      properties: [],
      facets: [],
    },
  },
  properties: {},
};

// Scheduling preserves native statements/results. Failure control asks PostgreSQL itself to cancel a
// blocked account read; it never supplies lifecycle truth or an application exception.
servicePool.on('connect', (client: PoolClient) => {
  const query = client.query.bind(client);
  let tx = 0;
  client.query = (async (...args: unknown[]) => {
    const config = args[0] as { text?: string; values?: unknown[] };
    const sql = typeof args[0] === 'string' ? args[0] : (config?.text ?? '');
    const values = (Array.isArray(args[1]) ? args[1] : config?.values) ?? [];
    if (/^BEGIN/i.test(sql)) tx = ++txSequence;
    const row: Trace = { pid: (client as PoolClient & { processID: number }).processID, tx, sql, values };
    if (tx) trace.push(row);
    if (
      tx &&
      gate &&
      ((orderLock(sql) && values.includes(gate.orderId)) || (gate.beforeAccount && accountShare(sql)))
    ) {
      const waiting = gate;
      gate = undefined;
      waiting.reached(row.pid);
      await waiting.wait;
    }
    if (tx && failShare && accountShare(sql)) {
      await query("SET LOCAL lock_timeout = '0'");
      await query("SET LOCAL statement_timeout = '100ms'");
    }
    try {
      return await (query as (...values: unknown[]) => Promise<unknown>)(...args);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== undefined) row.code = code;
      throw error;
    } finally {
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) tx = 0;
    }
  }) as PoolClient['query'];
});

async function request(persona: Persona | null, path: string, body?: unknown) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(persona ? { authorization: `Bearer ${persona.bearer}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function post(persona: Persona, path: string, body: unknown, status = 200) {
  const response = await request(persona, path, body);
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'terminal-benefit-native-rate-secret-32-bytes' }),
  });
  options = { version: PERSONAS_VERSION, pool, auth };
  first = await createPersonas(kernel, options);
  second = await createPersonas(kernel, { ...options, governance: first.staff });
  for (const group of ['purchases', 'selling']) await post(first.staff, `/v1/platform/exposure/${group}:open`, {});
  for (const [resource, actions] of [
    [PLATFORM_RESOURCE, ['offer:create']],
    [{ route: 0, id: GLOBAL_CONTEXT }, ['subject:create']],
  ] as const) {
    await post(
      first.staff,
      '/v1/grants',
      {
        resource,
        subject: { kind: 'account', id: first.staff.accountId },
        actions,
        valid: '(,)',
      },
      201,
    );
  }
  await bootstrapRelease(pool, targetRelease);
  targetSubjectId = (
    await post(
      first.staff,
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Captured terminal benefit book' },
      },
      201,
    )
  ).subject.id;
  commands = createCommerceCommands({ pool, access: kernel.testAccess });
  scheduled = createCommerceCommands({ pool: servicePool, access: kernel.testAccess });
  offerId = (
    await post(
      first.staff,
      '/v1/offers',
      {
        targetSubjectId,
        title: 'Captured price and target',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      201,
    )
  ).offer.id;
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: 'sk_test_terminal_benefit',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
}, 360000);

afterAll(async () => {
  fake?.stop();
  try {
    await auth?.close();
  } finally {
    await Promise.all([pool.end(), servicePool.end(), reader.end()]);
  }
});

async function checkout(buyer: Persona) {
  const actor = await kernel.testAccess.authenticate(buyer.bearer, { pool, deadline: Date.now() + 10000 });
  const order = (await commands.createOrder(actor, offerId, key())).value;
  const session = await stripe.createCheckoutSession(
    {
      orderId: order.id,
      buyerAccountId: buyer.accountId,
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
  return (await commands.readOrderForAccount(buyer.accountId, order.id))!;
}
async function begin(order: Order, executor = commands, workflowId = `wf:${key()}`) {
  const result = await executor.beginCheckoutRefresh({
    orderId: order.id,
    sessionId: order.checkoutSessionId!,
    workflowId,
  });
  if (result.kind !== 'claimed') throw new Error('Expected new physical native claim');
  return result.command.value;
}
type Mode = 'claimed' | 'legacy';
async function prepare(order: Order, mode: Mode, executor = commands) {
  const claim = mode === 'claimed' ? await begin(order, executor) : undefined;
  const workflowId = claim?.workflowId ?? `wf:${key()}`;
  const snapshot = await stripe.readCheckout(order.checkoutSessionId!);
  return {
    claim,
    snapshot,
    workflowId,
    apply: () =>
      claim
        ? executor.applyClaimedCheckoutSnapshot(snapshot, claim)
        : executor.applyCheckoutSnapshot(snapshot, workflowId),
  };
}
async function paid(buyer: Persona) {
  const order = await checkout(buyer);
  fake.pay(order.checkoutSessionId!);
  const attempt = await prepare(order, 'claimed');
  expect((await attempt.apply()).changed).toBe(true);
  return order;
}
async function receipt(order: Order, workflowId: string) {
  return (
    await reader.query(
      `SELECT request_digest,transaction_id,epoch,position,response FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='commerce.checkout.apply' AND idempotency_key=$3`,
      [partitionOf(routeOf(order.id)!), order.buyerAccountId, stepCommandKey(workflowId, 'apply')],
    )
  ).rows;
}
async function state(order: Order) {
  const values = [routeOf(order.id), order.id];
  const row = (
    await reader.query(
      'SELECT revision,settlement,unit_amount_minor,target_subject_id,transaction_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2',
      values,
    )
  ).rows[0];
  const entitlements = (
    await reader.query(
      'SELECT entitlement_id,revision,account_id,offer_id,target_subject_id,revoked_at,revoke_reason,transaction_id FROM commerce.entitlement WHERE route=$1 AND order_id=$2',
      values,
    )
  ).rows;
  const transactions = (
    await reader.query(
      'SELECT balance_transaction_id,kind,amount_minor,fee_minor,net_minor,transaction_id FROM commerce.order_transaction WHERE route=$1 AND order_id=$2 ORDER BY balance_transaction_id',
      values,
    )
  ).rows;
  const events = (
    await reader.query(
      `SELECT id,epoch,position,type,subject,data FROM core.outbox WHERE partition_no=$1
     AND (subject=$2 OR subject=ANY($3::text[])) ORDER BY position,event_seq`,
      [partitionOf(routeOf(order.id)!), order.id, entitlements.map((e) => e.entitlement_id)],
    )
  ).rows;
  const grants = (
    await reader.query(
      'SELECT resource_id,action,valid::text,transaction_id FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[]) AND subject_id=$3 ORDER BY resource_id,action',
      [routeOf(order.id), [order.id, ...entitlements.map((e) => e.entitlement_id)], order.buyerAccountId],
    )
  ).rows;
  return { row, entitlements, transactions, events, grants };
}
async function atomic(order: Order, workflowId: string, snapshot: CheckoutSnapshot) {
  const receipts = await receipt(order, workflowId);
  expect(receipts).toHaveLength(1);
  const r = receipts[0]!;
  expect(Buffer.from(r.request_digest).toString('hex')).toBe(
    createHash('sha256')
      .update(canonicalize({ orderId: order.id })!)
      .digest('hex'),
  );
  const current = await state(order);
  expect(current.row.settlement).toBe('paid');
  expect(current.row.transaction_id).toBe(r.transaction_id);
  expect(current.transactions.map((t) => t.balance_transaction_id).sort()).toEqual(
    snapshot.transactions.map((t) => t.id).sort(),
  );
  expect(
    current.transactions.map((t) => ({
      id: t.balance_transaction_id,
      kind: t.kind,
      amount: Number(t.amount_minor),
      fee: Number(t.fee_minor),
      net: Number(t.net_minor),
    })),
  ).toEqual(
    [...snapshot.transactions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        amount: t.amountMinor,
        fee: t.feeMinor,
        net: t.netMinor,
      })),
  );
  const events = current.events.filter((e) => e.epoch === r.epoch && e.position === r.position);
  expect(events.filter((e) => e.type === 'com.rezics.commerce.order.updated.v1')).toHaveLength(1);
  const named = current.transactions
    .filter((t) => t.transaction_id === r.transaction_id)
    .map((t) => t.balance_transaction_id)
    .sort();
  if (named.length) {
    expect(events.filter((e) => e.type === 'com.rezics.commerce.transactions.recorded.v1')).toHaveLength(1);
    expect(
      events.find((e) => e.type === 'com.rezics.commerce.transactions.recorded.v1')!.data.transactionIds.sort(),
    ).toEqual(named);
  }
  return current;
}
async function fenced(buyer: Persona, order: Order, entitlementId?: string) {
  for (const path of [
    `/v1/orders/${order.id}`,
    '/v1/entitlements',
    ...(entitlementId ? [`/v1/entitlements/${entitlementId}`] : []),
  ]) {
    const old = await request(buyer, path);
    expect(old.status).toBe(401);
    expect(old.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await old.json()).toMatchObject({ code: 'invalid_credentials' });
  }
  for (const viewer of [first.staff, null]) {
    expect((await request(viewer, `/v1/orders/${order.id}`)).status).toBe(404);
    if (entitlementId) expect((await request(viewer, `/v1/entitlements/${entitlementId}`)).status).toBe(404);
  }
}
async function terminal(buyer: Persona) {
  const t = await deletePersona(options, buyer);
  expect(Number.isFinite(Date.parse(t.at))).toBe(true);
  expect(await readErasureStatus(pool, buyer.accountId)).toMatchObject({
    at: t.at,
    state: 'pending',
    participants: { commerce: { outcome: 'pending' } },
  });
  return t;
}
function arm(order: Order, beforeAccount = false) {
  const reached = Promise.withResolvers<number>();
  const released = Promise.withResolvers<void>();
  gate = { orderId: order.id, beforeAccount, reached: reached.resolve, wait: released.promise };
  return { reached: reached.promise, release: released.resolve };
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error('Native row-lock observation did not arrive within 5000ms');
}
function accountBeforeOrder(rows: Trace[], accountId: string) {
  const orders = rows.filter((r) => orderLock(r.sql));
  expect(orders.length).toBeGreaterThan(0);
  for (const row of orders) {
    const prior = rows.slice(0, rows.indexOf(row)).filter((r) => r.tx === row.tx && accountShare(r.sql));
    expect(prior).toHaveLength(1);
    expect(prior.map((r) => r.values).flat()).toContain(accountId);
  }
}

describe('fresh Auth account deletion fences native late paid and refund-reversal benefits while immutable financial service reconciliation and exact receipt replay remain usable', () => {
  test('active buyer: paid grants, full refund revokes and provider refund failure restores the same entitlement exactly once', async () => {
    const order = await checkout(first.alice);
    // The order retains its terms after a real seller price revision.
    const seller = await kernel.testAccess.authenticate(first.staff.bearer, { pool, deadline: Date.now() + 10000 });
    await commands.reviseOffer(seller, offerId, { unitAmountMinor: 1500 }, key());
    try {
      fake.pay(order.checkoutSessionId!);
      const paidApply = await prepare(order, 'claimed');
      expect((await paidApply.apply()).changed).toBe(true);
      const granted = await atomic(order, paidApply.workflowId, paidApply.snapshot);
      expect(granted.entitlements).toHaveLength(1);
      const entitlement = granted.entitlements[0]!;
      expect(entitlement).toMatchObject({
        account_id: first.alice.accountId,
        target_subject_id: targetSubjectId,
        revoked_at: null,
      });
      expect(Number(granted.row.unit_amount_minor)).toBe(1200);
      expect(granted.row.target_subject_id).toBe(targetSubjectId);
      const refund = fake.refund(order.checkoutSessionId!, { amount: 1200 });
      const refundApply = await prepare(order, 'claimed');
      expect((await refundApply.apply()).changed).toBe(true);
      const revoked = await atomic(order, refundApply.workflowId, refundApply.snapshot);
      expect(revoked.entitlements[0]).toMatchObject({
        entitlement_id: entitlement.entitlement_id,
        revoke_reason: 'refund',
      });
      expect(revoked.entitlements[0]!.revoked_at).not.toBeNull();
      fake.failRefund(refund);
      const reversal = await prepare(order, 'claimed');
      expect((await reversal.apply()).changed).toBe(true);
      const restored = await atomic(order, reversal.workflowId, reversal.snapshot);
      expect(restored.entitlements[0]).toMatchObject({
        entitlement_id: entitlement.entitlement_id,
        revoked_at: null,
        revoke_reason: null,
        revision: entitlement.revision + 2,
      });
      expect(restored.transactions.map((t) => t.kind).sort()).toEqual(['charge', 'refund', 'refund_reversal']);
      expect(restored.entitlements[0]!.transaction_id).toBe(restored.row.transaction_id);
      for (const action of ['granted', 'revoked', 'restored'])
        expect(restored.events.filter((e) => e.type === `com.rezics.commerce.entitlement.${action}.v1`)).toHaveLength(
          1,
        );
      const replay = await reversal.apply();
      expect(replay).toMatchObject({ changed: true, replayed: true });
      expect(await state(order)).toEqual(restored);
      expect((await request(first.alice, `/v1/orders/${order.id}`)).status).toBe(200);
      const view = await request(first.alice, `/v1/entitlements/${entitlement.entitlement_id}`);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({ entitlement: { active: true, targetSubjectId, orderId: order.id } });
    } finally {
      await commands.reviseOffer(seller, offerId, { unitAmountMinor: 1200 }, key());
    }
  });

  for (const mode of ['claimed', 'legacy'] as const) {
    test(`fresh Auth T before late first paid ${mode} apply: financial truth commits without an entitlement or private benefit`, async () => {
      const buyer = mode === 'claimed' ? first.bob : first.orgOwner;
      const order = await checkout(buyer);
      fake.pay(order.checkoutSessionId!);
      const attempt = await prepare(order, mode, scheduled);
      const before = await state(order);
      await terminal(buyer);
      await fenced(buyer, order);
      const start = trace.length;
      expect((await attempt.apply()).changed).toBe(true);
      const current = await atomic(order, attempt.workflowId, attempt.snapshot);
      expect(current.events.filter((e) => /entitlement\.(granted|restored)/.test(e.type))).toHaveLength(0);
      expect(current.entitlements).toHaveLength(0);
      expect(current.grants).toEqual(before.grants);
      accountBeforeOrder(trace.slice(start), buyer.accountId);
      expect(await attempt.apply()).toMatchObject({ changed: true, replayed: true });
      expect(await state(order)).toEqual(current);
    });
  }

  for (const blocker of ['refund', 'dispute'] as const) {
    test(`fresh Auth T before ${blocker} reversal: named money reconciles once, revoked entitlement and private relations never restore`, async () => {
      const buyer = blocker === 'refund' ? second.alice : second.bob;
      const order = await paid(buyer);
      const id =
        blocker === 'refund'
          ? fake.refund(order.checkoutSessionId!, { amount: 1200 })
          : fake.dispute(order.checkoutSessionId!);
      const revocation = await prepare(order, 'claimed');
      expect((await revocation.apply()).changed).toBe(true);
      const revoked = await state(order);
      const entitlement = revoked.entitlements[0]!;
      expect(entitlement.revoked_at).not.toBeNull();
      await terminal(buyer);
      if (blocker === 'refund') fake.failRefund(id);
      else fake.updateDispute(id, 'won');
      const reversal = await prepare(order, blocker === 'refund' ? 'legacy' : 'claimed');
      expect((await reversal.apply()).changed).toBe(true);
      const current = await atomic(order, reversal.workflowId, reversal.snapshot);
      expect(current.transactions.filter((t) => t.kind === `${blocker}_reversal`)).toHaveLength(1);
      const later = await begin(order);
      const beforeReplay = await state(order);
      expect(await reversal.apply()).toMatchObject({ changed: true, replayed: true });
      expect(await state(order)).toEqual(beforeReplay);
      expect(
        await commands.beginCheckoutRefresh({
          orderId: order.id,
          sessionId: order.checkoutSessionId!,
          workflowId: reversal.workflowId,
        }),
      ).toEqual({ kind: 'completed' });
      expect(await state(order)).toEqual(beforeReplay);
      await fenced(buyer, order, entitlement.entitlement_id);
      expect(current.entitlements).toEqual(revoked.entitlements);
      expect(current.events.filter((e) => e.type === 'com.rezics.commerce.entitlement.restored.v1')).toHaveLength(0);
      expect(
        await commands.applyClaimedCheckoutSnapshot(await stripe.readCheckout(order.checkoutSessionId!), later),
      ).toEqual({ changed: false });
      expect(await receipt(order, later.workflowId)).toHaveLength(0);
    });
  }

  test('real deletion race: account share acquired first commits the grant before T, and Auth deletion waits for that transaction', async () => {
    const buyer = second.orgOwner;
    const order = await checkout(buyer);
    fake.pay(order.checkoutSessionId!);
    const attempt = await prepare(order, 'claimed', scheduled);
    const start = trace.length;
    const pause = arm(order);
    const applying = attempt.apply();
    let deleting: ReturnType<typeof terminal> | undefined;
    try {
      const pid = await pause.reached;
      accountBeforeOrder(trace.slice(start), buyer.accountId);
      deleting = terminal(buyer);
      await until(
        async () =>
          (
            await reader.query(
              'SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))',
              [pid],
            )
          ).rows,
        (rows) => rows.some((r) => /access\.(account|handle)/i.test(r.query)),
      );
      expect(await receipt(order, attempt.workflowId)).toHaveLength(0);
      pause.release();
      expect((await applying).changed).toBe(true);
      const t = await deleting;
      const committed = await atomic(order, attempt.workflowId, attempt.snapshot);
      expect(committed.entitlements).toHaveLength(1);
      const grant = committed.entitlements[0]!;
      const times = await reader.query(
        'SELECT granted_at <= $3::timestamptz AS before_t FROM commerce.entitlement WHERE route=$1 AND entitlement_id=$2',
        [routeOf(order.id), grant.entitlement_id, t.at],
      );
      expect(times.rows[0]!.before_t).toBe(true);
      await fenced(buyer, order, grant.entitlement_id);
    } finally {
      pause.release();
      gate = undefined;
      await Promise.allSettled([applying, ...(deleting ? [deleting] : [])]);
    }
  });

  test('real deletion race reversed: captured claim/provider bytes precede T, account barrier follows T and grants nothing', async () => {
    const buyer = second.staff;
    const order = await checkout(buyer);
    fake.pay(order.checkoutSessionId!);
    const attempt = await prepare(order, 'claimed', scheduled);
    const start = trace.length;
    const pause = arm(order, true);
    const applying = attempt.apply();
    try {
      await pause.reached;
      // Pause immediately before the real account share (or the unfenced first order lock on base).
      // No order lock or benefit has been acquired at this boundary in a correct implementation.
      await terminal(buyer);
      expect(await receipt(order, attempt.workflowId)).toHaveLength(0);
      expect((await state(order)).entitlements).toHaveLength(0);
      pause.release();
      expect((await applying).changed).toBe(true);
      const current = await atomic(order, attempt.workflowId, attempt.snapshot);
      await fenced(buyer, order);
      accountBeforeOrder(trace.slice(start), buyer.accountId);
      expect(current.entitlements).toHaveLength(0);
    } finally {
      pause.release();
      gate = undefined;
      await Promise.allSettled([applying]);
    }
  });

  test('terminal buyer does not weaken claim CAS: newer no-op still fences old revoking provider bytes without an apply receipt', async () => {
    const buyer = first.delegated;
    const order = await paid(buyer);
    const refund = fake.refund(order.checkoutSessionId!, { amount: 1200 });
    expect((await (await prepare(order, 'claimed')).apply()).changed).toBe(true);
    await terminal(buyer);
    fake.failRefund(refund);
    const reversal = await prepare(order, 'claimed');
    expect((await reversal.apply()).changed).toBe(true);
    const old = await begin(order);
    const dispute = fake.dispute(order.checkoutSessionId!, { withdraw: false });
    const oldBytes = await stripe.readCheckout(order.checkoutSessionId!);
    fake.updateDispute(dispute, 'won');
    const newer = await begin(order);
    expect(
      await commands.applyClaimedCheckoutSnapshot(await stripe.readCheckout(order.checkoutSessionId!), newer),
    ).toEqual({ changed: false });
    const before = await state(order);
    expect(await commands.applyClaimedCheckoutSnapshot(oldBytes, old)).toEqual({ changed: false, superseded: true });
    expect(await state(order)).toEqual(before);
    expect(await receipt(order, old.workflowId)).toHaveLength(0);
    expect(await receipt(order, newer.workflowId)).toHaveLength(0);
  });

  for (const mode of ['claimed', 'legacy'] as const) {
    test(`real account-share database timeout in ${mode} apply is unavailable, not terminal suppression: entire financial apply rolls back and retries`, async () => {
      const order = await checkout(first.alice);
      fake.pay(order.checkoutSessionId!);
      const attempt = await prepare(order, mode, scheduled);
      const before = await state(order);
      const lock = await pool.connect();
      const start = trace.length;
      let result: unknown;
      let failure: unknown;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
          routeOf(first.alice.accountId),
          first.alice.accountId,
        ]);
        failShare = true;
        try {
          result = await attempt.apply();
        } catch (error) {
          failure = error;
        }
      } finally {
        failShare = false;
        await lock.query('ROLLBACK');
        lock.release();
      }
      expect(trace.slice(start).filter((r) => accountShare(r.sql) && r.code === '57014')).toHaveLength(1);
      expect(failure).not.toBeInstanceOf(LifecycleDeniedError);
      expect(failure).toBeInstanceOf(CommandUnavailableError);
      expect(result).toBeUndefined();
      expect(await receipt(order, attempt.workflowId)).toHaveLength(0);
      expect(await state(order)).toEqual(before);
      expect((await attempt.apply()).changed).toBe(true);
      await atomic(order, attempt.workflowId, attempt.snapshot);
    });
  }
});

// Additional physical schedules use the same owned Auth/kernel world and leave the existing cases unchanged.
test('fresh Auth T before legacy service admission still permits late paid accounting without recreating entitlement role grants', async () => {
  const fresh = await createPersonas(kernel, { ...options, governance: first.staff });
  const buyer = fresh.bob;
  const order = await checkout(buyer);
  await terminal(buyer);
  await fenced(buyer, order);
  fake.pay(order.checkoutSessionId!);
  const attempt = await prepare(order, 'legacy', scheduled);
  const start = trace.length;
  expect((await attempt.apply()).changed).toBe(true);
  const current = await atomic(order, attempt.workflowId, attempt.snapshot);
  expect(current.entitlements).toEqual([]);
  expect(current.grants).toEqual([]);
  const roles = await reader.query(
    'SELECT resource_id,grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
    [routeOf(order.id), order.id, buyer.accountId],
  );
  expect(roles.rows).toEqual([]);
  expect(current.events.filter((e) => /entitlement\.(granted|restored)/.test(e.type))).toEqual([]);
  accountBeforeOrder(trace.slice(start), buyer.accountId);
  const originalReceipt = await receipt(order, attempt.workflowId);
  const later = await begin(order);
  const admitted = await state(order);
  expect(admitted.row.revision).toBe(current.row.revision + 1);
  expect(await attempt.apply()).toMatchObject({ changed: true, replayed: true });
  expect(await receipt(order, attempt.workflowId)).toEqual(originalReceipt);
  expect(await state(order)).toEqual(admitted);
  expect(
    await commands.applyClaimedCheckoutSnapshot(await stripe.readCheckout(order.checkoutSessionId!), later),
  ).toEqual({ changed: false });
  expect(await receipt(order, later.workflowId)).toEqual([]);
});

test('real deletion race reversed for restoration: refund-failure bytes and claim precede Auth T, account barrier follows T and only money reconciles', async () => {
  const fresh = await createPersonas(kernel, { ...options, governance: first.staff });
  const buyer = fresh.bob;
  const order = await paid(buyer);
  const refund = fake.refund(order.checkoutSessionId!, { amount: 1200 });
  expect((await (await prepare(order, 'claimed')).apply()).changed).toBe(true);
  const revoked = await state(order);
  const entitlement = revoked.entitlements[0]!;
  expect(entitlement.revoked_at).not.toBeNull();
  fake.failRefund(refund);
  const attempt = await prepare(order, 'claimed', scheduled);
  const start = trace.length;
  const pause = arm(order, true);
  const applying = attempt.apply();
  try {
    await pause.reached;
    await terminal(buyer);
    expect(await receipt(order, attempt.workflowId)).toEqual([]);
    expect((await state(order)).entitlements).toEqual(revoked.entitlements);
    pause.release();
    expect((await applying).changed).toBe(true);
    const current = await atomic(order, attempt.workflowId, attempt.snapshot);
    expect(current.transactions.filter((t) => t.kind === 'refund_reversal')).toHaveLength(1);
    expect(current.entitlements).toEqual(revoked.entitlements);
    expect(current.grants).toEqual(revoked.grants);
    expect(current.events.filter((e) => e.type === 'com.rezics.commerce.entitlement.restored.v1')).toEqual([]);
    const roles = await reader.query(
      'SELECT resource_id,subject_id,grant_role,transaction_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
      [routeOf(order.id), entitlement.entitlement_id],
    );
    expect(roles.rows).toEqual([]);
    accountBeforeOrder(trace.slice(start), buyer.accountId);
    await fenced(buyer, order, entitlement.entitlement_id);
    expect(await attempt.apply()).toMatchObject({ changed: true, replayed: true });
    expect(await state(order)).toEqual(current);
  } finally {
    pause.release();
    gate = undefined;
    await Promise.allSettled([applying]);
  }
});

test('account-share availability failure has an actual pg_blocking_pids witness and no committed financial receipt or partial effects', async () => {
  const fresh = await createPersonas(kernel, { ...options, governance: first.staff });
  const order = await checkout(fresh.bob);
  fake.pay(order.checkoutSessionId!);
  const attempt = await prepare(order, 'claimed', scheduled);
  const before = await state(order);
  const control = await pool.connect();
  const start = trace.length;
  let applying: Promise<void> | undefined;
  let failure: unknown;
  let result: unknown;
  let settled = false;
  let witnesses: Array<{ pid: number; query: string; blockers: number[] }> = [];
  try {
    await control.query('BEGIN');
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    // Scheduling only: the account row and all lifecycle facts remain unchanged.
    await control.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
      routeOf(fresh.bob.accountId),
      fresh.bob.accountId,
    ]);
    failShare = true;
    applying = attempt.apply().then(
      (value) => {
        result = value;
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      },
    );
    await until(
      async () => {
        witnesses = (
          await reader.query<{ pid: number; query: string; blockers: number[] }>(
            `SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
         WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`,
            [pid],
          )
        ).rows;
        return witnesses.length > 0 || settled;
      },
      (done) => done,
    );
    await applying;
  } finally {
    failShare = false;
    await control.query('ROLLBACK');
    control.release();
    if (applying) await applying;
  }
  expect(witnesses.some((row) => accountShare(row.query) && row.blockers.length > 0)).toBe(true);
  expect(trace.slice(start).some((row) => accountShare(row.sql) && row.code === '57014')).toBe(true);
  expect(failure).toBeInstanceOf(CommandUnavailableError);
  expect(failure).not.toBeInstanceOf(LifecycleDeniedError);
  expect(result).toBeUndefined();
  expect(await receipt(order, attempt.workflowId)).toEqual([]);
  expect(await state(order)).toEqual(before);
  expect((await attempt.apply()).changed).toBe(true);
  await atomic(order, attempt.workflowId, attempt.snapshot);
});
