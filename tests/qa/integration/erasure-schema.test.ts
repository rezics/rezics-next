import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../support/postgres-cluster.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { contentErasureTables, DESTRUCTION_STATUSES, DISPOSITION_DESTRUCTION,
  DISPOSITION_SUPPRESSION, ERASURE_AUTHORITIES, ERASURE_KINDS, ERASURE_STAGES,
  ERASURE_TARGET_OWNERS, erasureTables, RETENTION_CUSTODY, RETENTION_DOMAIN_STATES,
  RETENTION_OWNERS, RETENTION_STORES, SUPPRESSION_STATUSES } from '../../../services/main/src/modules/erasure/schema.ts';
import { EXPORT_BASIS_KINDS, EXPORT_COMPLETENESS, EXPORT_LICENSE_SCOPES, EXPORT_MAPPINGS,
  EXPORT_OBLIGATIONS, EXPORT_RESIDUAL_KINDS, EXPORT_SOURCE_GRAINS, EXPORT_SOURCE_OWNERS,
  EXPORT_STATES, EXPORT_USE_SCOPES, exportTables } from '../../../services/main/src/modules/export/schema.ts';
import { CUT_STATUSES, ownerTables, RECONCILIATION_DISPOSITIONS, RECONCILIATION_ITEM_KINDS,
  RECONCILIATION_KINDS, RECONCILIATION_OWNERS, RECONCILIATION_STATES, RELOCATION_OWNERS,
  RELOCATION_STATES } from '../../../services/main/src/modules/owner/schema.ts';

// Phase-A owner schema for IAM11, OPS03/04/10-12, MODEL07/11/12/25/26, SYS04/12,
// COMP07/08, LIVE07/10/15/17 and FACT05. Titles deliberately carry no leading
// acceptance ID: a schema proof closes no case by itself.
const root = resolve(import.meta.dir, '../../..');
const relayDirectory = join(root, 'services/main/migrations/relay');
const ownRelay = /^01\d_/;
const ownContent = /^12\d_/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

let cluster: PostgresCluster | undefined;
let admin: Pool | undefined;
const pools: Pool[] = [];

async function database(name: string): Promise<Pool> {
  await admin!.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ ...cluster!.connection, database: name, max: 4 });
  pools.push(pool);
  return pool;
}

function relayFiles(filter: (name: string) => boolean): string[] {
  return schemaFiles(root, 'relay').filter(filter);
}

/** Same application as the QA bootstrap: one file per implicit transaction. */
async function applyRelay(pool: Pool, files: string[]): Promise<void> {
  for (const file of files) await pool.query(readFileSync(join(relayDirectory, file), 'utf8'));
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/** Columns in PostgreSQL match the typed row declaration exactly. */
async function expectColumns(pool: Pool, tables: Record<string, Record<string, true>>) {
  for (const [qualified, columns] of Object.entries(tables)) {
    const [schema, table] = qualified.split('.');
    const actual = (await pool.query<{ name: string }>(`SELECT column_name AS name
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table])).rows.map(row => row.name).sort();
    expect({ qualified, columns: actual }).toEqual({ qualified, columns: Object.keys(columns).sort() });
  }
}

/** The single-column IN-list CHECK equals the exported TypeScript value list. */
async function expectValues(pool: Pool, table: string, column: string, values: readonly string[]) {
  const definitions = (await pool.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [table])).rows;
  const pattern = new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY\\[(.*)\\]\\)\\)\\)$`);
  const lists = definitions.map(row => pattern.exec(row.def)?.[1]).filter(Boolean) as string[];
  expect({ table, column, found: lists.length }).toEqual({ table, column, found: 1 });
  const actual = [...lists[0]!.matchAll(/'([^']*)'::text/g)].map(match => match[1]);
  expect({ table, column, values: actual }).toEqual({ table, column, values: [...values] });
}

async function usesIndex(pool: Pool, sql: string, params: unknown[], index: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows
      .map(row => row['QUERY PLAN']).join('\n');
    expect(plan).toContain(index);
    await client.query('ROLLBACK');
  } finally { client.release(); }
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
}, 60_000);

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  await admin?.end();
  cluster?.remove();
}, 60_000);

test('erasure journal schema installs empty, upgrades current head and allocates commit-ordered epochs', async () => {
  const fresh = await database('relay_fresh');
  await applyRelay(fresh, relayFiles(() => true));
  await expectColumns(fresh, { ...erasureTables, ...ownerTables });
  await expectValues(fresh, 'relay.erasure', 'stage', ERASURE_STAGES);
  await expectValues(fresh, 'relay.erasure', 'kind', ERASURE_KINDS);
  await expectValues(fresh, 'relay.erasure', 'authority', ERASURE_AUTHORITIES);
  await expectValues(fresh, 'relay.erasure', 'suppression_status', SUPPRESSION_STATUSES);
  await expectValues(fresh, 'relay.erasure', 'destruction_status', DESTRUCTION_STATUSES);
  await expectValues(fresh, 'relay.retention_domain', 'owner', RETENTION_OWNERS);
  await expectValues(fresh, 'relay.retention_domain', 'store', RETENTION_STORES);
  await expectValues(fresh, 'relay.retention_domain', 'custody', RETENTION_CUSTODY);
  await expectValues(fresh, 'relay.retention_domain', 'state', RETENTION_DOMAIN_STATES);
  await expectValues(fresh, 'relay.erasure_disposition', 'suppression', DISPOSITION_SUPPRESSION);
  await expectValues(fresh, 'relay.erasure_disposition', 'destruction', DISPOSITION_DESTRUCTION);
  await expectValues(fresh, 'relay.owner_relocation', 'owner', RELOCATION_OWNERS);
  await expectValues(fresh, 'relay.owner_relocation', 'state', RELOCATION_STATES);
  await expectValues(fresh, 'relay.owner_reconciliation', 'kind', RECONCILIATION_KINDS);
  await expectValues(fresh, 'relay.owner_reconciliation', 'state', RECONCILIATION_STATES);
  await expectValues(fresh, 'relay.owner_reconciliation_cut', 'owner', RECONCILIATION_OWNERS);
  await expectValues(fresh, 'relay.owner_reconciliation_cut', 'status', CUT_STATUSES);
  await expectValues(fresh, 'relay.owner_reconciliation_item', 'item_kind', RECONCILIATION_ITEM_KINDS);
  await expectValues(fresh, 'relay.owner_reconciliation_item', 'disposition', RECONCILIATION_DISPOSITIONS);
  expect((await fresh.query('SELECT count(*)::int AS n FROM relay.erasure')).rows[0].n).toBe(0);

  // A relay at the current head already retains Account deletion tombstones and a capture.
  const head = await database('relay_head');
  const before = relayFiles(name => !ownRelay.test(name));
  expect(before.length).toBeGreaterThan(0);
  await applyRelay(head, before);
  const issuer = 'https://account.rezics.test';
  const principal = randomUUID();
  await head.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ('graph', $1, 7)`,
    [randomUUID()]);
  await head.query(`INSERT INTO relay.recovery_coverage_head (consumer, coverage_digest)
    VALUES ('graph', $1)`, [digest('capture-1')]);
  await head.query(`INSERT INTO relay.account_deletion_intent (outbox_id, principal_id, authority_epoch)
    VALUES ($1, $2, 3)`, [randomUUID(), principal]);
  await head.query(`INSERT INTO relay.account_subject_deletion (issuer, account_subject, retained_at)
    VALUES ($1, 'subject-b', '2026-09-01T00:00:00Z'), ($1, 'subject-a', '2026-09-02T00:00:00Z')`, [issuer]);
  await applyRelay(head, relayFiles(name => ownRelay.test(name)));
  expect((await head.query(`SELECT consumer, coverage_digest, coverage_generation::text
    FROM relay.current_authority_coverage`)).rows).toEqual([
    { consumer: 'graph', coverage_digest: digest('capture-1'), coverage_generation: '1' },
  ]);

  const journal = (await head.query<{ erasure_epoch: string; operation_id: string; request_digest: string;
    account_subject: string; stage: string; suppression_status: string; kind: string }>(
    `SELECT erasure_epoch::text, operation_id, request_digest, account_subject, stage,
       suppression_status, kind FROM relay.erasure ORDER BY erasure_epoch`)).rows;
  expect(journal).toEqual(['subject-b', 'subject-a'].map((subject, index) => ({
    erasure_epoch: String(index + 1), kind: 'account', account_subject: subject,
    operation_id: `account-subject-deletion:${digest(`${issuer}\n${subject}`)}`,
    request_digest: digest(`${issuer}\n${subject}`), stage: 'requested', suppression_status: 'pending',
  })));

  // The existing coverage-head writer still upserts; the new epoch never regresses.
  const upsert = `INSERT INTO relay.recovery_coverage_head (consumer, coverage_digest)
    VALUES ($1, $2) ON CONFLICT (consumer) DO UPDATE SET
      coverage_digest = EXCLUDED.coverage_digest,
      generation = relay.recovery_coverage_head.generation + 1, captured_at = clock_timestamp()`;
  await head.query(upsert, ['graph', digest('capture-2')]);
  expect((await head.query(`SELECT generation::text, erasure_epoch FROM relay.recovery_coverage_head`))
    .rows[0]).toEqual({ generation: '2', erasure_epoch: null });
  expect((await head.query(`SELECT coverage_digest, coverage_generation::text
    FROM relay.current_authority_coverage`)).rows[0]).toEqual({
    coverage_digest: digest('capture-2'), coverage_generation: '2',
  });
  await head.query(`UPDATE relay.recovery_coverage_head SET erasure_epoch = 2`);
  await head.query(upsert, ['graph', digest('capture-3')]);
  expect((await head.query(`SELECT erasure_epoch::text FROM relay.recovery_coverage_head`)).rows[0]
    .erasure_epoch).toBe('2');
  await rejects(head.query(`UPDATE relay.recovery_coverage_head SET erasure_epoch = 1`), '23514');
  await rejects(head.query(`UPDATE relay.recovery_coverage_head SET erasure_epoch = NULL`), '23514');
  await rejects(head.query(`UPDATE relay.recovery_coverage_head SET erasure_epoch = 99`), '23503');

  // New tombstones journal themselves once; a replayed retain inserts nothing.
  const retain = `INSERT INTO relay.account_subject_deletion (issuer, account_subject)
    VALUES ($1, $2) ON CONFLICT DO NOTHING`;
  expect((await head.query(retain, [issuer, 'subject-c'])).rowCount).toBe(1);
  expect((await head.query(retain, [issuer, 'subject-c'])).rowCount).toBe(0);
  expect((await head.query(`SELECT erasure_epoch::text FROM relay.erasure WHERE account_subject = 'subject-c'`))
    .rows).toEqual([{ erasure_epoch: '3' }]);

  // Concurrent writers serialize on the allocator; a rollback leaves no gap.
  const first = await head.connect();
  const second = await head.connect();
  try {
    await first.query('BEGIN');
    await first.query(retain, [issuer, 'subject-d']);
    await second.query('BEGIN');
    let secondDone = false;
    const waiting = second.query(retain, [issuer, 'subject-e']).then(result => { secondDone = true; return result; });
    await Bun.sleep(200);
    expect(secondDone).toBe(false);
    await first.query('COMMIT');
    await waiting;
    await second.query('COMMIT');
    await first.query('BEGIN');
    await first.query(retain, [issuer, 'subject-f']);
    await first.query('ROLLBACK');
  } finally { first.release(); second.release(); }
  await head.query(retain, [issuer, 'subject-g']);
  expect((await head.query(`SELECT account_subject, erasure_epoch::text FROM relay.erasure
    WHERE erasure_epoch > 3 ORDER BY erasure_epoch`)).rows).toEqual([
    { account_subject: 'subject-d', erasure_epoch: '4' },
    { account_subject: 'subject-e', erasure_epoch: '5' },
    { account_subject: 'subject-g', erasure_epoch: '6' }]);

  // The optional principal link must name the retained Access deletion intent.
  await head.query(`UPDATE relay.erasure SET deleted_principal_id = $1 WHERE account_subject = 'subject-a'`,
    [principal]);
  await rejects(head.query(`UPDATE relay.erasure SET deleted_principal_id = $1 WHERE account_subject = 'subject-b'`,
    [randomUUID()]), '23503');
  await rejects(head.query(`UPDATE relay.erasure SET deleted_principal_id = NULL WHERE account_subject = 'subject-a'`),
    '23514');
}, 60_000);

test('erasure lifecycle reports suppression and destruction separately per retention domain', async () => {
  const relay = await database('relay_erasure');
  await applyRelay(relay, relayFiles(() => true));
  const insert = (id: string, epoch = 'relay.next_erasure_epoch()') => relay.query(`INSERT INTO relay.erasure
    (id, erasure_epoch, operation_id, request_digest, kind, authority, principal_id, admission_id, authority_epoch)
    VALUES ($1, ${epoch}, $2, $3, 'revision', 'access_admission', $4, $5, 9)`,
  [id, `erasure:${id}`, digest(id), randomUUID(), randomUUID()]);
  const erasure = randomUUID();
  await insert(erasure);
  // Authority is explicit; kind and Account references stay consistent.
  await rejects(relay.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest,
    kind, authority) VALUES ($1, 50, 'no-admission', $2, 'revision', 'access_admission')`,
  [randomUUID(), digest('a')]), '23514');
  await rejects(relay.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest,
    kind, authority, principal_id, admission_id, authority_epoch)
    VALUES ($1, 51, 'account-without-tombstone', $2, 'account', 'access_admission', $3, $4, 1)`,
  [randomUUID(), digest('b'), randomUUID(), randomUUID()]), '23514');
  await rejects(insert(randomUUID(), '1'), '23505');

  // Fencing needs suppression; verification needs a terminal destruction report.
  await rejects(relay.query(`UPDATE relay.erasure SET stage = 'fenced' WHERE id = $1`, [erasure]), '23514');
  await relay.query(`UPDATE relay.erasure SET stage = 'fenced', suppression_status = 'suppressed',
    suppressed_at = clock_timestamp() WHERE id = $1`, [erasure]);
  await rejects(relay.query(`UPDATE relay.erasure SET stage = 'verified', verified_at = clock_timestamp()
    WHERE id = $1`, [erasure]), '23514');
  await rejects(relay.query(`UPDATE relay.erasure SET destruction_status = 'blocked' WHERE id = $1`, [erasure]),
    '23514');
  await rejects(relay.query(`UPDATE relay.erasure SET suppression_status = 'pending', suppressed_at = NULL,
    stage = 'blocked', blocked_reason = 'hold' WHERE id = $1`, [erasure]), '23514');
  await rejects(relay.query(`UPDATE relay.erasure SET request_digest = $2 WHERE id = $1`,
    [erasure, digest('changed')]), '23514');
  await rejects(relay.query('DELETE FROM relay.erasure WHERE id = $1', [erasure]), '23514');

  // Exact targets are owner-bound and immutable.
  await relay.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    SELECT $1, row_number() OVER (), owner, kind, 'ref:' || kind
    FROM jsonb_each_text($2::jsonb) AS pair(kind, owner)`, [erasure, JSON.stringify(ERASURE_TARGET_OWNERS)]);
  await rejects(relay.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 20, 'graph', 'content_revision', 'mismatch')`, [erasure]), '23514');
  await rejects(relay.query(`UPDATE relay.erasure_target SET target_ref = 'retargeted' WHERE erasure_id = $1`,
    [erasure]), '23514');
  await usesIndex(relay, `SELECT erasure_id FROM relay.erasure_target
    WHERE owner = $1 AND target_kind = $2 AND target_ref = $3`, ['content', 'content_revision', 'ref:x'],
  'erasure_target_ref');

  // Backups declare expiry or hold; each domain carries its own disposition.
  await rejects(relay.query(`INSERT INTO relay.retention_domain (id, label, owner, store, custody)
    VALUES ($1, 'content:backup:unbounded', 'content', 'postgresql', 'backup')`, [randomUUID()]), '23514');
  const live = randomUUID();
  const backup = randomUUID();
  await relay.query(`INSERT INTO relay.retention_domain (id, label, owner, store, custody, expires_at)
    VALUES ($1, 'content:live', 'content', 'postgresql', 'live', NULL),
           ($2, 'content:backup:2026-09-26', 'content', 'postgresql', 'backup', '2026-12-26T00:00:00Z')`,
  [live, backup]);
  await relay.query(`INSERT INTO relay.erasure_disposition (erasure_id, domain_id, suppression, destruction)
    VALUES ($1, $2, 'suppressed', 'pending'), ($1, $3, 'not_applicable', 'pending')`, [erasure, live, backup]);
  await rejects(relay.query(`UPDATE relay.erasure_disposition SET destruction = 'destroyed'
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, live]), '23514');
  await rejects(relay.query(`UPDATE relay.erasure_disposition SET destruction = 'retained'
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, backup]), '23514');
  await relay.query(`UPDATE relay.erasure_disposition SET destruction = 'destroyed', evidence_digest = $3
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, live, digest('vacuum-and-probe')]);
  await relay.query(`UPDATE relay.erasure_disposition SET destruction = 'retained',
    retained_until = '2026-12-26T00:00:00Z' WHERE erasure_id = $1 AND domain_id = $2`, [erasure, backup]);
  await rejects(relay.query(`UPDATE relay.erasure_disposition SET destruction = 'pending', evidence_digest = NULL
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, live]), '23514');
  await rejects(relay.query(`UPDATE relay.erasure_disposition SET suppression = 'pending'
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, live]), '23514');
  await usesIndex(relay, `SELECT erasure_id FROM relay.erasure_disposition
    WHERE domain_id = $1 AND destruction = 'retained'`, [backup], 'erasure_disposition_domain');
  const snapshot = randomUUID();
  await relay.query(`INSERT INTO relay.retention_domain
    (id, label, owner, store, custody, hold_reason)
    VALUES ($1, 'graph:snapshot:unverified', 'graph', 'snapshot', 'archive',
      'destruction evidence is required')`, [snapshot]);
  await rejects(relay.query(`INSERT INTO relay.erasure_disposition
    (erasure_id, domain_id, suppression, destruction)
    VALUES ($1, $2, 'not_applicable', 'unverified')`, [erasure, snapshot]), '23514');
  await relay.query(`INSERT INTO relay.erasure_disposition
    (erasure_id, domain_id, suppression, destruction, reason)
    VALUES ($1, $2, 'not_applicable', 'unverified', 'destruction evidence is required')`,
  [erasure, snapshot]);
  await rejects(relay.query(`UPDATE relay.erasure_disposition SET destruction = 'destroyed'
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, snapshot]), '23514');
  await relay.query(`UPDATE relay.erasure_disposition
    SET destruction = 'destroyed', evidence_digest = $3
    WHERE erasure_id = $1 AND domain_id = $2`, [erasure, snapshot, digest('snapshot-erasure')]);

  // Verified completion may keep an explicitly retained backup copy.
  await relay.query(`UPDATE relay.erasure SET stage = 'verified', destruction_status = 'retained',
    verified_at = clock_timestamp() WHERE id = $1`, [erasure]);
  expect((await relay.query(`SELECT stage, suppression_status, destruction_status FROM relay.erasure
    WHERE id = $1`, [erasure])).rows[0]).toEqual({ stage: 'verified', suppression_status: 'suppressed',
    destruction_status: 'retained' });
}, 60_000);

test('owner relocation and reconciliation schema retain frontiers, evidence and explicit dispositions', async () => {
  const relay = await database('relay_owner');
  await applyRelay(relay, relayFiles(() => true));
  await relay.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ('graph', 'epoch-a', 5)`);
  const move = randomUUID();
  await relay.query(`INSERT INTO relay.owner_relocation (id, operation_id, request_digest, owner, dataset_id,
    source_location, target_location, source_routing_epoch)
    VALUES ($1, 'move-1', $2, 'graph', 'product', 'fuseki://old', 'fuseki://new', 'route-1')`, [move, digest('move')]);
  await rejects(relay.query(`INSERT INTO relay.owner_relocation (id, operation_id, request_digest, owner,
    dataset_id, source_location, target_location, source_routing_epoch)
    VALUES ($1, 'move-2', $2, 'graph', 'product', 'fuseki://old', 'fuseki://other', 'route-1')`,
  [randomUUID(), digest('move-2')]), '23505');
  // Activation without the verified frontier, anchors and objects is rejected.
  await rejects(relay.query(`UPDATE relay.owner_relocation SET state = 'activated', activated_at = clock_timestamp(),
    target_routing_epoch = 'route-2' WHERE id = $1`, [move]), '23514');
  await rejects(relay.query(`UPDATE relay.owner_relocation SET state = 'activated', activated_at = clock_timestamp(),
    target_routing_epoch = 'route-2', source_data_epoch = 'epoch-a', source_sequence = 5,
    target_data_epoch = 'epoch-a', anchor_count = 3, anchor_digest = $2, object_count = 4, object_digest = $3
    WHERE id = $1`, [move, digest('anchors'), digest('objects')]), '23514');
  await relay.query(`UPDATE relay.owner_relocation SET state = 'activated', activated_at = clock_timestamp(),
    target_routing_epoch = 'route-2', source_data_epoch = 'epoch-a', source_sequence = 5,
    target_data_epoch = 'epoch-b', anchor_count = 3, anchor_digest = $2, object_count = 4, object_digest = $3
    WHERE id = $1`, [move, digest('anchors'), digest('objects')]);
  await rejects(relay.query(`UPDATE relay.owner_relocation SET anchor_digest = $2 WHERE id = $1`,
    [move, digest('other')]), '23514');
  await relay.query(`UPDATE relay.owner_relocation SET state = 'retaining', retain_until = clock_timestamp() + interval '1 day'
    WHERE id = $1`, [move]);
  await rejects(relay.query(`UPDATE relay.owner_relocation SET state = 'collected', collected_at = clock_timestamp()
    WHERE id = $1`, [move]), '23514');

  // Reconciliation references its relocation, records each owner cut and appends findings.
  const pass = randomUUID();
  await rejects(relay.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind, scope)
    VALUES ($1, 'orphan', $2, 'relocation', 'product')`, [randomUUID(), digest('orphan')]), '23514');
  await relay.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind, scope,
    relocation_id) VALUES ($1, 'reconcile-move', $2, 'relocation', 'product', $3)`, [pass, digest('pass'), move]);
  await rejects(relay.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind, scope,
    relocation_id) VALUES ($1, 'reconcile-again', $2, 'relocation', 'product', $3)`,
  [randomUUID(), digest('again'), move]), '23505');
  await relay.query(`INSERT INTO relay.owner_reconciliation_cut (reconciliation_id, owner, data_epoch, sequence,
    coverage_digest, status) VALUES ($1, 'graph', 'epoch-a', 5, $2, 'matched')`, [pass, digest('cut')]);
  await rejects(relay.query(`INSERT INTO relay.owner_reconciliation_cut (reconciliation_id, owner, status)
    VALUES ($1, 'content', 'behind')`, [pass]), '23514');
  await relay.query(`INSERT INTO relay.owner_reconciliation_item (reconciliation_id, ordinal, owner, item_kind,
    item_ref, disposition, evidence_digest) VALUES ($1, 1, 'graph', 'anchor', 'urn:rev:1', 'preserved', $2),
    ($1, 2, 'object', 'payload', 'sha256:missing', 'unavailable', NULL)`, [pass, digest('anchor')]);
  await rejects(relay.query(`INSERT INTO relay.owner_reconciliation_item (reconciliation_id, ordinal, owner,
    item_kind, item_ref, disposition) VALUES ($1, 3, 'graph', 'revision', 'urn:rev:2', 'rebuilt')`, [pass]), '23514');
  await rejects(relay.query(`UPDATE relay.owner_reconciliation_item SET disposition = 'matched'
    WHERE reconciliation_id = $1`, [pass]), '23514');
  await usesIndex(relay, `SELECT ordinal FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
    AND disposition IN ('unavailable', 'corrupt', 'gap', 'conflict') ORDER BY ordinal LIMIT 51`, [pass],
  'owner_reconciliation_item_open');
  await rejects(relay.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled', completed_at = clock_timestamp()
    WHERE id = $1`, [pass]), '23514');
  await relay.query(`UPDATE relay.owner_reconciliation SET state = 'held', hold_reason = 'missing payload'
    WHERE id = $1`, [pass]);

  // A restore without a retained signed capture cannot be marked reconciled.
  const restore = randomUUID();
  await relay.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind, scope, consumer)
    VALUES ($1, 'restore-1', $2, 'restore', 'product', 'graph')`, [restore, digest('restore')]);
  await rejects(relay.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled',
    completed_at = clock_timestamp(), outcome_digest = $2 WHERE id = $1`, [restore, digest('outcome')]), '23514');
  await relay.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled', coverage_generation = 1,
    completed_at = clock_timestamp(), outcome_digest = $2 WHERE id = $1`, [restore, digest('outcome')]);
  await rejects(relay.query(`UPDATE relay.owner_reconciliation SET state = 'held', hold_reason = 'reopen',
    completed_at = NULL WHERE id = $1`, [restore]), '23514');
  await rejects(relay.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind, scope,
    format_from, format_to) VALUES ($1, 'upgrade-same', $2, 'format_upgrade', 'product', 'v1', 'v1')`,
  [randomUUID(), digest('upgrade')]), '23514');
  await usesIndex(relay, `SELECT id FROM relay.owner_reconciliation WHERE kind = $1 AND scope = $2
    AND state = 'running'`, ['restore', 'product'], 'owner_reconciliation_running');
}, 60_000);

test('Content erasure tombstone and export owner install empty and upgrade current head', async () => {
  const fresh = await database('content_fresh');
  await migrateContent(fresh);
  await migrateContent(fresh);
  await expectColumns(fresh, { ...contentErasureTables, ...exportTables });
  await expectValues(fresh, 'export.manifest', 'use_scope', EXPORT_USE_SCOPES);
  await expectValues(fresh, 'export.manifest', 'state', EXPORT_STATES);
  await expectValues(fresh, 'export.manifest', 'completeness', EXPORT_COMPLETENESS);
  await expectValues(fresh, 'export.manifest', 'license_scope', EXPORT_LICENSE_SCOPES);
  await expectValues(fresh, 'export.member', 'source_owner', EXPORT_SOURCE_OWNERS);
  await expectValues(fresh, 'export.member', 'source_grain', EXPORT_SOURCE_GRAINS);
  await expectValues(fresh, 'export.member', 'mapping', EXPORT_MAPPINGS);
  await expectValues(fresh, 'export.residual', 'kind', EXPORT_RESIDUAL_KINDS);
  await expectValues(fresh, 'export.rights_basis', 'basis_kind', EXPORT_BASIS_KINDS);

  // Upgrade a Content owner recorded at the current head through the same runner.
  const content = await database('content_head');
  const directory = join(root, 'services/content/migrations');
  const headFiles = schemaFiles(root, 'content').filter(name => !ownContent.test(name)
    && migrationVersion(name) < 120);
  await content.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of headFiles) {
    await content.query(readFileSync(join(directory, file), 'utf8'));
    await content.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [migrationVersion(file)]);
  }
  const revisions = [randomUUID(), randomUUID()];
  await content.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ('urn:variant:1', 'urn:work:1', 'und', 'none')`);
  for (const [index, id] of revisions.entries()) {
    const bytes = `{"body":"revision ${index}"}`;
    await content.query(`INSERT INTO content.revision (id, variant_id, predecessor, operation_id, format, model,
      provenance, byte_digest, byte_length, serialized_bytes, body)
      VALUES ($1, 'urn:variant:1', $2, $3, 'rezics-content-json-v1', 'content-shape-v1', '{}', $4, $5,
        convert_to($6::text, 'UTF8'), $6::text::jsonb)`,
    [id, index ? revisions[0] : null, `save-${index}`, digest(bytes), Buffer.byteLength(bytes), bytes]);
  }
  await migrateContent(content);
  await migrateContent(content);
  const applied = (await content.query<{ version: number }>(
    'SELECT version FROM content.schema_migration ORDER BY version')).rows.map(row => row.version);
  expect(applied).toEqual((await fresh.query<{ version: number }>(
    'SELECT version FROM content.schema_migration ORDER BY version')).rows.map(row => row.version));
  expect(applied).toEqual(expect.arrayContaining([120, 121, 122]));
  await usesIndex(content, `SELECT operation_id FROM content.publication_erasure_supersession
    WHERE revision_id = $1`, [revisions[0]], 'publication_erasure_supersession_revision_idx');

  // A tombstone commits only with the revision's erased transition, then never changes.
  await rejects(content.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, 1)`, [revisions[0], randomUUID()]), '23514');
  const client = await content.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 1)`, [revisions[0], randomUUID()]);
    await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [revisions[0]]);
    await client.query('COMMIT');
  } finally { client.release(); }
  await rejects(content.query('DELETE FROM content.revision_erasure WHERE revision_id = $1', [revisions[0]]),
    '23514');
  await usesIndex(content, `SELECT revision_id FROM content.revision_erasure WHERE erasure_epoch > $1
    ORDER BY erasure_epoch, revision_id LIMIT 51`, [0], 'revision_erasure_epoch_idx');

  // Export: exact pinned members at their own owner positions, residuals and per-export bases.
  const manifest = randomUUID();
  const principal = randomUUID();
  await content.query(`INSERT INTO export.manifest (id, principal_id, idempotency_key, request_digest, admission_id,
    authority_epoch, target_profile, use_scope) VALUES ($1, $2, 'export-1', $3, $4, 4, 'rezics-jsonld-v1', 'quotation')`,
  [manifest, principal, digest('export'), randomUUID()]);
  await rejects(content.query(`INSERT INTO export.manifest (id, principal_id, idempotency_key, request_digest,
    admission_id, authority_epoch, target_profile, use_scope)
    VALUES ($1, $2, 'export-1', $3, $4, 4, 'rezics-jsonld-v1', 'full')`,
  [randomUUID(), principal, digest('export-2'), randomUUID()]), '23505');
  await rejects(content.query(`INSERT INTO export.member (manifest_id, ordinal, source_owner, source_namespace,
    source_grain, exact_ref, content_revision_id, ref_digest, owner_data_epoch, owner_sequence, target_grain, mapping)
    VALUES ($1, 1, 'content', 'native', 'content_revision', 'not-the-revision', $2, $3, 'content-epoch', 2,
      'schema:Quotation', 'exact')`, [manifest, revisions[1], digest('member')]), '23514');
  await content.query(`INSERT INTO export.member (manifest_id, ordinal, source_owner, source_namespace, source_grain,
    exact_ref, content_revision_id, ref_digest, owner_data_epoch, owner_sequence, source_position, target_grain, mapping)
    VALUES ($1, 1, 'content', 'native', 'content_revision', $2::text, $2::uuid, $3, 'content-epoch', 2, 'block:4',
            'schema:Quotation', 'exact'),
           ($1, 2, 'graph', 'https://musicbrainz.org', 'external_release', 'urn:rev:release:1', NULL, $4, 'graph-epoch', 9,
            NULL, NULL, 'unmapped')`, [manifest, revisions[1], digest('member'), digest('release')]);
  await content.query(`INSERT INTO export.residual (manifest_id, ordinal, member_ordinal, kind, path, detail)
    VALUES ($1, 1, 2, 'unmapped_grain', 'release', '{"reason":"no edition parent"}')`, [manifest]);
  await rejects(content.query(`INSERT INTO export.rights_basis (manifest_id, ordinal, basis_kind)
    VALUES ($1, 1, 'statutory_exception')`, [manifest]), '23514');
  await rejects(content.query(`INSERT INTO export.rights_basis (manifest_id, ordinal, basis_kind, basis_ref, obligations)
    VALUES ($1, 1, 'use_assessment', 'urn:rights:assessment:1', ARRAY['corporate_status'])`, [manifest]), '23514');
  const seal = `UPDATE export.manifest SET state = 'sealed', sealed_at = clock_timestamp(), manifest_digest = $2,
    completeness = 'complete', license_scope = 'uncertain', member_count = 2, residual_count = 1 WHERE id = $1`;
  await rejects(content.query(seal, [manifest, digest('bytes')]), '23514');
  await content.query(`INSERT INTO export.rights_basis (manifest_id, ordinal, basis_kind, basis_ref, notice, obligations)
    VALUES ($1, 1, 'use_assessment', 'urn:rights:assessment:1', 'Quoted under documented fair use', $2)`,
  [manifest, [...EXPORT_OBLIGATIONS].filter(value => value === 'attribution' || value === 'notice_retention')]);
  await content.query(`INSERT INTO export.member_basis (manifest_id, member_ordinal, basis_ordinal)
    VALUES ($1, 1, 1)`, [manifest]);
  await rejects(content.query(`UPDATE export.manifest SET state = 'sealed', sealed_at = clock_timestamp(),
    manifest_digest = $2, completeness = 'complete', license_scope = 'uncertain', member_count = 3,
    residual_count = 1 WHERE id = $1`, [manifest, digest('bytes')]), '23514');
  await rejects(content.query(`UPDATE export.manifest SET state = 'sealed', sealed_at = clock_timestamp(),
    manifest_digest = $2, completeness = 'complete', license_scope = 'blocked', member_count = 2,
    residual_count = 1 WHERE id = $1`, [manifest, digest('bytes')]), '23514');
  await content.query(seal, [manifest, digest('bytes')]);
  await rejects(content.query(`INSERT INTO export.residual (manifest_id, ordinal, kind) VALUES ($1, 2, 'unavailable')`,
    [manifest]), '23514');
  await rejects(content.query(`UPDATE export.manifest SET license_scope = 'determined',
    license_expression = 'CC-BY-SA-4.0' WHERE id = $1`, [manifest]), '23514');
  await usesIndex(content, `SELECT manifest_id FROM export.member WHERE content_revision_id = $1`,
    [revisions[1]], 'member_content_revision_idx');
  // An erased pinned revision stays referenced by the export; it is never retargeted.
  const client2 = await content.connect();
  try {
    await client2.query('BEGIN');
    await client2.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 2)`, [revisions[1], randomUUID()]);
    await client2.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [revisions[1]]);
    await client2.query('COMMIT');
  } finally { client2.release(); }
  expect((await content.query(`SELECT r.availability FROM export.member m JOIN content.revision r
    ON r.id = m.content_revision_id WHERE m.manifest_id = $1`, [manifest])).rows).toEqual([{ availability: 'erased' }]);
}, 60_000);
