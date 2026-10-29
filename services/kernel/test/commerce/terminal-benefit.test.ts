import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Pool, type PoolClient } from 'pg';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest } from '@rezics/definitions';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import { createCommerceCommands, stepCommandKey, type CheckoutRefreshClaim } from '../../src/commerce/commands.ts';
import type { CheckoutSnapshot, Order } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { createPersonas, type Persona, type PersonasOptions } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

// Native service safety only: no DBOS routing, participant completion or retention exemption is inferred.
setDefaultTimeout(30_000);
const pool = createPool(process.env.DATABASE_URL!);
const servicePool = createPool(process.env.DATABASE_URL!);
const reader = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on' });
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let options: PersonasOptions;
let commands: ReturnType<typeof createCommerceCommands>;
let native: ReturnType<typeof createCommerceCommands>;
let fake: ReturnType<typeof startFakeStripe>;
let stripe: ReturnType<typeof createStripePort>;
let target: string;
const key = () => crypto.randomUUID();
const shares = /FROM access\.account\b[\s\S]*FOR SHARE/i;
const orderLock = /FROM commerce\.purchase_order\b[\s\S]*FOR UPDATE/i;
type Trace = { sql: string; values: unknown[]; pid: number; error?: string };
const trace: Trace[] = [];
const live = new Set<number>();
let boundedShareFailure = false;
let gate: { matches(sql: string): boolean; entered(row: Trace): void; wait: Promise<void> } | undefined;

function arm(matches: (sql: string) => boolean) {
  const entered = Promise.withResolvers<Trace>();
  const released = Promise.withResolvers<void>();
  gate = { matches, entered: entered.resolve, wait: released.promise };
  return { entered: entered.promise, release: released.resolve };
}

// Scheduling/observation of real SQL only. No terminal callbacks, fabricated errors or replacement query results.
servicePool.on('connect', (client: PoolClient) => {
  const query = client.query.bind(client);
  let pid = 0;
  let transaction = false;
  client.query = (async (...args: unknown[]) => {
    const config = args[0] as { text?: string; values?: unknown[] };
    const sql = typeof args[0] === 'string' ? args[0] : (config.text ?? '');
    const values = (Array.isArray(args[1]) ? args[1] : config.values) ?? [];
    if (/^BEGIN/i.test(sql)) {
      pid ||= (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      transaction = true;
      live.add(pid);
    }
    const row: Trace = { sql, values, pid };
    if (transaction) trace.push(row);
    if (transaction && gate?.matches(sql)) {
      const parked = gate;
      gate = undefined;
      parked.entered(row);
      await parked.wait;
    }
    try {
      // A shorter real server deadline bounds the deliberately blocked account-share query.
      if (transaction && boundedShareFailure && shares.test(sql)) await query("SET LOCAL statement_timeout = '150ms'");
      return await (query as (...args: unknown[]) => Promise<unknown>)(...args);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code) row.error = code;
      throw error;
    } finally {
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
        live.delete(pid);
        transaction = false;
      }
    }
  }) as PoolClient['query'];
});

async function request(persona: Persona | null, method: string, path: string, body?: unknown) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${persona.bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function post(path: string, body: unknown, status = 201) {
  const response = await request(personas.staff, 'POST', path, body);
  if (response.status !== status) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'terminal-benefit-native-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  options = { version: 1, pool, auth };
  personas = await createPersonas(kernel, options);
  commands = createCommerceCommands({ pool, access: kernel.testAccess });
  native = createCommerceCommands({ pool: servicePool, access: kernel.testAccess });
  for (const group of ['selling', 'purchases']) await post(`/v1/platform/exposure/${group}:open`, {}, 200);
  await post('/v1/grants', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: personas.staff.accountId },
    actions: ['offer:create', 'definitions:publish', 'definitions:activate', 'subject:create'],
    valid: '(,)',
  });
  const release = await compileCatalogue(fixture());
  const digest = releaseDigest(release);
  await post('/v1/definitions/releases', { release });
  const head = await request(personas.staff, 'GET', '/v1/definitions/active');
  await post(
    `/v1/definitions/releases/${digest}:activate`,
    {
      expected_head: head.status === 404 ? null : (await head.json()).head,
    },
    200,
  );
  target = (await post('/v1/subjects', { type: 'ex:Child', labels: { en: 'Captured terminal benefit' } })).subject.id;
  const projection = linkProjection(pool);
  for (const partition of new Set([0, partitionOf(routeOf(target)!)])) {
    for (let step = 0; step < 20; step++) {
      const result = await projection.run(partition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 19) throw new Error('Native subject link projection did not drain');
    }
  }
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

async function checkout() {
  // Each independent case owns a fresh ordinary Auth buyer; the same Auth/kernel world is reused.
  const fresh = await createPersonas(kernel, { ...options, governance: personas.staff });
  const buyer = fresh.bob;
  const seller = await kernel.testAccess.authenticate(personas.staff.bearer, { pool, deadline: Date.now() + 10000 });
  const offer = (
    await commands.createOffer(
      seller,
      {
        targetSubjectId: target,
        title: 'Captured terminal benefit',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      key(),
    )
  ).value;
  const actor = await kernel.testAccess.authenticate(buyer.bearer, { pool, deadline: Date.now() + 10000 });
  const order = (await commands.createOrder(actor, offer.id, key())).value;
  expect(live.size).toBe(0);
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
  await native.recordCheckout(order.id, { session });
  return {
    buyer,
    offer,
    seller,
    order: (await native.readOrderForAccount(buyer.accountId, order.id))!,
    session: session.id,
  };
}
async function begin(order: Order, workflowId = `wf:${key()}`) {
  const result = await native.beginCheckoutRefresh({
    orderId: order.id,
    sessionId: order.checkoutSessionId!,
    workflowId,
  });
  if (result.kind !== 'claimed') throw new Error('Fresh native admission must claim');
  return result.command.value;
}
async function bytes(session: string) {
  expect(live.size).toBe(0); // Official SDK I/O must run outside the native transaction.
  return stripe.readCheckout(session);
}
async function refresh(order: Order) {
  const claim = await begin(order);
  const snapshot = await bytes(order.checkoutSessionId!);
  const applied = await native.applyClaimedCheckoutSnapshot(snapshot, claim);
  return { claim, snapshot, applied };
}
async function receipt(order: Order, workflowId: string) {
  return (
    await reader.query(
      `SELECT request_digest, transaction_id, epoch, position, response FROM core.receipt
    WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
      AND command_kind='commerce.checkout.apply' AND idempotency_key=$3`,
      [partitionOf(routeOf(order.id)!), order.buyerAccountId, stepCommandKey(workflowId, 'apply')],
    )
  ).rows;
}
async function state(order: Order) {
  const keys = [routeOf(order.id), order.id];
  const row = (
    await reader.query(
      `SELECT revision, settlement, transaction_id, unit_amount_minor::text,
    target_subject_id::text FROM commerce.purchase_order WHERE route=$1 AND order_id=$2`,
      keys,
    )
  ).rows[0];
  const entitlements = (
    await reader.query(
      `SELECT entitlement_id::text, revision, revoked_at::text, revoke_reason,
    account_id::text, target_subject_id::text, transaction_id FROM commerce.entitlement
    WHERE route=$1 AND order_id=$2 ORDER BY entitlement_id`,
      keys,
    )
  ).rows;
  const transactions = (
    await reader.query(
      `SELECT balance_transaction_id, kind, amount_minor::text, transaction_id
    FROM commerce.order_transaction WHERE route=$1 AND order_id=$2 ORDER BY balance_transaction_id`,
      keys,
    )
  ).rows;
  const ids = [order.id, ...entitlements.map((e) => e.entitlement_id)];
  const events = (
    await reader.query(
      `SELECT epoch, position, event_seq, type, subject, data FROM core.outbox
    WHERE partition_no=$1 AND subject=ANY($2::text[]) ORDER BY position,event_seq`,
      [partitionOf(routeOf(order.id)!), ids],
    )
  ).rows;
  const grants = (
    await reader.query(
      `SELECT resource_id::text, subject_id::text, action, transaction_id
    FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[])
    ORDER BY resource_id,subject_id,action`,
      [routeOf(order.id), ids],
    )
  ).rows;
  const roles = (
    await reader.query(
      `SELECT resource_id::text, subject_id::text, grant_role, transaction_id
    FROM access.resource_role_grant WHERE route=$1 AND resource_id=ANY($2::uuid[])
    ORDER BY resource_id,subject_id,grant_role`,
      [routeOf(order.id), ids],
    )
  ).rows;
  return { row, entitlements, transactions, events, grants, roles };
}
async function atomic(
  order: Order,
  workflowId: string,
  snapshot: CheckoutSnapshot,
  benefit: 'granted' | 'revoked' | 'restored' | null,
) {
  const saved = await receipt(order, workflowId);
  expect(saved).toHaveLength(1);
  const r = saved[0]!;
  expect(Buffer.from(r.request_digest)).toEqual(
    createHash('sha256')
      .update(canonicalize({ orderId: order.id })!)
      .digest(),
  );
  const after = await state(order);
  expect(after.row.transaction_id).toBe(r.transaction_id);
  const events = after.events.filter((e) => e.epoch === r.epoch && e.position === r.position);
  expect(events.filter((e) => e.type === 'com.rezics.commerce.order.updated.v1')).toHaveLength(1);
  const named = after.transactions.filter((t) => t.transaction_id === r.transaction_id);
  expect(named.length).toBeGreaterThan(0);
  expect(named.map((t) => t.balance_transaction_id).sort()).toEqual(
    events
      .find((e) => e.type === 'com.rezics.commerce.transactions.recorded.v1')!
      .data.transactionIds.slice()
      .sort(),
  );
  expect(after.transactions.map((t) => t.balance_transaction_id)).toEqual(
    snapshot.transactions.map((t) => t.id).sort(),
  );
  const benefits = events.filter((e) => e.type.startsWith('com.rezics.commerce.entitlement.'));
  expect(benefits.map((e) => e.type)).toEqual(benefit ? [`com.rezics.commerce.entitlement.${benefit}.v1`] : []);
  return after;
}
async function fenced(buyer: Persona, order: Order, entitlementId?: string) {
  for (const path of [
    `/v1/orders/${order.id}`,
    '/v1/entitlements',
    ...(entitlementId ? [`/v1/entitlements/${entitlementId}`] : []),
  ]) {
    const response = await request(buyer, 'GET', path);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await response.json()).toMatchObject({
      type: 'https://rezics.com/problems/invalid_credentials',
      status: 401,
    });
  }
}
async function concealed(order: Order, entitlementId?: string) {
  for (const viewer of [personas.alice, null]) {
    for (const path of [`/v1/orders/${order.id}`, ...(entitlementId ? [`/v1/entitlements/${entitlementId}`] : [])]) {
      const response = await request(viewer, 'GET', path);
      expect(response.status).toBe(viewer ? 404 : 401);
      expect(await response.json()).toMatchObject({
        type: `https://rezics.com/problems/${viewer ? 'not_found' : 'authentication_required'}`,
      });
    }
  }
}
async function deleted(buyer: Persona) {
  const t = await deletePersona(options, buyer);
  const status = await readErasureStatus(reader, buyer.accountId);
  expect(status).toMatchObject({ at: t.at, version: 1, state: 'pending', completedAt: null });
  expect(status!.participants.commerce.outcome).toBe('pending');
  return t;
}
async function blocking(blocker: number, done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done() && Date.now() < deadline) {
    const result = await reader.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`,
      [blocker],
    );
    if (result.rows.length) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return [];
}

test('active buyer: paid grants, full refund revokes and provider refund failure restores the same entitlement exactly once', async () => {
  const c = await checkout();
  await commands.reviseOffer(c.seller, c.offer.id, { unitAmountMinor: 9900 }, key());
  await commands.delistOffer(c.seller, c.offer.id, key());
  fake.pay(c.session);
  const paid = await refresh(c.order);
  expect(paid.applied.changed).toBe(true);
  expect(paid.snapshot).toMatchObject({ amountSubtotalMinor: 1200, currency: 'usd', clientReferenceId: c.order.id });
  const granted = await atomic(c.order, paid.claim.workflowId, paid.snapshot, 'granted');
  expect(granted.row).toMatchObject({ settlement: 'paid', unit_amount_minor: '1200', target_subject_id: target });
  expect(granted.entitlements).toHaveLength(1);
  const id = granted.entitlements[0]!.entitlement_id;
  const orderRead = await request(c.buyer, 'GET', `/v1/orders/${c.order.id}`);
  expect(orderRead.status).toBe(200);
  expect((await orderRead.json()).order).toMatchObject({
    title: c.order.title,
    targetSubjectId: target,
    entitlementId: id,
    settlement: 'paid',
  });
  const refund = fake.refund(c.session, { amount: 1200 });
  const revoked = await refresh(c.order);
  const revokedState = await atomic(c.order, revoked.claim.workflowId, revoked.snapshot, 'revoked');
  expect(revokedState.entitlements[0]).toMatchObject({ entitlement_id: id, revoke_reason: 'refund' });
  expect(revokedState.entitlements[0]!.revoked_at).not.toBeNull();
  fake.failRefund(refund);
  const reversal = await refresh(c.order);
  const restored = await atomic(c.order, reversal.claim.workflowId, reversal.snapshot, 'restored');
  expect(restored.entitlements).toHaveLength(1);
  expect(restored.entitlements[0]).toMatchObject({ entitlement_id: id, revision: 3, revoked_at: null });
  expect(restored.transactions.map((t) => t.kind).sort()).toEqual(['charge', 'refund', 'refund_reversal']);
  const replay = await native.applyClaimedCheckoutSnapshot(reversal.snapshot, reversal.claim);
  expect(replay).toEqual(reversal.applied);
  expect(await state(c.order)).toEqual(restored);
  const entitlementRead = await request(c.buyer, 'GET', `/v1/entitlements/${id}`);
  expect(entitlementRead.status).toBe(200);
  expect((await entitlementRead.json()).entitlement).toMatchObject({ id, active: true, targetSubjectId: target });
  const list = await request(c.buyer, 'GET', '/v1/entitlements');
  expect(list.status).toBe(200);
  expect((await list.json()).entitlements.map((e: { id: string }) => e.id)).toEqual([id]);
  await concealed(c.order, id);
});

for (const path of ['claimed', 'legacy'] as const) {
  test(`fresh Auth deletion T before late first paid ${path} apply keeps financial truth without any buyer benefit`, async () => {
    const c = await checkout();
    const t = await deleted(c.buyer);
    expect(t.accountId).toBe(c.buyer.accountId);
    await fenced(c.buyer, c.order);
    await concealed(c.order);
    fake.pay(c.session);
    const claim = await begin(c.order);
    const snapshot = await bytes(c.session);
    const apply = () =>
      path === 'claimed'
        ? native.applyClaimedCheckoutSnapshot(snapshot, claim)
        : native.applyCheckoutSnapshot(snapshot, claim.workflowId);
    const applied = await apply();
    expect(applied.changed).toBe(true);
    const after = await atomic(c.order, claim.workflowId, snapshot, null);
    expect(after.row.settlement).toBe('paid');
    expect(after.entitlements).toEqual([]);
    expect(after.grants).toEqual([]);
    expect(after.roles).toEqual([]);
    expect(await apply()).toEqual(applied);
    expect(await state(c.order)).toEqual(after);
    expect(
      await native.beginCheckoutRefresh({ orderId: c.order.id, sessionId: c.session, workflowId: claim.workflowId }),
    ).toEqual({ kind: 'completed' });
    expect(await state(c.order)).toEqual(after);
    await fenced(c.buyer, c.order);
  });
}

for (const cause of ['refund', 'dispute'] as const) {
  test(`fresh Auth deletion T fences existing revoked entitlement during provider ${cause} reversal and stable receipt replay after a later claim`, async () => {
    const c = await checkout();
    fake.pay(c.session);
    await refresh(c.order);
    const providerId = cause === 'refund' ? fake.refund(c.session, { amount: 1200 }) : fake.dispute(c.session);
    await refresh(c.order);
    const before = await state(c.order);
    const entitlement = before.entitlements[0]!;
    expect(entitlement.revoke_reason).toBe(cause);
    expect(entitlement.revoked_at).not.toBeNull();
    await deleted(c.buyer);
    await fenced(c.buyer, c.order, entitlement.entitlement_id);
    await concealed(c.order, entitlement.entitlement_id);
    if (cause === 'refund') fake.failRefund(providerId);
    else fake.updateDispute(providerId, 'won');
    const reversal = await refresh(c.order);
    expect(reversal.applied.changed).toBe(true);
    const after = await atomic(c.order, reversal.claim.workflowId, reversal.snapshot, null);
    expect(after.row.settlement).toBe('paid');
    expect(after.transactions.map((t) => t.kind).sort()).toEqual(['charge', cause, `${cause}_reversal`].sort());
    expect(after.entitlements).toEqual(before.entitlements);
    expect(after.grants).toEqual(before.grants);
    expect(after.roles).toEqual(before.roles);
    const later = await begin(c.order);
    const laterBytes = await bytes(c.session);
    const admitted = await state(c.order);
    expect(admitted.row.revision).toBe(after.row.revision + 1);
    expect(await native.applyClaimedCheckoutSnapshot(reversal.snapshot, reversal.claim)).toEqual(reversal.applied);
    expect(await state(c.order)).toEqual(admitted);
    expect(await receipt(c.order, reversal.claim.workflowId)).toHaveLength(1);
    expect(await receipt(c.order, later.workflowId)).toHaveLength(0);
    expect(await native.applyClaimedCheckoutSnapshot(laterBytes, later)).toEqual({ changed: false });
    expect(await state(c.order)).toEqual(admitted);
  });
}

test('apply holding the real account share barrier first commits its grant before actual Auth deletion T, which waits and then fences HTTP', async () => {
  const c = await checkout();
  fake.pay(c.session);
  const claim = await begin(c.order);
  const snapshot = await bytes(c.session);
  const start = trace.length;
  const parked = arm((sql) => orderLock.test(sql));
  const applying = native.applyClaimedCheckoutSnapshot(snapshot, claim);
  let deleting: ReturnType<typeof deleted> | undefined;
  try {
    const lock = await parked.entered;
    const preceding = trace.slice(start, trace.indexOf(lock));
    expect(preceding.some((r) => r.pid === lock.pid && shares.test(r.sql) && !r.error)).toBe(true);
    expect(preceding.some((r) => orderLock.test(r.sql))).toBe(false);
    let done = false;
    deleting = deleted(c.buyer);
    void deleting.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    const blocked = await blocking(lock.pid, () => done);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((r) => r.blockers.includes(lock.pid))).toBe(true);
    expect(await readErasureStatus(reader, c.buyer.accountId)).toBeNull();
    expect(await receipt(c.order, claim.workflowId)).toHaveLength(0);
  } finally {
    parked.release();
    await applying;
    if (deleting) await deleting;
  }
  const after = await atomic(c.order, claim.workflowId, snapshot, 'granted');
  expect(after.entitlements).toHaveLength(1);
  expect(await readErasureStatus(reader, c.buyer.accountId)).not.toBeNull();
  await fenced(c.buyer, c.order, after.entitlements[0]!.entitlement_id);
});

for (const benefit of ['grant', 'restore'] as const) {
  test(`actual Auth deletion T wins before the apply account barrier after claim and provider capture; financial apply commits without ${benefit}`, async () => {
    const c = await checkout();
    fake.pay(c.session);
    let before: Awaited<ReturnType<typeof state>> | undefined;
    if (benefit === 'restore') {
      await refresh(c.order);
      const refund = fake.refund(c.session, { amount: 1200 });
      await refresh(c.order);
      before = await state(c.order);
      fake.failRefund(refund);
    }
    const claim = await begin(c.order);
    const snapshot = await bytes(c.session);
    // Park at the first lock, including service authorization; an order-first implementation is not excused.
    const parked = arm((sql) => shares.test(sql) || orderLock.test(sql));
    const applying = native.applyClaimedCheckoutSnapshot(snapshot, claim);
    let applied: Awaited<typeof applying> | undefined;
    try {
      await parked.entered;
      await deleted(c.buyer);
      expect(await receipt(c.order, claim.workflowId)).toHaveLength(0);
    } finally {
      parked.release();
      applied = await applying;
    }
    expect(applied!.changed).toBe(true);
    const after = await atomic(c.order, claim.workflowId, snapshot, null);
    expect(after.row.settlement).toBe('paid');
    expect(after.entitlements).toEqual(before?.entitlements ?? []);
    expect(after.grants).toEqual(before?.grants ?? []);
    expect(after.roles).toEqual(before?.roles ?? []);
    await fenced(c.buyer, c.order, before?.entitlements[0]?.entitlement_id);
  });
}

test('terminal suppression preserves the native claim CAS: a newer no-op still fences older paid provider bytes', async () => {
  const c = await checkout();
  const old = await begin(c.order);
  fake.pay(c.session);
  const oldPaid = await bytes(c.session);
  const refund = fake.refund(c.session, { amount: 1200 });
  const newer = await begin(c.order);
  const newBytes = await bytes(c.session);
  await deleted(c.buyer);
  // First paid+fully refunded observation has accounting, but no benefit; the next physical read is a no-op.
  expect((await native.applyClaimedCheckoutSnapshot(newBytes, newer)).changed).toBe(true);
  const noop = await begin(c.order);
  expect(await native.applyClaimedCheckoutSnapshot(await bytes(c.session), noop)).toEqual({ changed: false });
  const before = await state(c.order);
  expect(await native.applyClaimedCheckoutSnapshot(oldPaid, old)).toEqual({ changed: false, superseded: true });
  expect(await state(c.order)).toEqual(before);
  expect(await receipt(c.order, old.workflowId)).toHaveLength(0);
  expect(await receipt(c.order, noop.workflowId)).toHaveLength(0);
  fake.failRefund(refund);
  const reversal = await refresh(c.order);
  const after = await atomic(c.order, reversal.claim.workflowId, reversal.snapshot, null);
  expect(after.entitlements).toEqual([]);
});

test('real account-share database timeout is unavailable, not LifecycleDeniedError: the entire financial apply rolls back and the same claim can retry', async () => {
  const c = await checkout();
  fake.pay(c.session);
  const claim = await begin(c.order);
  const snapshot = await bytes(c.session);
  const before = await state(c.order);
  const control = await pool.connect();
  let failure: unknown;
  let blocked: Awaited<ReturnType<typeof blocking>> = [];
  const start = trace.length;
  try {
    await control.query('BEGIN');
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // A lock only: no positive fixture data or lifecycle truth is written.
    await control.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
      routeOf(c.buyer.accountId),
      c.buyer.accountId,
    ]);
    boundedShareFailure = true;
    let done = false;
    const applying = native.applyClaimedCheckoutSnapshot(snapshot, claim).then(
      () => {
        done = true;
      },
      (error: unknown) => {
        failure = error;
        done = true;
      },
    );
    blocked = await blocking(pid, () => done);
    await applying;
  } finally {
    boundedShareFailure = false;
    await control.query('ROLLBACK');
    control.release();
  }
  expect(failure).toBeInstanceOf(CommandUnavailableError);
  expect(failure).not.toBeInstanceOf(LifecycleDeniedError);
  expect(blocked.length).toBeGreaterThan(0);
  expect(trace.slice(start).some((r) => shares.test(r.sql) && r.error === '57014')).toBe(true);
  expect(await receipt(c.order, claim.workflowId)).toHaveLength(0);
  expect(await state(c.order)).toEqual(before);
  const retry = await native.applyClaimedCheckoutSnapshot(snapshot, claim);
  expect(retry.changed).toBe(true);
  expect((await atomic(c.order, claim.workflowId, snapshot, 'granted')).entitlements).toHaveLength(1);
});
