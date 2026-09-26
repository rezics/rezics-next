import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { Client, Pool, type PoolClient } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import type { OwnerColumns, OwnerRow } from '../../../services/main/src/modules/commerce/owner-columns.ts';
import { commerceColumns, commerceSchema } from '../../../services/main/src/modules/commerce/schema.ts';
import { siteColumns, siteSchema } from '../../../services/main/src/modules/pro-site/schema.ts';
import { quotaColumns, quotaSchema } from '../../../services/main/src/modules/quota/schema.ts';
import { realmReplyColumns, realmReplySchema } from '../../../services/main/src/modules/realm-reply/schema.ts';

// Owner schema for subscriptions, quotas, fixed-Realm sites and Realm reply
// review: empty install, upgrade from the preceding head, and the constraint
// guarantees later commands rely on. Fresh databases come from the QA stack's
// PostgreSQL and are dropped afterwards.
const root = resolve(import.meta.dir, '../../..');
const accessDir = join(root, 'services/main/migrations/access');
const contentDir = join(root, 'services/content/migrations');
const accessUpgradeFrom = 90;
const contentUpgradeFrom = 60;
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); }, 120_000);

const iri = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sqlFiles = (dir: string) => [...new Bun.Glob('*.sql').scanSync({ cwd: dir })].sort();

function stackEnv() {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  return { compose: readEnv(join(stackDir, 'compose.env')), apps: readEnv(join(stackDir, 'apps.env')) };
}

async function freshDatabase(owner: 'access' | 'content'): Promise<Pool> {
  const { compose, apps } = stackEnv();
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const name = `qa_${randomBytes(6).toString('hex')}_${owner}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE template0 OWNER ${owner}`); }
  finally { await admin.end(); }
  const url = new URL(apps[`${owner.toUpperCase()}_DATABASE_URL`]!);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  cleanups.push(async () => {
    await pool.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await cleanup.end(); }
  });
  return pool;
}

/** Apply Access files in name order, as bootstrap and the dev CLI do. */
async function applyAccess(pool: Pool, select: (version: number) => boolean): Promise<void> {
  for (const file of sqlFiles(accessDir).filter(name => select(Number(name.slice(0, 3))))) {
    await pool.query(readFileSync(join(accessDir, file), 'utf8'));
  }
}

async function expectCatalog(pool: Pool, schema: string, columns: OwnerColumns,
  exhaustive: boolean): Promise<void> {
  const installed = await pool.query<{ table_name: string; column_name: string; udt_name: string;
    is_nullable: 'YES' | 'NO' }>(
    `SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable
     FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
       AND ($2::boolean OR c.table_name = ANY($3::text[]))
     ORDER BY c.table_name, c.ordinal_position`, [schema, exhaustive, Object.keys(columns)]);
  const actual: Record<string, Record<string, string>> = {};
  for (const row of installed.rows) {
    (actual[row.table_name] ??= {})[row.column_name] = row.udt_name + (row.is_nullable === 'YES' ? '?' : '');
  }
  expect(actual).toEqual(columns as unknown as Record<string, Record<string, string>>);
}

async function expectAccessCatalogs(pool: Pool): Promise<void> {
  await expectCatalog(pool, commerceSchema, commerceColumns, true);
  await expectCatalog(pool, quotaSchema, quotaColumns, true);
  await expectCatalog(pool, siteSchema, siteColumns, true);
  // No commerce, quota or site table is placed in the Access authority schema.
  const leaked = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'access' AND table_name ~ '^(commerce|quota|site|entitlement|subscription)'`);
  expect(leaked.rows).toEqual([]);
}

async function expectFailure(work: Promise<unknown>, code: string): Promise<void> {
  const error = await work.then(() => undefined, (failure: unknown) => failure);
  expect((error as { code?: string } | undefined)?.code).toBe(code);
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('commerce schema: empty Access and Content installs match the typed catalogs', async () => {
  const access = await freshDatabase('access');
  await applyAccess(access, () => true);
  await expectAccessCatalogs(access);
  const content = await freshDatabase('content');
  await migrateContent(content);
  await expectCatalog(content, realmReplySchema, realmReplyColumns, false);
  const actions = await content.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conname = 'receipt_action_check' AND conrelid = 'content.receipt'::regclass`);
  // The union keeps every earlier action and the installed ARRAY form parseable.
  for (const action of ['draft.save', 'publication.prepare', 'publication.settle', 'comment.create',
    'reply.create', 'review.decide']) {
    expect(actions.rows[0]!.definition).toContain(`'${action}'::text`);
  }
}, 120_000);

test('commerce schema: upgrade from the preceding Access and Content heads keeps existing rows', async () => {
  const access = await freshDatabase('access');
  await applyAccess(access, version => version < accessUpgradeFrom);
  const principal = randomUUID();
  const subject = iri();
  await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, 'https://account.rezics.test', $2)`, [principal, `upgrade-${principal}`]);
  await access.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [subject]);
  await access.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')`);
  await applyAccess(access, version => version >= accessUpgradeFrom);
  await expectAccessCatalogs(access);
  const kept = await access.query(`SELECT p.account_subject, s.kind, g.authority_epoch::text
    FROM access.principal p, access.authority_subject s, access.scope_gate g
    WHERE p.id = $1 AND s.id = $2 AND g.id = 'work:create:root'`, [principal, subject]);
  expect(kept.rows).toEqual([{ account_subject: `upgrade-${principal}`, kind: 'agent', authority_epoch: '0' }]);

  const content = await freshDatabase('content');
  await content.query(`CREATE SCHEMA IF NOT EXISTS content;
    CREATE TABLE content.schema_migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of sqlFiles(contentDir).filter(name => Number(name.slice(0, 3)) < contentUpgradeFrom)) {
    await content.query(readFileSync(join(contentDir, file), 'utf8'));
    await content.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [Number(file.slice(0, 3))]);
  }
  const body = seedContent(content);
  const before = await body.revision(`existing-${randomUUID()}`, 'draft.save');
  await migrateContent(content);
  await expectCatalog(content, realmReplySchema, realmReplyColumns, false);
  const receipt = await content.query(`SELECT action, revision_id FROM content.receipt WHERE operation_id = $1`,
    [before.operation]);
  expect(receipt.rows).toEqual([{ action: 'draft.save', revision_id: before.revision }]);
}, 120_000);

/** Minimal Content owner writes: one variant per resource, sequenced receipts. */
function seedContent(pool: Pool) {
  let sequence = 0;
  return {
    async revision(resource: string, action: string, variant = resource, predecessor: string | null = null) {
      const epoch = (await pool.query<{ data_epoch: string }>('SELECT data_epoch FROM content.owner_control')).rows[0]!.data_epoch;
      if (!predecessor) {
        await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
          VALUES ($1, $2, 'und', 'ltr')`, [variant, resource]);
      }
      const revision = randomUUID();
      const bytes = Buffer.from(JSON.stringify({ text: `${resource}:${revision}` }));
      const operation = `op-${randomUUID()}`;
      await pool.query(`INSERT INTO content.revision (id, variant_id, predecessor, operation_id, format, model,
          provenance, byte_digest, byte_length, serialized_bytes, body)
        VALUES ($1, $2, $3, $4, 'rezics-content-json-v1', 'test', '{}', $5, $6, $7, $8)`,
        [revision, variant, predecessor, operation, createHash('sha256').update(bytes).digest('hex'),
          bytes.length, bytes, bytes.toString()]);
      await pool.query('UPDATE content.variant SET draft_head = $2 WHERE id = $1', [variant, revision]);
      sequence++;
      await pool.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id,
          revision_id, data_epoch, sequence) VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7)`,
        [operation, digest(operation), action, variant, revision, epoch, sequence]);
      return { variant, revision, operation, digest: createHash('sha256').update(bytes).digest('hex') };
    },
    async receipt(action: string, variant: string, revision: string) {
      const epoch = (await pool.query<{ data_epoch: string }>('SELECT data_epoch FROM content.owner_control')).rows[0]!.data_epoch;
      const operation = `op-${randomUUID()}`;
      sequence++;
      await pool.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id,
          revision_id, data_epoch, sequence) VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7)`,
        [operation, digest(operation), action, variant, revision, epoch, sequence]);
      return operation;
    },
  };
}

test('commerce schema: purchase, gift, settlement callbacks and revocation stay independent', async () => {
  const pool = await freshDatabase('access');
  await applyAccess(pool, () => true);
  const payer = randomUUID();
  const issuer = iri();
  const seller = iri();
  const beneficiary = iri();
  const offering = randomUUID();
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, 'https://account.rezics.test', $2)`, [payer, `payer-${payer}`]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [issuer]);
  await pool.query(`INSERT INTO commerce.payment_provider (id, kind, callback_key_reference)
    VALUES ('fake', 'fake', 'vault:commerce/fake-callback')`);
  await expectFailure(pool.query(`INSERT INTO commerce.payment_provider (id, kind, callback_key_reference)
    VALUES ('live', 'stripe', 'vault:x')`), '23514');
  await transaction(pool, async client => {
    await client.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1, $2, 'person', 1)`, [offering, seller]);
    await client.query(`INSERT INTO commerce.offering_revision (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1, 1, 'open', $2)`, [offering, digest('offering-1')]);
    await client.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics)
      VALUES ($1, 'pro', 'replaceable'), ($1, 'addons', 'parallel')`, [offering]);
    await client.query(`INSERT INTO commerce.plan (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1, 1, 'basic', 'pro', 1), ($1, 1, 'plus', 'pro', 2), ($1, 1, 'extra', 'addons', 0)`, [offering]);
    await client.query(`INSERT INTO commerce.price (offering_id, offering_revision, plan_key, price_key, currency,
        amount_minor, billing_period)
      VALUES ($1, 1, 'basic', 'monthly', 'USD', 500, 'P1M'), ($1, 1, 'plus', 'monthly', 'USD', 1500, 'P1M'),
             ($1, 1, 'extra', 'monthly', 'USD', 100, 'P1M')`, [offering]);
    await client.query(`INSERT INTO commerce.plan_benefit (offering_id, offering_revision, plan_key, benefit_key,
        level, quota_unit, quota_amount)
      VALUES ($1, 1, 'basic', 'pro.read', 1, 'reply.publish', 5), ($1, 1, 'plus', 'pro.read', 2, 'reply.publish', 50)`,
    [offering]);
  });
  // Immutable price revision: a changed price needs a new offering revision.
  await expectFailure(pool.query(`UPDATE commerce.price SET amount_minor = 1 WHERE offering_id = $1`, [offering]), '23514');

  async function purchase(plan: string, group: string, key: string) {
    return transaction(pool, async client => {
      const quote = randomUUID();
      const subscription = randomUUID();
      const change = randomUUID();
      const settlement = randomUUID();
      await client.query(`INSERT INTO commerce.receipt (principal_id, idempotency_key, request_digest, operation, result)
        VALUES ($1, $2, $3, 'purchase', '{}')`, [payer, key, digest(key)]);
      await client.query(`INSERT INTO commerce.quote (id, principal_id, beneficiary, operation, offering_id,
          offering_revision, plan_key, price_key, amount_minor, currency, eligibility, quote_digest, expires_at)
        VALUES ($1, $2, $3, 'purchase', $4, 1, $5, 'monthly', 500, 'USD', '{"benefitEpoch":"0"}', $6,
          clock_timestamp() + interval '5 minutes')`, [quote, payer, beneficiary, offering, plan, digest(quote)]);
      await client.query(`INSERT INTO commerce.subscription (id, principal_id, beneficiary, offering_id, group_key,
          group_semantics, offering_revision, plan_key, price_key, state, generation, provider)
        SELECT $1, $2, $3, $4, $5, g.semantics, 1, $6, 'monthly', 'pending', 1, 'fake'
        FROM commerce.plan_group g WHERE g.offering_id = $4 AND g.group_key = $5`,
      [subscription, payer, beneficiary, offering, group, plan]);
      await client.query(`INSERT INTO commerce.subscription_change (id, subscription_id, quote_id, operation,
          base_generation, result_generation, principal_id, idempotency_key)
        VALUES ($1, $2, $3, 'purchase', 0, 1, $4, $5)`, [change, subscription, quote, payer, key]);
      await client.query(`INSERT INTO commerce.settlement (id, change_id, provider, provider_reference, amount_minor,
          currency, state, generation) VALUES ($1, $2, 'fake', $3, 500, 'USD', 'pending', 1)`,
      [settlement, change, `pay-${settlement}`]);
      await client.query(`INSERT INTO commerce.settlement_event (settlement_id, generation, state, source)
        VALUES ($1, 1, 'pending', 'command')`, [settlement]);
      return { subscription, settlement, change, reference: `pay-${settlement}` };
    });
  }
  const paid = await purchase('basic', 'pro', 'purchase-basic');
  // Replaceable group: a second live purchase for the same beneficiary conflicts;
  // a parallel group admits an independent purchase.
  await expectFailure(purchase('plus', 'pro', 'purchase-plus'), '23505');
  await purchase('extra', 'addons', 'purchase-extra');

  const entitlement = randomUUID();
  await transaction(pool, async client => {
    await client.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id, provider_reference,
        event_kind, payload_digest, disposition, settlement_id, settlement_generation)
      VALUES ('fake', 'evt-1', $1, 'payment.succeeded', $2, 'applied', $3, 2)`,
    [paid.reference, digest('evt-1'), paid.settlement]);
    await client.query(`INSERT INTO commerce.settlement_event (settlement_id, generation, state, source,
        callback_provider, callback_event_id) VALUES ($1, 2, 'succeeded', 'provider-callback', 'fake', 'evt-1')`,
    [paid.settlement]);
    await client.query(`UPDATE commerce.settlement SET state = 'succeeded', generation = 2 WHERE id = $1`,
      [paid.settlement]);
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, subscription_id, valid_from, valid_until, state, generation)
      VALUES ($1, $2, 'purchase', $3, 1, 'basic', $4, clock_timestamp(), clock_timestamp() + interval '30 days',
        'active', 1)`, [entitlement, beneficiary, offering, paid.subscription]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
        valid_until, change_id, settlement_id)
      SELECT id, 1, 'grant', 'active', valid_until, $2, $3 FROM commerce.entitlement WHERE id = $1`,
    [entitlement, paid.change, paid.settlement]);
    await client.query(`UPDATE commerce.subscription SET state = 'active', generation = 2,
      current_period_end = clock_timestamp() + interval '30 days' WHERE id = $1`, [paid.subscription]);
  });
  // A duplicate callback delivery and a second fulfillment of the same settlement are both refused.
  await expectFailure(pool.query(`INSERT INTO commerce.provider_callback (provider, provider_event_id,
      provider_reference, event_kind, payload_digest, disposition) VALUES ('fake', 'evt-1', 'x',
      'payment.succeeded', $1, 'unmatched')`, [digest('evt-1')]), '23505');
  const second = randomUUID();
  await expectFailure(transaction(pool, async client => {
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, subscription_id, valid_from, valid_until, state, generation)
      VALUES ($1, $2, 'purchase', $3, 1, 'basic', $4, clock_timestamp(), clock_timestamp() + interval '1 day',
        'active', 1)`, [second, beneficiary, offering, paid.subscription]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
        valid_until, settlement_id) VALUES ($1, 1, 'grant', 'active', clock_timestamp() + interval '1 day', $2)`,
    [second, paid.settlement]);
  }), '23505');
  // A settled payment cannot fall back to pending or be charged again.
  await expectFailure(pool.query(`UPDATE commerce.settlement SET state = 'pending', generation = 3 WHERE id = $1`,
    [paid.settlement]), '23514');
  // A settlement generation without its audited event cannot commit.
  await expectFailure(transaction(pool, client => client.query(
    `UPDATE commerce.settlement SET state = 'unknown', generation = 2 WHERE id = (
       SELECT s.id FROM commerce.settlement s WHERE s.state = 'pending' LIMIT 1)`)), '23503');

  // A higher gift coexists with the lower purchase as an independent grant.
  const gift = randomUUID();
  await transaction(pool, async client => {
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, award_issuer, award_reason, valid_from, valid_until, state, generation)
      VALUES ($1, $2, 'gift', $3, 1, 'plus', $4, 'launch-award', clock_timestamp(),
        clock_timestamp() + interval '7 days', 'active', 1)`, [gift, beneficiary, offering, issuer]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state, valid_until)
      SELECT id, 1, 'grant', 'active', valid_until FROM commerce.entitlement WHERE id = $1`, [gift]);
  });
  type Effective = OwnerRow<{ source: 'text'; plan_key: 'text'; level: 'int4' }>;
  const effective = await pool.query<Effective>(`SELECT e.source, e.plan_key, b.level
    FROM commerce.entitlement e JOIN commerce.plan_benefit b USING (offering_id, offering_revision, plan_key)
    WHERE e.beneficiary = $1 AND e.state = 'active' AND b.benefit_key = 'pro.read' ORDER BY b.level`, [beneficiary]);
  expect(effective.rows).toEqual([{ source: 'purchase', plan_key: 'basic', level: 1 },
    { source: 'gift', plan_key: 'plus', level: 2 }]);
  const epoch = async () => (await pool.query<OwnerRow<typeof commerceColumns.benefit_epoch>>(
    'SELECT beneficiary, epoch FROM commerce.benefit_epoch WHERE beneficiary = $1', [beneficiary])).rows[0]!.epoch;
  expect(await epoch()).toBe('2');

  // Revoking the gift ends only that grant; nothing can reactivate it.
  await transaction(pool, async client => {
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state,
        valid_until, reason_reference) SELECT id, 2, 'revoke', 'revoked', valid_until, 'abuse-report'
      FROM commerce.entitlement WHERE id = $1`, [gift]);
    await client.query(`UPDATE commerce.entitlement SET state = 'revoked', generation = 2 WHERE id = $1`, [gift]);
  });
  expect(await epoch()).toBe('3');
  await expectFailure(pool.query(`UPDATE commerce.entitlement SET state = 'active', generation = 3 WHERE id = $1`,
    [gift]), '23514');
  await expectFailure(pool.query('DELETE FROM commerce.entitlement_event WHERE entitlement_id = $1', [gift]), '23514');
  const purchased = await pool.query<OwnerRow<typeof commerceColumns.entitlement>>(
    'SELECT * FROM commerce.entitlement WHERE id = $1', [entitlement]);
  expect(purchased.rows[0]!.state).toBe('active');
  const subscription = await pool.query<OwnerRow<typeof commerceColumns.subscription>>(
    'SELECT * FROM commerce.subscription WHERE id = $1', [paid.subscription]);
  expect([subscription.rows[0]!.state, subscription.rows[0]!.generation]).toEqual(['active', '2']);
  // No Access table depends on commerce, quota or site rows, and none of them
  // references an Access permission grant.
  const crossing = await pool.query(`SELECT conname FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    WHERE c.contype = 'f' AND ((cn.nspname = 'access' AND pn.nspname IN ('commerce', 'quota', 'site'))
      OR (cn.nspname IN ('commerce', 'quota', 'site') AND parent.relname LIKE '%grant%'))`);
  expect(crossing.rows).toEqual([]);
}, 120_000);

test('commerce schema: quota last capacity admits one reservation; a fixed site keeps its Realm', async () => {
  const pool = await freshDatabase('access');
  await applyAccess(pool, () => true);
  const policy = randomUUID();
  const ledger = randomUUID();
  const beneficiary = iri();
  await transaction(pool, async client => {
    await client.query(`INSERT INTO quota.policy (id, scope, unit, head_revision) VALUES ($1, $2, 'reply.publish', 1)`,
      [policy, iri()]);
    await client.query(`INSERT INTO quota.policy_revision (policy_id, revision, period, base_allowance, max_reservation,
        reservation_ttl, failure_policy) VALUES ($1, 1, 'P1D', 1, 1, interval '5 minutes', 'release')`, [policy]);
  });
  await pool.query(`INSERT INTO quota.ledger (id, policy_id, policy_revision, beneficiary, source, period_start,
      period_end, capacity) VALUES ($1, $2, 1, $3, 'base', date_trunc('day', now()),
      date_trunc('day', now()) + interval '1 day', 1)`, [ledger, policy, beneficiary]);

  async function reserve(client: PoolClient, operation: string): Promise<string> {
    const id = randomUUID();
    await client.query(`INSERT INTO quota.reservation (id, ledger_id, policy_id, policy_revision, operation_id,
        request_digest, amount, state, generation, expires_at)
      VALUES ($1, $2, $3, 1, $4, $5, 1, 'reserved', 1, clock_timestamp() + interval '5 minutes')`,
    [id, ledger, policy, operation, digest(operation)]);
    await client.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state, consumed,
        expires_at) SELECT id, 1, 'reserve', 'reserved', 0, expires_at FROM quota.reservation WHERE id = $1`, [id]);
    return id;
  }
  // Two concurrent final-capacity requests: the second waits on the ledger row
  // and then fails its capacity check.
  const first = await pool.connect();
  const second = await pool.connect();
  let winner = '';
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    winner = await reserve(first, 'operation-a');
    const racing = reserve(second, 'operation-b');
    await Bun.sleep(100);
    await first.query('COMMIT');
    await expectFailure(racing, '23514');
    await second.query('ROLLBACK');
  } finally {
    first.release();
    second.release();
  }
  const reservedLedger = await pool.query<OwnerRow<typeof quotaColumns.ledger>>(
    'SELECT * FROM quota.ledger WHERE id = $1', [ledger]);
  expect([reservedLedger.rows[0]!.reserved, reservedLedger.rows[0]!.consumed]).toEqual(['1', '0']);

  // Totals move only through reservations; premature expiry is refused.
  await expectFailure(pool.query('UPDATE quota.ledger SET reserved = 0 WHERE id = $1', [ledger]), '23514');
  await expectFailure(transaction(pool, async client => {
    await client.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state, consumed,
        expires_at) SELECT id, 2, 'expire', 'expired', 0, expires_at FROM quota.reservation WHERE id = $1`, [winner]);
    await client.query(`UPDATE quota.reservation SET state = 'expired', generation = 2 WHERE id = $1`, [winner]);
  }), '23514');

  await transaction(pool, async client => {
    await client.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state, consumed,
        expires_at, ack_reference) SELECT id, 2, 'settle', 'settled', 1, expires_at, 'worker-ack-1'
      FROM quota.reservation WHERE id = $1`, [winner]);
    await client.query(`UPDATE quota.reservation SET state = 'settled', consumed = 1, generation = 2 WHERE id = $1`,
      [winner]);
  });
  // A duplicate ACK cannot settle again and a terminal reservation never reopens.
  await expectFailure(pool.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state,
      consumed, expires_at, ack_reference) SELECT id, 3, 'settle', 'settled', 1, expires_at, 'worker-ack-1'
    FROM quota.reservation WHERE id = $1`, [winner]), '23505');
  await expectFailure(pool.query(`UPDATE quota.reservation SET state = 'released', generation = 3 WHERE id = $1`,
    [winner]), '23514');
  const settledLedger = await pool.query<OwnerRow<typeof quotaColumns.ledger>>(
    'SELECT * FROM quota.ledger WHERE id = $1', [ledger]);
  expect([settledLedger.rows[0]!.reserved, settledLedger.rows[0]!.consumed]).toEqual(['0', '1']);

  // A fixed-Realm site keeps its Realm for every later revision.
  const site = randomUUID();
  const realm = iri();
  await transaction(pool, async client => {
    await client.query(`INSERT INTO site.definition (id, host, head_revision) VALUES ($1, 'pro.rezics.test', 1)`, [site]);
    await client.query(`INSERT INTO site.definition_revision (site_id, revision, kind, realm, lifecycle,
        presentation_profile, required_benefit) VALUES ($1, 1, 'fixed-realm', $2, 'active', 'pro', 'pro.read')`,
    [site, realm]);
  });
  await expectFailure(transaction(pool, async client => {
    await client.query(`INSERT INTO site.definition_revision (site_id, revision, kind, realm, lifecycle,
        presentation_profile) VALUES ($1, 2, 'fixed-realm', $2, 'active', 'pro')`, [site, iri()]);
    await client.query('UPDATE site.definition SET head_revision = 2 WHERE id = $1', [site]);
  }), '23514');
  const siteRow = await pool.query<OwnerRow<typeof siteColumns.definition_revision>>(
    'SELECT * FROM site.definition_revision WHERE site_id = $1', [site]);
  expect(siteRow.rows.map(row => [row.revision, row.realm])).toEqual([['1', realm]]);
}, 120_000);

test('commerce schema: Realm review binds the exact reply revision in each Realm independently', async () => {
  const pool = await freshDatabase('content');
  await migrateContent(pool);
  const content = seedContent(pool);
  const reply = iri();
  const first = await content.revision(reply, 'reply.create', `${reply}#body`);
  await pool.query(`INSERT INTO content.reply (id, variant_id, author, root_target, root_revision, operation_id)
    VALUES ($1, $2, $3, $4, $5, $6)`, [reply, first.variant, iri(), iri(), `urn:rezics:revision:${randomUUID()}`,
    first.operation]);
  await expectFailure(pool.query(`UPDATE content.reply SET author = 'someone-else' WHERE id = $1`, [reply]), '23514');
  const realmA = iri();
  const realmB = iri();

  async function decide(realm: string, revision: { variant: string; revision: string; digest: string },
    outcome: string, generation: number, supersedes: string | null = null) {
    const id = randomUUID();
    const operation = await content.receipt('review.decide', revision.variant, revision.revision);
    await pool.query(`INSERT INTO content.realm_review_decision (id, realm, variant_id, revision_id,
        review_generation, supersedes, outcome, policy, policy_revision, method, method_revision, reviewer,
        revision_digest, dependency_digest, reason_reference, operation_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'https://rezics.com/definition/realm-manager-reviewed-v1', '1',
        'human', 'manual-v1', $8, $9, $10, $11, $12)`,
    [id, realm, revision.variant, revision.revision, generation, supersedes, outcome, iri(), revision.digest,
      digest('dependencies'), outcome === 'approved' ? null : 'policy-breach', operation]);
    return id;
  }
  async function prepare(realm: string, revision: { variant: string; revision: string }, decision: string) {
    const operation = `prep-${randomUUID()}`;
    await transaction(pool, async client => {
      await client.query(`INSERT INTO content.publication_preparation (operation_id, revision_id, request_digest)
        VALUES ($1, $2, $3)`, [operation, revision.revision, digest(operation)]);
      await client.query(`INSERT INTO content.realm_placement_preparation (operation_id, realm, variant_id,
          revision_id, review_decision_id) VALUES ($1, $2, $3, $4, $5)`,
      [operation, realm, revision.variant, revision.revision, decision]);
    });
  }
  const approvedA = await decide(realmA, first, 'approved', 1);
  // A concurrent stale decision on the same chain position is rejected.
  await expectFailure(decide(realmA, first, 'rejected', 1), '23505');
  // The author edits after review: the new revision is unreviewed in Realm A.
  const edited = await content.revision(reply, 'draft.save', first.variant, first.revision);
  await expectFailure(prepare(realmA, edited, approvedA), '23503');
  await prepare(realmA, first, approvedA);
  // Realm B independently approves the edited revision.
  const approvedB = await decide(realmB, edited, 'approved', 1);
  await prepare(realmB, edited, approvedB);
  // Revoking A's approval blocks new placements of it without touching Realm B.
  await decide(realmA, first, 'revoked', 2, approvedA);
  await expectFailure(prepare(realmA, first, approvedA), '23514');
  await prepare(realmB, edited, approvedB);
  const decisions = await pool.query<OwnerRow<typeof realmReplyColumns.realm_review_decision>>(
    'SELECT * FROM content.realm_review_decision ORDER BY realm, review_generation');
  expect(decisions.rows.map(row => [row.realm === realmA ? 'A' : 'B', row.revision_id, row.outcome]).sort())
    .toEqual([['A', first.revision, 'approved'], ['A', first.revision, 'revoked'],
      ['B', edited.revision, 'approved']].sort());
  // A review must bind the exact stored revision bytes.
  await expectFailure(decide(realmB, { ...first, digest: digest('other bytes') }, 'approved', 1), '23514');
}, 120_000);
