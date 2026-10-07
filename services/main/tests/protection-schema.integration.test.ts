import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { ContentCore, migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { seedRetainedContentDraft } from './retained-content-fixture.ts';
import { PROTECTION_RULE } from '../src/modules/protection/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/content/migrations');
const PROTECTION_VERSION = 130;
const state = join(root, '.temp', `protection-schema-${randomUUID()}`);
const data = join(state, 'pgdata');
const socket = join(root, '.temp', 'pg-sock');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let port = 0;
let admin: Pool;
const pools: Pool[] = [];

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

async function database(name: string): Promise<Pool> {
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: name, max: 6 });
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  admin = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 2 });
}, 60_000);

afterAll(async () => {
  await Promise.all([...pools, admin].map(pool => pool?.end()));
  try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

const files = () => schemaFiles(root, 'content');
const variantIdentity = (): VariantIdentity => ({ id: `urn:rezics:variant:${randomUUID()}`,
  resourceId: `https://rezics.com/id/${randomUUID()}`, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
  direction: 'ltr' });
const actions = async (pool: Pool) => (await pool.query<{ action: string }>(
  'SELECT action FROM content.receipt_action ORDER BY action')).rows.map(row => row.action).sort();

/** The pre-protection Content head, then the protection migration through the ordinary runner. */
async function upgradedOwner(name: string) {
  const pool = await database(name);
  await pool.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of files().filter(file => migrationVersion(file) < PROTECTION_VERSION)) {
    await pool.query(readFileSync(join(migrations, file), 'utf8'));
    await pool.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [migrationVersion(file)]);
  }
  const content = new ContentCore(pool);
  const variant = variantIdentity();
  const first = await seedRetainedContentDraft(pool, variant, '{"body":"one"}', { editor: 'test' });
  const before = await actions(pool);
  await migrateContent(pool);
  await migrateContent(pool);
  return { pool, content, variant, head: first.revisionId!, before };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function receipt(client: PoolClient, operation: string, action: string, variant: string) {
  const position = (await client.query<{ data_epoch: string; sequence: string }>(`UPDATE content.owner_control
    SET sequence = sequence + 1 WHERE singleton RETURNING data_epoch, sequence`)).rows[0]!;
  await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id,
    data_epoch, sequence) VALUES ($1, $2, $3, 'succeeded', $4, $5, $6)`,
  [operation, sha(operation), action, variant, position.data_epoch, position.sequence]);
}

async function protect(client: PoolClient, input: { variant: string; predecessor: string | null; epoch: number;
  action: 'tighten' | 'confirm' | 'relax'; observed: string; receipt?: boolean }) {
  const id = randomUUID(), operation = `protect-${id}`;
  if (input.receipt !== false) await receipt(client, operation, 'protection.change', input.variant);
  await client.query(`INSERT INTO content.protection_revision (id, variant_id, predecessor, epoch, profile, action,
    mode, rule_revision, observed_head, reason, evidence, operation_id)
    VALUES ($1, $2, $3, $4, 'content-draft-protection-v1', $5, $6, $7, $8, 'vandalism', '[]', $9)`,
  [id, input.variant, input.predecessor, input.epoch, input.action, input.action === 'relax' ? 'open' : 'review-required',
    PROTECTION_RULE, input.observed, operation]);
  return id;
}

async function propose(client: PoolClient, input: { variant: string; base: string; protection: string | null;
  body: string; proposal?: string; predecessor?: string; revisionNumber?: number; digest?: string }) {
  const id = randomUUID(), proposal = input.proposal ?? randomUUID(), candidate = randomUUID();
  const operation = `propose-${id}`, bytes = Buffer.from(input.body);
  await receipt(client, operation, 'correction.propose', input.variant);
  await client.query(`INSERT INTO content.revision (id, variant_id, predecessor, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body) VALUES ($1, $2, $3, $4, 'rezics-content-json-v1', 'content-shape-v1',
    '{}', $5, $6, $7, $8::jsonb)`, [candidate, input.variant, input.base, operation, sha(bytes), bytes.length, bytes, input.body]);
  await client.query(`INSERT INTO content.correction_proposal (id, proposal_id, revision_number, predecessor, variant_id,
    profile, base_head, base_protection, rule_revision, candidate_revision, candidate_digest, evidence, reason, operation_id)
    VALUES ($1, $2, $3, $4, $5, 'content-draft-protection-v1', $6, $7, $8, $9, $10, '["urn:rezics:evidence:catalog"]',
    'typo', $11)`, [id, proposal, input.revisionNumber ?? 1, input.predecessor ?? null, input.variant,
    input.base, input.protection, PROTECTION_RULE, candidate, input.digest ?? sha(bytes), operation]);
  return { id, proposal, candidate, digest: sha(bytes) };
}

async function decide(client: PoolClient, proposal: { id: string; candidate: string; digest: string },
  input: { variant: string; base: string; outcome: 'approved' | 'rejected'; protection: string | null; apply?: boolean }) {
  const id = randomUUID(), operation = `decide-${id}`;
  await receipt(client, operation, 'correction.decide', input.variant);
  await client.query(`INSERT INTO content.correction_decision (id, proposal_revision, variant_id, base_head,
    candidate_revision, candidate_digest, rule_revision, outcome, independence_proof, evidence, reason, operation_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]', 'reviewed', $10)`, [id, proposal.id, input.variant, input.base,
    proposal.candidate, proposal.digest, PROTECTION_RULE, input.outcome,
    input.outcome === 'approved' ? `urn:rezics:independence:${randomUUID()}` : null, operation]);
  if (input.outcome === 'approved' && input.apply !== false) {
    await client.query(`INSERT INTO content.correction_application (proposal_revision, decision_id, variant_id, base_head,
      successor_head, candidate_digest, rule_revision, protection_head, operation_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [proposal.id, id, input.variant, input.base, proposal.candidate,
      proposal.digest, PROTECTION_RULE, input.protection, operation]);
  }
  return id;
}

const heads = async (pool: Pool, variant: string) => (await pool.query<{ draft_head: string; protection_head: string | null }>(
  'SELECT draft_head, protection_head FROM content.variant WHERE id = $1', [variant])).rows[0]!;

/** Deterministic barrier: the other session is blocked on the target row lock. */
async function lockWaiters(pool: Pool, count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(waiting.rows[0]!.n) === count) return;
    await Bun.sleep(25);
  }
  throw new Error('row-lock waiter did not appear');
}

test('G-052 protection schema: empty install and upgrade from the current Content head', async () => {
  const fresh = await database('protection_fresh');
  await migrateContent(fresh);
  await migrateContent(fresh);
  const versions = await fresh.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version');
  expect(versions.rows.map(row => row.version)).toEqual(files().map(file => migrationVersion(file)));
  const tables = await fresh.query<{ name: string | null }>(`SELECT to_regclass(name)::text AS name FROM unnest(ARRAY[
    'content.protection_revision', 'content.correction_proposal', 'content.correction_decision',
    'content.correction_application']) name`);
  expect(tables.rows.every(row => row.name)).toBe(true);
  const freshActions = await actions(fresh);
  expect(freshActions).toEqual(expect.arrayContaining(['correction.decide', 'correction.propose', 'protection.change']));

  const upgraded = await upgradedOwner('protection_upgrade');
  // Upgrade and fresh install reach the same complete head, including later receipt actions.
  // Every pre-protection action must also survive independently of that comparison.
  const upgradedActions = await actions(upgraded.pool);
  expect(upgradedActions).toEqual(freshActions);
  expect(upgradedActions).toEqual(expect.arrayContaining(upgraded.before));
  expect(await heads(upgraded.pool, upgraded.variant.id)).toEqual({ draft_head: upgraded.head, protection_head: null });
  const second = await upgraded.content.saveDraft({ operationId: `save-${randomUUID()}`, variant: upgraded.variant,
    expectedHead: upgraded.head, model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' },
    serializedJson: '{"body":"two"}' });
  expect(second.outcome).toBe('succeeded');
}, 60_000);

test('MODEL23/MODEL18/SYS03: protection and edits serialize on the existing variant row', async () => {
  const { pool, content, variant, head } = await upgradedOwner('protection_race');
  const save = (expectedHead: string, body: string) => content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
    expectedHead, model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' }, serializedJson: body });

  // Protection wins while an unchanged pre-protection writer expects the old absent basis.
  const tighten = await pool.connect();
  let protection = '';
  try {
    await tighten.query('BEGIN');
    protection = await protect(tighten, { variant: variant.id, predecessor: null, epoch: 1, action: 'tighten', observed: head });
    const edit = save(head, '{"body":"vandal"}');
    await lockWaiters(pool, 1);
    await tighten.query('COMMIT');
    await expect(edit).rejects.toMatchObject({ constraint: 'variant_correction_required' });
  } finally { tighten.release(); }
  expect(await heads(pool, variant.id)).toEqual({ draft_head: head, protection_head: protection });

  // The optional row cannot be recreated, detached, rewritten or forked from a stale basis.
  await expect(transaction(pool, client => protect(client, { variant: variant.id, predecessor: null, epoch: 1,
    action: 'tighten', observed: head }))).rejects.toMatchObject({ constraint: 'protection_stale_basis' });
  await expect(transaction(pool, client => protect(client, { variant: variant.id, predecessor: protection, epoch: 2,
    action: 'tighten', observed: head }))).rejects.toMatchObject({ constraint: 'protection_transition' });
  await expect(pool.query('UPDATE content.variant SET protection_head = NULL WHERE id = $1', [variant.id]))
    .rejects.toMatchObject({ constraint: 'variant_protection_append_only' });
  await expect(pool.query('DELETE FROM content.protection_revision WHERE id = $1', [protection]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(pool.query(`UPDATE content.protection_revision SET mode = 'open' WHERE id = $1`, [protection]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(transaction(pool, client => protect(client, { variant: variant.id, predecessor: protection, epoch: 2,
    action: 'relax', observed: head, receipt: false }))).rejects.toMatchObject({ constraint: 'protection_revision_operation_id_fkey' });

  // The edit wins at another target: an old-basis protection is stale instead of confirming the new head.
  const other = variantIdentity();
  const first = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant: other, expectedHead: null,
    model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' }, serializedJson: '{"body":"a"}' });
  const next = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant: other, expectedHead: first.revisionId,
    model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' }, serializedJson: '{"body":"b"}' });
  await expect(transaction(pool, client => protect(client, { variant: other.id, predecessor: null, epoch: 1,
    action: 'confirm', observed: first.revisionId! }))).rejects.toMatchObject({ constraint: 'protection_stale_content' });
  expect(await heads(pool, other.id)).toEqual({ draft_head: next.revisionId!, protection_head: null });

  // Relaxation appends history; the unchanged writer is admitted again only under open protection.
  const relaxed = await transaction(pool, client => protect(client, { variant: variant.id, predecessor: protection,
    epoch: 2, action: 'relax', observed: head }));
  await expect(transaction(pool, client => protect(client, { variant: variant.id, predecessor: relaxed, epoch: 3,
    action: 'relax', observed: head }))).rejects.toMatchObject({ constraint: 'protection_transition' });
  expect((await save(head, '{"body":"open edit"}')).outcome).toBe('succeeded');
  const history = await pool.query<{ epoch: string; mode: string }>(`SELECT epoch::text, mode FROM content.protection_revision
    WHERE variant_id = $1 ORDER BY epoch`, [variant.id]);
  expect(history.rows).toEqual([{ epoch: '1', mode: 'review-required' }, { epoch: '2', mode: 'open' }]);
}, 60_000);

test('GOV03/SYS14/SYS11: one terminal decision and one application per correction proposal revision', async () => {
  const { pool, variant, head } = await upgradedOwner('protection_correction');
  const protection = await transaction(pool, client => protect(client, { variant: variant.id, predecessor: null, epoch: 1,
    action: 'confirm', observed: head }));

  // A proposal binds the exact current basis, including the protection head and candidate bytes.
  await expect(transaction(pool, client => propose(client, { variant: variant.id, base: head, protection: null,
    body: '{"body":"x"}' }))).rejects.toMatchObject({ constraint: 'correction_stale_basis' });
  await expect(transaction(pool, client => propose(client, { variant: variant.id, base: head, protection,
    body: '{"body":"x"}', digest: 'f'.repeat(64) }))).rejects.toMatchObject({ constraint: 'correction_candidate' });
  const first = await transaction(pool, client => propose(client, { variant: variant.id, base: head, protection,
    body: '{"body":"fixed"}' }));
  expect(await heads(pool, variant.id)).toEqual({ draft_head: head, protection_head: protection });

  // Approval cannot commit without its application.
  await expect(transaction(pool, client => decide(client, first, { variant: variant.id, base: head, outcome: 'approved',
    protection, apply: false }))).rejects.toMatchObject({ constraint: 'correction_approval_applied' });

  // Concurrent approve and reject: the target row orders them and only one terminal decision exists.
  const approve = await pool.connect();
  try {
    await approve.query('BEGIN');
    await decide(approve, first, { variant: variant.id, base: head, outcome: 'approved', protection });
    const reject = transaction(pool, client => decide(client, first, { variant: variant.id, base: head,
      outcome: 'rejected', protection }));
    await lockWaiters(pool, 1);
    await approve.query('COMMIT');
    await expect(reject).rejects.toMatchObject({ constraint: 'correction_decision_proposal_revision_key' });
  } finally { approve.release(); }
  // Application preserves protection; a new-key approval of the same revision has no second effect.
  expect(await heads(pool, variant.id)).toEqual({ draft_head: first.candidate, protection_head: protection });
  await expect(transaction(pool, client => decide(client, first, { variant: variant.id, base: head, outcome: 'approved',
    protection }))).rejects.toMatchObject({ constraint: 'correction_decision_proposal_revision_key' });
  // An applied proposal is reversed by a new correction, never by revising it.
  await expect(transaction(pool, client => propose(client, { variant: variant.id, base: first.candidate, protection,
    body: '{"body":"undo"}', proposal: first.proposal, predecessor: first.id, revisionNumber: 2 })))
    .rejects.toMatchObject({ constraint: 'correction_revision' });

  // Two proposals share a base: the first application makes the other stale.
  const left = await transaction(pool, client => propose(client, { variant: variant.id, base: first.candidate, protection,
    body: '{"body":"left"}' }));
  const rightProposal = randomUUID();
  const right = await transaction(pool, client => propose(client, { variant: variant.id, base: first.candidate, protection,
    body: '{"body":"right"}', proposal: rightProposal }));
  await transaction(pool, client => decide(client, left, { variant: variant.id, base: first.candidate,
    outcome: 'approved', protection }));
  await expect(transaction(pool, client => decide(client, right, { variant: variant.id, base: first.candidate,
    outcome: 'approved', protection }))).rejects.toMatchObject({ constraint: 'correction_stale_basis' });
  expect(await heads(pool, variant.id)).toEqual({ draft_head: left.candidate, protection_head: protection });

  // A rejected revision stays inspectable; changing it takes a new revision on the current basis.
  await transaction(pool, client => decide(client, right, { variant: variant.id, base: first.candidate,
    outcome: 'rejected', protection }));
  const revised = await transaction(pool, client => propose(client, { variant: variant.id, base: left.candidate, protection,
    body: '{"body":"right again"}', proposal: rightProposal, predecessor: right.id, revisionNumber: 2 }));
  const decisions = await pool.query<{ outcome: string }>(`SELECT outcome FROM content.correction_decision
    WHERE proposal_revision = ANY($1::uuid[]) ORDER BY outcome`, [[right.id, revised.id]]);
  expect(decisions.rows).toEqual([{ outcome: 'rejected' }]);
  await expect(pool.query('DELETE FROM content.correction_application')).rejects.toMatchObject({ code: '23514' });
  await expect(pool.query(`UPDATE content.correction_decision SET outcome = 'approved'`)).rejects.toMatchObject({ code: '23514' });
}, 60_000);
