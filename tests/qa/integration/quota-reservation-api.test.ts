import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { QUOTA_ACTION, QUOTA_SCOPE, QuotaStore } from '../../../services/main/src/modules/quota/store.ts';
import type { CommerceRouteDependencies } from '../../../services/main/src/routes/commerce.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

// SUB04 through the real Main route and a cloned Access PostgreSQL owner.
// Only Account token verification is replaced by fixture bearers.
const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://account.rezics.test';
const iri = () => `https://rezics.com/id/${randomUUID()}`;

let pool: Pool;
let close: () => Promise<void>;
let app: ReturnType<typeof createMainApp>;
let quota: QuotaStore;
let statements = 0;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  close = databases.close;
  pool = new Pool({ connectionString: databases.urls.access, max: 12 });
  pool.on('connect', client => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      statements++;
      return query(...args);
    };
  });
  quota = new QuotaStore(pool);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const deps = {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(root, '.temp', `quota-api-${randomUUID()}`) },
    account: { verify: async (request: Request, scopes: readonly string[]) => {
      const [subject, granted] = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('|');
      if (!subject || !scopes.every(scope => (granted ?? '').split(',').includes(scope))) {
        throw new AccountAssertionDenied('fixture bearer lacks scope');
      }
      return { issuer, subject };
    } },
    access: new AccessAdmissionRegistry(pool),
    quota,
  } satisfies MainWorkDependencies & CommerceRouteDependencies;
  app = createMainApp(fuseki, deps);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await close?.();
}, 60_000);

async function person() {
  const principalId = randomUUID();
  const subject = `quota-${principalId}`;
  const agent = iri();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principalId, issuer, subject]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [agent]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, agent, QUOTA_ACTION]);
  return { principalId, subject, agent, bearer: `Bearer ${subject}|${QUOTA_SCOPE}` };
}

/** Installation-provisioned Realm quota policy. */
async function policy(realm: string, unit: string, options: { base: number; max?: number; ttl?: string;
  failure?: 'release' | 'retain' }) {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO quota.policy (id, scope, unit, head_revision) VALUES ($1, $2, $3, 1)',
      [id, realm, unit]);
    await client.query(`INSERT INTO quota.policy_revision (policy_id, revision, period, base_allowance,
        max_reservation, reservation_ttl, failure_policy) VALUES ($1, 1, 'P1D', $2, $3, $4::interval, $5)`,
    [id, options.base, options.max ?? 5, options.ttl ?? '5 minutes', options.failure ?? 'release']);
    await client.query('COMMIT');
  } finally { client.release(); }
  return id;
}

/** Owner fixture: a purchase or gift entitlement funding quota in the seller Realm. */
async function entitlement(realm: string, beneficiary: string, source: 'purchase' | 'gift', unit: string,
  amount: number) {
  const offering = randomUUID();
  const entitlementId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1, $2, 'person', 1)`, [offering, realm]);
    await client.query(`INSERT INTO commerce.offering_revision (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1, 1, 'open', repeat('a', 64))`, [offering]);
    await client.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics)
      VALUES ($1, 'pro', 'parallel')`, [offering]);
    await client.query(`INSERT INTO commerce.plan (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1, 1, 'pro', 'pro', 0)`, [offering]);
    await client.query(`INSERT INTO commerce.price (offering_id, offering_revision, plan_key, price_key, currency,
      amount_minor, billing_period) VALUES ($1, 1, 'pro', 'monthly', 'USD', 0, 'P1M')`, [offering]);
    await client.query(`INSERT INTO commerce.plan_benefit (offering_id, offering_revision, plan_key, benefit_key,
      level, quota_unit, quota_amount) VALUES ($1, 1, 'pro', 'pro.reply', 1, $2, $3)`, [offering, unit, amount]);
    let subscription: string | null = null;
    let awardIssuer: string | null = null;
    if (source === 'purchase') {
      subscription = randomUUID();
      const payer = randomUUID();
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
        [payer, issuer, `payer-${payer}`]);
      await client.query('INSERT INTO commerce.payment_provider (id, kind, callback_key_reference) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        ['fake', 'fake', 'test:fake']);
      await client.query(`INSERT INTO commerce.subscription (id, principal_id, beneficiary, offering_id, group_key,
        group_semantics, offering_revision, plan_key, price_key, state, generation, provider)
        VALUES ($1, $2, $3, $4, 'pro', 'parallel', 1, 'pro', 'monthly', 'pending', 1, 'fake')`,
      [subscription, payer, beneficiary, offering]);
    } else {
      awardIssuer = iri();
      await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')`, [awardIssuer]);
    }
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, subscription_id, award_issuer, award_reason, valid_from, valid_until, state, generation)
      VALUES ($1, $2, $3, $4, 1, 'pro', $5, $6, $7, now() - interval '1 minute', now() + interval '1 day', 'active', 1)`,
    [entitlementId, beneficiary, source, offering, subscription, awardIssuer, awardIssuer ? 'fixture' : null]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state, valid_until)
      SELECT id, 1, 'grant', 'active', valid_until FROM commerce.entitlement WHERE id = $1`, [entitlementId]);
    await client.query('COMMIT');
  } finally { client.release(); }
  return entitlementId;
}

async function reservation(who: { bearer: string; agent: string }, realm: string, body: Record<string, unknown>) {
  const response = await app.handle(new Request(`http://main.local/v1/realms/${encodeURIComponent(realm)}/quota-reservations`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: who.bearer },
    body: JSON.stringify({ profile: 'realm-quota-reservation-v1', beneficiary: who.agent, stage: 0, ...body }) }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function ledgers(beneficiary: string) {
  return (await pool.query<{ source: string; capacity: string; reserved: string; consumed: string; open: boolean }>(`
    SELECT source, capacity, reserved, consumed, open FROM quota.ledger WHERE beneficiary = $1
    ORDER BY source, capacity`, [beneficiary])).rows;
}

test('SUB04: concurrent requests for the last capacity admit exactly one reservation', async () => {
  const realm = iri();
  const member = await person();
  await policy(realm, 'reply.publish', { base: 1 });
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => reservation(member, realm,
    { unit: 'reply.publish', operationId: `race-${index}`, action: 'reserve', amount: '1' })));
  const admitted = attempts.filter(attempt => attempt.status === 200);
  expect(admitted).toHaveLength(1);
  expect(attempts.filter(attempt => attempt.status === 409).map(attempt => attempt.body.code))
    .toEqual(Array(7).fill('quota_exhausted'));
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '1', reserved: '1', consumed: '0', open: true }]);
  // A retry of the admitted operation reuses its reservation; a changed intent conflicts.
  const winner = admitted[0]!.body;
  const retry = await reservation(member, realm, { unit: 'reply.publish', operationId: winner.operationId,
    action: 'reserve', amount: '1' });
  expect(retry.body).toMatchObject({ reservationId: winner.reservationId, replayed: true });
  const changed = await reservation(member, realm, { unit: 'reply.publish', operationId: winner.operationId,
    action: 'reserve', amount: '2' });
  expect([changed.status, changed.body.code]).toEqual([409, 'idempotency_conflict']);
  // Another caller cannot see or settle this reservation, even with the same operation ID.
  const other = await person();
  const foreign = await reservation({ ...other, agent: member.agent }, realm,
    { unit: 'reply.publish', operationId: winner.operationId, action: 'settle', consumed: '1' });
  expect([foreign.status, foreign.body.code]).toEqual([403, 'quota_denied']);
  const noScope = await reservation({ ...member, bearer: `Bearer ${member.subject}|work:read` }, realm,
    { unit: 'reply.publish', operationId: 'no-scope', action: 'reserve', amount: '1' });
  expect(noScope.status).toBe(401);
}, 60_000);

test('SUB04: settlement and compensation apply once, keep consumed usage and release only the remainder', async () => {
  const realm = iri();
  const member = await person();
  await policy(realm, 'reply.publish', { base: 3 });
  const reserved = await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-1', action: 'reserve',
    amount: '2' });
  expect(reserved.body).toMatchObject({ state: 'reserved', amount: '2', consumed: '0', ledger: { source: 'base' } });
  const settle = { unit: 'reply.publish', operationId: 'job-1', action: 'settle', consumed: '1', ackReference: 'worker-ack-1' };
  const settled = await reservation(member, realm, settle);
  expect(settled.body).toMatchObject({ state: 'settled', consumed: '1', generation: '2', replayed: false });
  // Duplicate worker ACKs and an identical repeat do not settle twice.
  expect((await reservation(member, realm, settle)).body).toMatchObject({ state: 'settled', generation: '2', replayed: true });
  expect((await reservation(member, realm, { ...settle, ackReference: 'worker-ack-2' })).body)
    .toMatchObject({ state: 'settled', generation: '2', replayed: true });
  const different = await reservation(member, realm, { ...settle, consumed: '2', ackReference: 'worker-ack-3' });
  expect([different.status, different.body.code]).toEqual([409, 'quota_stale']);
  const compensateLate = await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-1', action: 'release' });
  expect([compensateLate.status, compensateLate.body.code]).toEqual([409, 'quota_stale']);
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '3', reserved: '0', consumed: '1', open: true }]);

  // A failed operation releases only its own unconsumed remainder.
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-2', action: 'reserve', amount: '2' });
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-2', action: 'consume', consumed: '1',
    ackReference: 'stage-ack' });
  const released = await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-2', action: 'release' });
  expect(released.body).toMatchObject({ state: 'released', consumed: '1' });
  expect((await reservation(member, realm, { unit: 'reply.publish', operationId: 'job-2', action: 'release' })).body)
    .toMatchObject({ state: 'released', replayed: true });
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '3', reserved: '0', consumed: '2', open: true }]);

  // A retain policy keeps the whole failed reservation as consumed work.
  await policy(realm, 'review.work', { base: 2, failure: 'retain' });
  await reservation(member, realm, { unit: 'review.work', operationId: 'review-1', action: 'reserve', amount: '2' });
  expect((await reservation(member, realm, { unit: 'review.work', operationId: 'review-1', action: 'release' })).body)
    .toMatchObject({ state: 'released', consumed: '2' });
  const exhausted = await reservation(member, realm, { unit: 'review.work', operationId: 'review-2', action: 'reserve',
    amount: '1' });
  expect(exhausted.body.code).toBe('quota_exhausted');

}, 60_000);

test('SUB04: an expired lease keeps consumed usage, and renewals extend only live leases', async () => {
  const realm = iri();
  const member = await person();
  await policy(realm, 'reply.publish', { base: 4, ttl: '1 second' });
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'long', action: 'reserve', amount: '3' });
  const renewed = await reservation(member, realm, { unit: 'reply.publish', operationId: 'long', action: 'renew' });
  expect(renewed.body).toMatchObject({ state: 'reserved', generation: '2' });
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'long', action: 'consume', consumed: '2',
    ackReference: 'stage-1' });
  await Bun.sleep(1200);
  const late = await reservation(member, realm, { unit: 'reply.publish', operationId: 'long', action: 'consume',
    consumed: '3', ackReference: 'stage-2' });
  expect([late.status, late.body.code]).toEqual([409, 'quota_stale']);
  const read = await app.handle(new Request(`http://main.local/v1/realms/${encodeURIComponent(realm)}/quota-reservations?unit=reply.publish&beneficiary=${encodeURIComponent(member.agent)}&operationId=long`,
    { headers: { authorization: member.bearer } }));
  expect(await read.json()).toMatchObject({ state: 'expired', consumed: '2' });
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '4', reserved: '0', consumed: '2', open: true }]);
  // The bounded expiry sweep handles lapsed leases nobody touches; an unknown
  // external outcome waits in reconciling, never expires, then settles once.
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'idle', action: 'reserve', amount: '1' });
  await reservation(member, realm, { unit: 'reply.publish', operationId: 'uncertain', action: 'reserve', amount: '1' });
  expect((await reservation(member, realm, { unit: 'reply.publish', operationId: 'uncertain', action: 'defer' }))
    .body.state).toBe('reconciling');
  await Bun.sleep(1200);
  expect(await quota.expireDue(10)).toBe(1);
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '4', reserved: '1', consumed: '2', open: true }]);
  expect((await reservation(member, realm, { unit: 'reply.publish', operationId: 'uncertain', action: 'settle',
    consumed: '1' })).body).toMatchObject({ state: 'settled', consumed: '1' });
  expect(await ledgers(member.agent)).toEqual([{ source: 'base', capacity: '4', reserved: '0', consumed: '3', open: true }]);
}, 60_000);

test('SUB04: gifted and purchased capacity keep independent ledgers and revocation closes only the gift', async () => {
  const realm = iri();
  const member = await person();
  await policy(realm, 'reply.publish', { base: 1 });
  const gift = await entitlement(realm, member.agent, 'gift', 'reply.publish', 2);
  await entitlement(realm, member.agent, 'purchase', 'reply.publish', 2);
  const sources: string[] = [];
  for (const index of [1, 2, 3]) {
    const result = await reservation(member, realm, { unit: 'reply.publish', operationId: `mix-${index}`,
      action: 'reserve', amount: '1' });
    sources.push(`${result.body.ledger.source}:${result.body.ledger.entitlementId === gift ? 'gift' : 'other'}`);
    await reservation(member, realm, { unit: 'reply.publish', operationId: `mix-${index}`, action: 'settle', consumed: '1' });
  }
  // Base allowance first, then the gift, then the purchase.
  expect(sources).toEqual(['base:other', 'entitlement:gift', 'entitlement:gift']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
      valid_until, reason_reference) SELECT id, 2, 'revoke', 'revoked', valid_until, 'fixture' FROM commerce.entitlement WHERE id = $1`, [gift]);
    await client.query(`UPDATE commerce.entitlement SET state = 'revoked', generation = 2 WHERE id = $1`, [gift]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const afterRevoke = await reservation(member, realm, { unit: 'reply.publish', operationId: 'mix-4', action: 'reserve',
    amount: '2' });
  expect(afterRevoke.body.ledger.source).toBe('entitlement');
  expect(afterRevoke.body.ledger.entitlementId).not.toBe(gift);
  // The gift's already consumed usage stays in its own ledger.
  const giftLedger = await pool.query<{ consumed: string }>('SELECT consumed FROM quota.ledger WHERE entitlement_id = $1', [gift]);
  expect(giftLedger.rows[0]!.consumed).toBe('2');
  const none = await reservation(member, realm, { unit: 'reply.publish', operationId: 'mix-5', action: 'reserve', amount: '1' });
  expect(none.body.code).toBe('quota_exhausted');
}, 60_000);

test('SUB04: a held recovery fence admits nothing, and reservation work is fixed as unrelated usage grows', async () => {
  const realm = iri();
  const member = await person();
  await policy(realm, 'reply.publish', { base: 5 });
  await pool.query('UPDATE access.recovery_fence SET open = false, generation = generation + 1');
  try {
    const held = await reservation(member, realm, { unit: 'reply.publish', operationId: 'held', action: 'reserve', amount: '1' });
    expect([held.status, held.body.code]).toEqual([503, 'quota_unavailable']);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open = true, generation = generation + 1');
  }
  expect(await ledgers(member.agent)).toEqual([]);
  async function measure(operationId: string) {
    statements = 0;
    await reservation(member, realm, { unit: 'reply.publish', operationId, action: 'reserve', amount: '1' });
    const reserve = statements;
    statements = 0;
    await reservation(member, realm, { unit: 'reply.publish', operationId, action: 'settle', consumed: '1' });
    return [reserve, statements];
  }
  const small = await measure('cost-1');
  // 3,000 unrelated reservations across other beneficiaries on a busy policy.
  const busy = await policy(iri(), 'reply.publish', { base: 5 });
  await pool.query(`WITH l AS (
      INSERT INTO quota.ledger (id, policy_id, policy_revision, beneficiary, source, period_start, period_end, capacity)
      SELECT gen_random_uuid(), $1, 1, 'https://rezics.com/id/' || gen_random_uuid(), 'base',
        date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC') + interval '1 day', 5
      FROM generate_series(1, 3000) RETURNING id)
    SELECT count(*) FROM l`, [busy]);
  await pool.query('ANALYZE quota.ledger; ANALYZE quota.reservation');
  expect(await measure('cost-2')).toEqual(small);
}, 60_000);
