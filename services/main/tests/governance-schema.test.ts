import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { governanceTables } from '../src/modules/governance/schema.ts';
import { notificationTables } from '../src/modules/notification/schema.ts';
import { rightsTables } from '../src/modules/rights/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const accessDir = join(root, 'services/main/migrations/access');
const contentDir = join(root, 'services/content/migrations');
const ACCESS_HEAD = '033';
const CONTENT_HEAD = 21;
const id = () => Bun.randomUUIDv7();
const iri = () => `https://rezics.com/id/${id()}`;
const digest = (char: string) => char.repeat(64);

const state = join(root, '.temp', `governance-schema-${id()}`);
let port = 0;
const pools: Pool[] = [];
let accessEmpty: Pool;
let accessUpgrade: Pool;
let contentEmpty: Pool;
let contentUpgrade: Pool;
let upgradedProof: OrganizationModeration;
let upgradedRecord: string;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

beforeAll(async () => {
  const data = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const admin = database('postgres');
  for (const name of ['access_empty', 'access_upgrade', 'content_empty', 'content_upgrade']) {
    await admin.query(`CREATE DATABASE ${name}`);
  }
  accessEmpty = database('access_empty');
  await applyAccess(accessEmpty, () => true);
  // Upgrade from the current Access head with a real 027 proof already present.
  accessUpgrade = database('access_upgrade');
  await applyAccess(accessUpgrade, file => file.slice(0, 3) <= ACCESS_HEAD);
  upgradedProof = await seedOrganizationModeration(accessUpgrade);
  await applyAccess(accessUpgrade, file => file.slice(0, 3) > ACCESS_HEAD);

  contentEmpty = database('content_empty');
  await migrateContent(contentEmpty);
  // Upgrade from the current Content head through the real runner.
  contentUpgrade = database('content_upgrade');
  await contentUpgrade.query('CREATE SCHEMA content');
  await contentUpgrade.query(`CREATE TABLE content.schema_migration (
    version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of files(contentDir).filter(name => Number(name.slice(0, 3)) <= CONTENT_HEAD)) {
    await contentUpgrade.query(readFileSync(join(contentDir, file), 'utf8'));
    await contentUpgrade.query('INSERT INTO content.schema_migration (version) VALUES ($1)',
      [Number(file.slice(0, 3))]);
  }
  upgradedRecord = id();
  await contentUpgrade.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'openlibrary', 'works', 'OL1W')`, [upgradedRecord]);
  await contentUpgrade.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type, retention,
    coverage, rights_evidence) VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{"license": null}')`,
  [id(), upgradedRecord, id()]);
  await migrateContent(contentUpgrade);
}, 120_000);

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  try {
    execFileSync('pg_ctl', ['-D', join(state, 'pgdata'), '-m', 'fast', '-w', 'stop'], { cwd: state });
  } finally { rmSync(state, { recursive: true, force: true }); }
}, 60_000);

function database(name: string): Pool {
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: name, max: 2 });
  pools.push(pool);
  return pool;
}

const files = (directory: string) => [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort();
async function applyAccess(pool: Pool, include: (file: string) => boolean): Promise<void> {
  for (const file of files(accessDir).filter(include)) {
    await pool.query(readFileSync(join(accessDir, file), 'utf8'));
  }
}

async function fails(operation: Promise<unknown>, code: string): Promise<void> {
  const error = await operation.then(() => undefined, (caught: { code?: string }) => caught);
  expect(error?.code).toBe(code);
}
const rejects = (pool: Pool | PoolClient, sql: string, params: unknown[], code: string) =>
  fails(pool.query(sql, params), code);

/** Declarations must name exactly the migrated columns, nullability, SQL types and keys. */
async function expectDeclared(pool: Pool, tables: readonly PgTable[]): Promise<void> {
  for (const table of tables) {
    const config = getTableConfig(table);
    const qualified = `${config.schema}.${config.name}`;
    const columns = (await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`, [config.schema, config.name])).rows;
    expect({ table: qualified, columns: columns.map(column => column.column_name).sort() })
      .toEqual({ table: qualified, columns: config.columns.map(column => column.name).sort() });
    for (const column of config.columns) {
      const actual = columns.find(row => row.column_name === column.name)!;
      expect({ column: `${qualified}.${column.name}`, notNull: actual.is_nullable === 'NO', type: actual.data_type })
        .toEqual({ column: `${qualified}.${column.name}`, notNull: column.notNull || column.primary,
          type: column.getSQLType() });
    }
    const key = (await pool.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`, [qualified])).rows.map(row => row.attname).sort();
    const declared = config.primaryKeys[0]?.columns.map(column => column.name)
      ?? config.columns.filter(column => column.primary).map(column => column.name);
    expect({ table: qualified, key }).toEqual({ table: qualified, key: [...declared].sort() });
  }
}

interface OrganizationModeration { admissionId: string; realm: string; mainVersion: string; draft: string }

/** One real organization publication rejection proof under the 027 constraints. */
async function seedOrganizationModeration(pool: Pool): Promise<OrganizationModeration> {
  const client = await pool.connect();
  const principal = id(); const manager = iri(); const organization = iri(); const realm = iri();
  const proposal = id(); const participation = id(); const publisher = id(); const admissionId = id();
  const mainVersion = iri(); const draft = iri();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principal, 'https://account.schema.test', `manager-${principal}`]);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent'), ($2, 'institution')`,
      [manager, organization]);
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1), ($2)',
      [`publication:reject:${realm}`, `publication:publish:${realm}`]);
    await client.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
      VALUES ($1, $2, 1, 'terms-1')`, [realm, manager]);
    await client.query('INSERT INTO access.org_participation_subject (subject) VALUES ($1)', [organization]);
    await client.query(`INSERT INTO access.org_realm_proposal (id, realm, organization_subject, next_generation,
      policy_revision, terms_revision, organization_generation, organization_admission_generation, principal_id,
      authority_epoch, realm_proof, expires_at) VALUES ($1, $2, $3, 1, 1, 'terms-1', 0, 0, $4, 0, '{}',
      now() + interval '5 minutes')`, [proposal, realm, organization, principal]);
    await client.query(`INSERT INTO access.org_realm_participation (id, realm, organization_subject, generation,
      state, policy_revision, terms_revision, proposal_id) VALUES ($1, $2, $3, 1, 'joined', 1, 'terms-1', $4)`,
    [participation, realm, organization, proposal]);
    await client.query(`INSERT INTO access.org_realm_history (participation_id, generation, action, state,
      policy_revision, terms_revision, proposal_id, ban_active, ban_generation, actor_proof, authority_epoch)
      VALUES ($1, 1, 'join', 'joined', 1, 'terms-1', $2, false, 0, '{}', 0)`, [participation, proposal]);
    await client.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state)
      VALUES ($1, $2, $3, $4, 'publication.publish.organization', 'publish-1', $5, 0,
      now() + interval '1 hour', 'registered')`,
    [publisher, principal, organization, `publication:publish:${realm}`, digest('a')]);
    await client.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state, claimed_at)
      VALUES ($1, $2, $3, $4, 'publication.reject.organization', 'reject-1', $5, 3,
      now() + interval '1 hour', 'claimed', now())`,
    [admissionId, principal, manager, `publication:reject:${realm}`, digest('b')]);
    await client.query(`INSERT INTO access.organization_publication_moderation (admission_id, realm,
      organization_subject, participation_id, participation_generation, proposal_id, publisher_admission_id,
      target, authority_proof, proof_digest) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)`,
    [admissionId, realm, organization, participation, proposal, publisher,
      { realm, organizationSubject: organization, participationId: participation, participationGeneration: '1',
        proposalId: proposal, actingSubject: manager, mainVersion, selectedDraft: draft, expectedWorkHead: iri() },
      { principalId: principal, publisher: { admissionId: publisher } }, digest('c')]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { admissionId, realm, mainVersion, draft };
}

async function expectMirrored(pool: Pool, proof: OrganizationModeration): Promise<void> {
  const decision = (await pool.query(`SELECT kind, outcome, context, case_id, admission_id, authority_kind,
    authority_scope_id, authority_epoch::text, idempotency_key FROM access.moderation_decision WHERE id = $1`,
  [proof.admissionId])).rows;
  expect(decision).toEqual([{ kind: 'organization_publication_rejection', outcome: 'reject', context: proof.realm,
    case_id: null, admission_id: proof.admissionId, authority_kind: 'realm',
    authority_scope_id: `publication:reject:${proof.realm}`, authority_epoch: '3', idempotency_key: 'reject-1' }]);
  const target = (await pool.query(`SELECT owner, resource, component, scope_kind, revision, effect
    FROM access.moderation_decision_target WHERE decision_id = $1`, [proof.admissionId])).rows;
  expect(target).toEqual([{ owner: 'graph', resource: proof.mainVersion, component: 'publication',
    scope_kind: 'exact_revision', revision: proof.draft, effect: 'publication' }]);
}

test('G-051 Access schema: 060-063 install on an empty database with declared tables', async () => {
  const pool = accessEmpty;
  await expectDeclared(pool, [...governanceTables, ...notificationTables]);
  expect((await pool.query('SELECT count(*)::int AS n FROM access.moderation_decision')).rows[0].n).toBe(0);
});

test('GOV01-GOV03 schema foundation: upgrade generalizes 027 and enforces exact evidence, CAS and one reversal', async () => {
  const pool = accessUpgrade;
  const before = upgradedProof;
  await expectDeclared(pool, [...governanceTables, ...notificationTables]);
  await expectMirrored(pool, before);
  // The unchanged 027 writer path still yields exactly one decision per proof.
  await expectMirrored(pool, await seedOrganizationModeration(pool));
  await rejects(pool, "UPDATE access.moderation_decision SET disclosure = 'parties' WHERE id = $1",
    [before.admissionId], '23514');

  const principal = id(); const subject = iri(); const scope = 'governance:platform'; const work = iri();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principal, 'https://account.schema.test', 'reviewer']);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [subject]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1), ($2)', [scope, 'governance:other']);
  const openCase = (caseId: string, kind = 'content_report') => pool.query(`INSERT INTO access.governance_case
    (id, kind, authority_kind, authority_scope_id, context, target_owner, target_resource, target_component,
     disclosure) VALUES ($1, $2, 'platform', $3, 'urn:rezics:context:global', 'graph', $4, 'title', 'parties')`,
  [caseId, kind, scope, work]);
  const caseId = id();
  await openCase(caseId);
  await rejects(pool, `INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id, context,
    target_owner, target_resource, target_component, disclosure) VALUES ($1, 'content_report', 'platform', $2,
    'urn:rezics:context:global', 'graph', $3, 'title', 'parties')`, [id(), scope, work], '23505');

  const report = id();
  await pool.query(`INSERT INTO access.governance_report (id, case_id, principal_id, acting_subject,
    principal_epoch, idempotency_key, request_digest, reason_code, evidence_count, evidence_digest)
    VALUES ($1, $2, $3, $4, 0, 'report-1', $5, 'misleading', 2, $6)`,
  [report, caseId, principal, subject, digest('d'), digest('e')]);
  const evidence = `INSERT INTO access.governance_evidence (report_id, ordinal, owner, resource, component,
    revision, revision_digest, state, provenance) VALUES ($1, $2, 'graph', $3, $4, $5, $6, $7, '{}')`;
  await pool.query(evidence, [report, 1, work, 'title', iri(), digest('f'), 'available']);
  await pool.query(evidence, [report, 2, work, 'record', null, null, 'unsupported']);
  await rejects(pool, evidence, [report, 3, work, 'title', iri(), null, 'available'], '23514');
  await rejects(pool, evidence, [report, 3, work, 'record', iri(), null, 'unsupported'], '23514');
  await rejects(pool, `INSERT INTO access.rights_complaint (report_id, case_id, process, claimant_kind,
    claimant_name, claimed_work, claimed_right, notice_digest, notice_received_at)
    VALUES ($1, $2, 'dmca_512', 'rights_holder', 'Claimant', 'A cover', 'copyright', $3, now())`,
  [report, caseId, digest('0')], '23503');

  const decide = (decisionId: string, sequence: number, outcome: string, key: string,
    reverses: string | null = null, decisionScope = scope) => pool.query(`INSERT INTO access.moderation_decision
    (id, kind, outcome, context, case_id, case_sequence, reverses_decision_id, principal_id, acting_subject,
     authority_kind, authority_scope_id, authority_epoch, authority_proof_digest, idempotency_key,
     request_digest, rule_ref, rule_revision, rule_digest, evidence_digest, disclosure)
    VALUES ($1, 'content_moderation', $2, 'urn:rezics:context:global', $3, $4, $5, $6, $7, 'platform', $8, 0,
     $9, $10, $11, 'https://rezics.com/id/rule', 'r1', $12, $13, 'parties')`,
  [decisionId, outcome, caseId, sequence, reverses, principal, subject, decisionScope, digest('1'), key,
    digest('2'), digest('3'), digest('4')]);
  const advance = (head: string, generation: number) => pool.query(
    'UPDATE access.governance_case SET decision_head = $2, generation = $3 WHERE id = $1', [caseId, head, generation]);
  const first = id();
  await decide(first, 1, 'restrict', 'decide-1');
  const revision = iri();
  await pool.query(`INSERT INTO access.moderation_decision_target (decision_id, ordinal, owner, resource,
    component, scope_kind, revision, effect) VALUES ($1, 1, 'graph', $2, 'title', 'exact_revision', $3,
    'disclosure')`, [first, work, revision]);
  await advance(first, 1);
  // A concurrent reviewer holding the old generation, another scope, or a skipped head all fail.
  await fails(decide(id(), 1, 'dismiss', 'decide-stale'), '23514');
  await fails(decide(id(), 2, 'dismiss', 'decide-scope', null, 'governance:other'), '23514');
  await rejects(pool, 'UPDATE access.governance_case SET generation = 3 WHERE id = $1', [caseId], '23514');

  const fence = id();
  await pool.query(`INSERT INTO access.governance_enforcement (id, authority_scope_id, context, owner, resource,
    component, revision, effect, decision_id, decision_ordinal, state, fence_epoch)
    VALUES ($1, $2, 'urn:rezics:context:global', 'graph', $3, 'title', $4, 'disclosure', $5, 1, 'restricted', 1)`,
  [fence, scope, work, revision, first]);
  await pool.query(`INSERT INTO access.outbox (id, kind, scope_id, authority_epoch, moderation_decision_id)
    VALUES ($1, 'moderation.decided', $2, 0, $3)`, [id(), scope, first]);
  await rejects(pool, `INSERT INTO access.outbox (id, kind, scope_id, principal_id, authority_epoch,
    moderation_decision_id) VALUES ($1, 'moderation.decided', $2, $3, 0, $4)`,
  [id(), scope, principal, first], '23514');

  const reversal = id();
  await decide(reversal, 2, 'reverse', 'reverse-1', first);
  await pool.query(`INSERT INTO access.moderation_decision_target (decision_id, ordinal, owner, resource,
    component, scope_kind, revision, effect) VALUES ($1, 1, 'graph', $2, 'title', 'exact_revision', $3,
    'disclosure')`, [reversal, work, revision]);
  await advance(reversal, 2);
  await rejects(pool, `UPDATE access.governance_enforcement SET state = 'released', fence_epoch = 3,
    decision_id = $2 WHERE id = $1`, [fence, reversal], '23514');
  await pool.query(`UPDATE access.governance_enforcement SET state = 'released', fence_epoch = 2,
    decision_id = $2, updated_at = clock_timestamp() WHERE id = $1`, [fence, reversal]);
  await rejects(pool, 'DELETE FROM access.governance_enforcement WHERE id = $1', [fence], '23514');
  // Concurrent reversals of the same decision have one effect.
  await fails(decide(id(), 3, 'reverse', 'reverse-2', first), '23505');
});

test('GOV24-GOV25 schema foundation: complaint notice, process deadlines and attributable restoration', async () => {
  const pool = accessUpgrade;
  const principal = id(); const subject = iri(); const scope = 'governance:rights'; const record = id();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principal, 'https://account.schema.test', 'rights-agent']);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [subject]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  const caseId = id(); const report = id();
  await pool.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id, context,
    target_owner, target_resource, target_component, disclosure) VALUES ($1, 'rights_complaint', 'platform', $2,
    'urn:rezics:context:global', 'source', $3, 'synopsis', 'parties')`, [caseId, scope, record]);
  await pool.query(`INSERT INTO access.governance_report (id, case_id, principal_id, acting_subject,
    principal_epoch, idempotency_key, request_digest, reason_code, evidence_count, evidence_digest)
    VALUES ($1, $2, $3, $4, 0, 'notice-1', $5, 'copyright.notice', 1, $6)`,
  [report, caseId, principal, subject, digest('5'), digest('6')]);
  await pool.query(`INSERT INTO access.rights_complaint (report_id, case_id, process, claimant_kind,
    claimant_name, claimed_work, claimed_right, notice_digest, notice_received_at)
    VALUES ($1, $2, 'dmca_512', 'rights_holder', 'Claimant', 'Synopsis text', 'copyright', $3, now())`,
  [report, caseId, digest('7')]);
  const decide = (decisionId: string, sequence: number, outcome: string, key: string, step: string | null = null) =>
    pool.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id, case_sequence,
      principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch, authority_proof_digest,
      idempotency_key, request_digest, rule_ref, rule_revision, rule_digest, evidence_digest, disclosure,
      answers_step_id) VALUES ($1, 'rights_disposition', $2, 'urn:rezics:context:global', $3, $4, $5, $6,
      'platform', $7, 0, $8, $9, $10, 'https://rezics.com/id/dmca-policy', 'p1', $11, $12, 'parties', $13)`,
    [decisionId, outcome, caseId, sequence, principal, subject, scope, digest('8'), key, digest('9'),
      digest('a'), digest('b'), step]);
  const interim = id();
  await decide(interim, 1, 'interim_restrict', 'interim-1');
  await pool.query('UPDATE access.governance_case SET decision_head = $2, generation = 1 WHERE id = $1',
    [caseId, interim]);
  const step = `INSERT INTO access.governance_process_step (id, case_id, decision_id, process, step, principal_id,
    idempotency_key, request_digest, occurred_at, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`;
  await rejects(pool, step, [id(), caseId, interim, 'platform_appeal', 'counter_notice', principal, 'step-0',
    digest('c'), null], '23514');
  const counterNotice = id();
  await pool.query(step, [counterNotice, caseId, interim, 'dmca_512', 'counter_notice', principal, 'step-1',
    digest('c'), new Date(Date.now() + 10 * 86_400_000)]);
  // Recording the counter-notice leaves the case head and fence alone; only a decision restores.
  expect((await pool.query('SELECT decision_head FROM access.governance_case WHERE id = $1', [caseId])).rows[0])
    .toEqual({ decision_head: interim });
  await decide(id(), 2, 'restore', 'restore-1', counterNotice);
  await rejects(pool, 'DELETE FROM access.governance_process_step WHERE id = $1', [counterNotice], '23514');
});

test('GOV05-GOV08 schema foundation: monotonic streams, terminal deliveries and idempotent callbacks', async () => {
  const pool = accessEmpty;
  const principal = id();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principal, 'https://account.schema.test', 'recipient']);
  await rejects(pool, `INSERT INTO access.notification_preference (principal_id, purpose, topic, channel, state,
    revision) VALUES ($1, 'security', 'login', 'email', 'disabled', 1)`, [principal], '23514');
  await pool.query(`INSERT INTO access.notification_preference (principal_id, purpose, topic, channel, state,
    revision) VALUES ($1, 'social', 'reply', 'email', 'enabled', 1)`, [principal]);
  await rejects(pool, `UPDATE access.notification_preference SET state = 'disabled', revision = 3
    WHERE principal_id = $1`, [principal], '23514');

  await pool.query("INSERT INTO access.notification_stream (principal_id, stream) VALUES ($1, 'inbox')", [principal]);
  const item = `INSERT INTO access.notification_item (id, principal_id, stream, generation, sequence, purpose,
    topic, source_owner, source_event, subject_owner, subject_ref, disclosure_basis)
    VALUES ($1, $2, 'inbox', 1, $3, 'social', 'reply', 'graph', $4, 'graph', $5, 'public')`;
  const itemId = id(); const event = id();
  const head = (sequence: number) => pool.query(
    'UPDATE access.notification_stream SET head_sequence = $2 WHERE principal_id = $1', [principal, sequence]);
  await rejects(pool, item, [itemId, principal, 1, event, iri()], '23514');
  await head(1);
  await pool.query(item, [itemId, principal, 1, event, iri()]);
  await head(2);
  // A duplicate source event cannot create a second inbox item.
  await rejects(pool, item, [id(), principal, 2, event, iri()], '23505');
  await fails(head(1), '23514');

  const watermark = `INSERT INTO access.notification_read_watermark (principal_id, stream, generation,
    read_through) VALUES ($1, 'inbox', $2, $3) ON CONFLICT (principal_id, stream, generation)
    DO UPDATE SET read_through = EXCLUDED.read_through`;
  await pool.query(watermark, [principal, 1, 1]);
  await pool.query(watermark, [principal, 1, 1]);
  await rejects(pool, watermark, [principal, 1, 0], '23514');
  await rejects(pool, watermark, [principal, 1, 3], '23514');
  await pool.query(`UPDATE access.notification_stream SET generation = 2, head_sequence = 0, reset_at = now()
    WHERE principal_id = $1`, [principal]);
  await pool.query(watermark, [principal, 2, 0]);

  const endpoint = id(); const delivery = id();
  await pool.query(`INSERT INTO access.notification_endpoint (id, principal_id, channel, generation, state,
    address_digest) VALUES ($1, $2, 'email', 1, 'active', $3)`, [endpoint, principal, digest('d')]);
  await pool.query(`INSERT INTO access.notification_delivery (id, item_id, principal_id, endpoint_id, channel,
    endpoint_generation, next_attempt_at, expires_at) VALUES ($1, $2, $3, $4, 'email', 1, now(),
    now() + interval '1 day')`, [delivery, itemId, principal, endpoint]);
  const lease = id();
  await pool.query(`UPDATE access.notification_delivery SET state = 'sending', next_attempt_at = NULL,
    lease_token = $2, lease_until = now() + interval '1 minute', attempt_count = 1 WHERE id = $1`, [delivery, lease]);
  await pool.query(`INSERT INTO access.notification_attempt (delivery_id, attempt, lease_token, address_digest,
    disclosure_digest) VALUES ($1, 1, $2, $3, $4)`, [delivery, lease, digest('d'), digest('e')]);
  await pool.query(`UPDATE access.notification_attempt SET outcome = 'uncertain', finished_at = now()
    WHERE delivery_id = $1`, [delivery]);
  await rejects(pool, "UPDATE access.notification_attempt SET outcome = 'accepted' WHERE delivery_id = $1",
    [delivery], '23514');
  await pool.query(`UPDATE access.notification_delivery SET state = 'uncertain', lease_token = NULL,
    lease_until = NULL, next_attempt_at = now() WHERE id = $1`, [delivery]);
  const callback = `INSERT INTO access.notification_provider_event (provider, provider_event_id, delivery_id,
    source, kind, payload_digest) VALUES ('fake', 'evt-1', $1, 'callback', 'delivered', $2)`;
  await pool.query(callback, [delivery, digest('f')]);
  await rejects(pool, callback, [delivery, digest('f')], '23505');
  await pool.query(`UPDATE access.notification_delivery SET state = 'cancelled', cancel_reason = 'unsubscribed',
    next_attempt_at = NULL, terminal_at = now() WHERE id = $1`, [delivery]);
  // Rotation, resubscribe or a late callback cannot reactivate a cancelled delivery.
  await rejects(pool, `UPDATE access.notification_delivery SET state = 'pending', cancel_reason = NULL,
    terminal_at = NULL, next_attempt_at = now() WHERE id = $1`, [delivery], '23514');
  await pool.query(`UPDATE access.notification_endpoint SET state = 'retired', retired_at = now()
    WHERE id = $1`, [endpoint]);
  await rejects(pool, "UPDATE access.notification_endpoint SET state = 'active', retired_at = NULL WHERE id = $1",
    [endpoint], '23514');
  await pool.query("UPDATE access.notification_item SET state = 'erased', state_changed_at = now() WHERE id = $1",
    [itemId]);
  await rejects(pool, "UPDATE access.notification_item SET state = 'active', state_changed_at = NULL WHERE id = $1",
    [itemId], '23514');
});

test('LIVE13-LIVE17 schema foundation: Content 080 installs empty and upgrades from head through the runner', async () => {
  await expectDeclared(contentEmpty, rightsTables);
  const pool = contentUpgrade;
  const record = upgradedRecord;
  await expectDeclared(pool, rightsTables);
  expect((await pool.query('SELECT count(*)::int AS n FROM source.observation WHERE record_id = $1', [record]))
    .rows[0].n).toBe(1);
  expect((await pool.query('SELECT max(version)::int AS version FROM content.schema_migration')).rows[0].version)
    .toBe(Number(files(contentDir).at(-1)!.slice(0, 3)));

  const synopsis = id(); const facts = id(); const terms = id(); const principal = id();
  const material = `INSERT INTO rights.material (id, scope_kind, source_record_id, provider, namespace, component,
    expression_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  await pool.query(material, [synopsis, 'source_record', record, null, null, 'synopsis', 'expression']);
  await pool.query(material, [facts, 'source_record', record, null, null, 'record', 'fact']);
  await pool.query(material, [terms, 'source_provider', null, 'openlibrary', 'works', 'api', 'service']);
  await rejects(pool, material, [id(), 'source_record', record, null, null, 'synopsis', 'expression'], '23505');

  const assess = `INSERT INTO rights.use_assessment (id, material_id, family, use_kind, use_scope, basis,
    outcome, license_instrument, exception_kind, rationale, extent, evidence, predecessor_id, principal_id,
    idempotency_key, request_digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}', $12, $13, $14, $15)`;
  let key = 0;
  const row = (assessment: string, materialId: string, family: string, use: string, scope: string, basis: string,
    outcome: string, extra: { license?: string; exception?: string; rationale?: string; extent?: object;
      predecessor?: string } = {}) => [assessment, materialId, family, use, scope, basis, outcome,
    extra.license ?? null, extra.exception ?? null, extra.rationale ?? null, extra.extent ?? {},
    extra.predecessor ?? null, principal, `assess-${++key}`, digest('1')];
  // Unknown rights stay undetermined; neither permission nor unlawfulness is fabricated.
  await rejects(pool, assess, row(id(), synopsis, 'data_rights', 'wiki_display', 'wiki', 'unknown', 'supported'),
    '23514');
  const unknown = id();
  await pool.query(assess, row(unknown, synopsis, 'data_rights', 'wiki_display', 'wiki', 'unknown', 'undetermined'));
  await pool.query('INSERT INTO rights.use_assessment_head VALUES ($1, $2, $3, $4, $5, 1)',
    [synopsis, 'data_rights', 'wiki_display', 'wiki', unknown]);
  // Fair use keeps its rationale and extent; a full export is a different key.
  await rejects(pool, assess, row(id(), synopsis, 'data_rights', 'quotation', 'wiki', 'statutory_exception',
    'supported', { exception: 'fair_use' }), '23514');
  await pool.query(assess, row(id(), synopsis, 'data_rights', 'quotation', 'wiki', 'statutory_exception',
    'supported', { exception: 'fair_use', rationale: 'Bounded commentary quotation.', extent: { words: 40 } }));
  const nc = id();
  await pool.query(assess, row(nc, synopsis, 'data_rights', 'wiki_display', 'wiki', 'license', 'conditional',
    { license: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', predecessor: unknown }));
  await pool.query(`INSERT INTO rights.obligation (assessment_id, ordinal, kind, instrument, applies_to, notice)
    VALUES ($1, 1, 'share_alike', 'https://creativecommons.org/licenses/by-nc-sa/4.0/', 'all', 'Share alike.')`,
  [nc]);
  await pool.query(`UPDATE rights.use_assessment_head SET assessment_id = $2, revision = 2
    WHERE material_id = $1 AND use_kind = 'wiki_display'`, [synopsis, nc]);
  const product = id();
  await pool.query(assess, row(product, synopsis, 'data_rights', 'paid_data_product', 'feed', 'unknown',
    'undetermined'));
  // A changed use never becomes the successor of the earlier use's conclusion.
  await rejects(pool, `UPDATE rights.use_assessment_head SET assessment_id = $2, revision = 3
    WHERE material_id = $1 AND use_kind = 'wiki_display'`, [synopsis, product], '23514');
  await rejects(pool, assess, row(id(), terms, 'service_terms', 'raw_retention', 'capture', 'unknown',
    'undetermined'), '23514');
  await pool.query(assess, row(id(), terms, 'service_terms', 'raw_retention', 'capture', 'service_terms',
    'not_supported'));
  await rejects(pool, 'UPDATE rights.use_assessment SET outcome = $2 WHERE id = $1', [nc, 'supported'], '23514');
});
