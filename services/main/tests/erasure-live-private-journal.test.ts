import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { completeErasureTarget, failErasureTarget, journalErasure, markErasureSuppressed,
  readErasure } from '../src/modules/erasure/journal.ts';
import { ERASURE_TARGET_OWNERS, type ErasureTargetKind } from '../src/modules/erasure/schema.ts';

const root = resolve(import.meta.dir, '../../..');

let state = '';
let cluster: PostgresCluster | undefined;
let admin: Pool;
let relay: Pool;

async function expectConstraintFailure(work: Promise<unknown>) {
  let error: { code?: string } | undefined;
  try { await work; } catch (caught) { error = caught as { code?: string }; }
  expect(error?.code).toBe('23514');
}

beforeAll(async () => {
  state = join(root, '.temp', `erasure-live-private-journal-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
  const databaseName = `erasure_journal_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  relay = new Pool({ ...cluster.connection, database: databaseName, max: 2 });
  const migrationDirectory = join(root, 'services/main/migrations/relay');
  for (const file of schemaFiles(root, 'relay')) {
    await relay.query(readFileSync(join(migrationDirectory, file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await relay?.end();
  await admin?.end();
  try { cluster?.remove(); }
  finally { if (state) rmSync(state, { recursive: true, force: true }); }
});

test('target completion is immutable, replayable, bounded and required for verification', async () => {
  const completionStateColumn = (await relay.query<{ is_nullable: string }>(`SELECT is_nullable
    FROM information_schema.columns WHERE table_schema = 'relay'
      AND table_name = 'erasure_target' AND column_name = 'completion_state'`)).rows[0];
  expect(completionStateColumn?.is_nullable).toBe('YES');

  const kinds = Object.keys(ERASURE_TARGET_OWNERS) as ErasureTargetKind[];
  const targets = kinds.map((kind, index) => ({ kind, ref: `target:${index}:${randomUUID()}` }));
  const erasure = await journalErasure(relay, {
    operationId: `erasure-target-completion:${randomUUID()}`,
    requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    kind: 'resource', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1', targets,
  });
  const report = await readErasure(relay, erasure.erasureId);
  expect(report.targets.map(({ owner, kind, ref }) => ({ owner, kind, ref }))).toEqual(
    targets.map(target => ({ owner: ERASURE_TARGET_OWNERS[target.kind], ...target })));
  expect(report.targets.map(({ completionState, completionReasonCode, completionEvidenceRef }) => ({
    completionState, completionReasonCode, completionEvidenceRef,
  }))).toEqual(targets.map(() => ({ completionState: 'pending', completionReasonCode: null,
    completionEvidenceRef: null })));

  const identity = await relay.query<{ erasure_id: string; ordinal: number; owner: string;
    target_kind: string; target_ref: string }>(
    `SELECT erasure_id, ordinal, owner, target_kind, target_ref FROM relay.erasure_target
     WHERE erasure_id = $1 ORDER BY ordinal`,
    [erasure.erasureId]);
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target SET target_ref = 'changed'
    WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId]));
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target SET ordinal = 100
    WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId]));
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target
    SET owner = 'content', target_kind = 'content_revision'
    WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId]));
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target SET erasure_id = $2
    WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId, randomUUID()]));
  expect((await relay.query(`SELECT erasure_id, ordinal, owner, target_kind, target_ref
    FROM relay.erasure_target WHERE erasure_id = $1 ORDER BY ordinal`, [erasure.erasureId])).rows)
    .toEqual(identity.rows);

  await expectConstraintFailure(relay.query(`INSERT INTO relay.erasure_target
    (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 257, 'graph', 'text_contribution_draft', 'overflow')`, [erasure.erasureId]));

  const firstEvidence = 'ab'.repeat(32);
  await completeErasureTarget(relay, erasure.erasureId, 1, firstEvidence);
  await completeErasureTarget(relay, erasure.erasureId, 1, firstEvidence);
  const completed = (await relay.query<{ completion_state: string; completion_reason_code: string | null;
    completion_evidence_ref: string | null; completed_at: Date | null }>(`SELECT completion_state,
      completion_reason_code, completion_evidence_ref, completed_at FROM relay.erasure_target
      WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId])).rows[0];
  expect(completed).toEqual({ completion_state: 'completed', completion_reason_code: null,
    completion_evidence_ref: firstEvidence, completed_at: expect.any(Date) });
  await expect(failErasureTarget(relay, erasure.erasureId, 1, 'changed_failure'))
    .rejects.toThrow('cannot fail');
  await expect(completeErasureTarget(relay, erasure.erasureId, 1, 'cd'.repeat(32)))
    .rejects.toThrow('evidence is immutable');
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target SET completion_state = 'pending'
    WHERE erasure_id = $1 AND ordinal = 1`, [erasure.erasureId]));
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target
    SET completion_evidence_ref = $3 WHERE erasure_id = $1 AND ordinal = $2`,
  [erasure.erasureId, 1, 'cd'.repeat(32)]));

  const pendingOrdinal = 2;
  const failedOrdinal = 3;
  await failErasureTarget(relay, erasure.erasureId, failedOrdinal, 'deletion_probe_failed');
  await failErasureTarget(relay, erasure.erasureId, failedOrdinal, 'deletion_probe_failed');
  await expect(failErasureTarget(relay, erasure.erasureId, failedOrdinal, 'changed_failure'))
    .rejects.toThrow('reason code is immutable');
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure_target
    SET completion_reason_code = 'changed_failure' WHERE erasure_id = $1 AND ordinal = $2`,
  [erasure.erasureId, failedOrdinal]));
  expect((await relay.query<{ completion_state: string; completion_reason_code: string }>(
    `SELECT completion_state, completion_reason_code FROM relay.erasure_target
     WHERE erasure_id = $1 AND ordinal = $2`, [erasure.erasureId, failedOrdinal])).rows[0])
    .toEqual({ completion_state: 'failed', completion_reason_code: 'deletion_probe_failed' });

  await markErasureSuppressed(relay, erasure.erasureId);
  await relay.query(`UPDATE relay.erasure SET stage = 'inventory_complete', destruction_status = 'destroyed'
    WHERE id = $1`, [erasure.erasureId]);
  await expectConstraintFailure(relay.query(`UPDATE relay.erasure SET stage = 'verified',
    verified_at = clock_timestamp() WHERE id = $1`, [erasure.erasureId]));
  expect((await relay.query<{ stage: string; verified_at: Date | null }>(
    'SELECT stage, verified_at FROM relay.erasure WHERE id = $1', [erasure.erasureId])).rows[0])
    .toEqual({ stage: 'inventory_complete', verified_at: null });

  await completeErasureTarget(relay, erasure.erasureId, pendingOrdinal, 'de'.repeat(32));
  const recoveryEvidence = 'ef'.repeat(32);
  await completeErasureTarget(relay, erasure.erasureId, failedOrdinal, recoveryEvidence);
  await completeErasureTarget(relay, erasure.erasureId, failedOrdinal, recoveryEvidence);
  expect((await relay.query<{ completion_state: string; completion_reason_code: string | null;
    completion_evidence_ref: string | null; completed_at: Date | null }>(`SELECT completion_state,
      completion_reason_code, completion_evidence_ref, completed_at FROM relay.erasure_target
      WHERE erasure_id = $1 AND ordinal = $2`, [erasure.erasureId, failedOrdinal])).rows[0])
    .toEqual({ completion_state: 'completed', completion_reason_code: null,
      completion_evidence_ref: recoveryEvidence, completed_at: expect.any(Date) });
  for (let ordinal = 4; ordinal <= targets.length; ordinal += 1) {
    await completeErasureTarget(relay, erasure.erasureId, ordinal,
      createHash('sha256').update(`target completion ${ordinal}`).digest('hex'));
  }
  await relay.query(`UPDATE relay.erasure SET stage = 'verified', verified_at = clock_timestamp()
    WHERE id = $1`, [erasure.erasureId]);
  expect((await relay.query<{ stage: string }>('SELECT stage FROM relay.erasure WHERE id = $1',
    [erasure.erasureId])).rows[0]?.stage).toBe('verified');

  for (const state of ['pending', 'failed'] as const) {
    const target = await journalErasure(relay, {
      operationId: `erasure-target-${state}:${randomUUID()}`,
      requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1',
      targets: [{ kind: 'content_revision', ref: `target:${state}:${randomUUID()}` }],
    });
    if (state === 'failed') {
      await failErasureTarget(relay, target.erasureId, 1, 'owner_probe_failed');
    }
    await markErasureSuppressed(relay, target.erasureId);
    await relay.query(`UPDATE relay.erasure SET stage = 'inventory_complete', destruction_status = 'destroyed'
      WHERE id = $1`, [target.erasureId]);
    await expectConstraintFailure(relay.query(`UPDATE relay.erasure SET stage = 'verified',
      verified_at = clock_timestamp() WHERE id = $1`, [target.erasureId]));
  }

});

test('verified targets from before completion tracking remain explicitly unqualified on upgrade', async () => {
  const files = schemaFiles(root, 'relay');
  const completionFile = '023_erasure_target_completion.sql';
  const completionIndex = files.indexOf(completionFile);
  expect(completionIndex).toBeGreaterThan(0);

  const databaseName = `erasure_upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const upgradeRelay = new Pool({ ...cluster!.connection, database: databaseName, max: 2 });
  try {
    const migrationDirectory = join(root, 'services/main/migrations/relay');
    for (const file of files.slice(0, completionIndex)) {
      await upgradeRelay.query(readFileSync(join(migrationDirectory, file), 'utf8'));
    }

    const erasureId = randomUUID();
    await upgradeRelay.query(`INSERT INTO relay.erasure
      (id, erasure_epoch, operation_id, request_digest, kind, authority, principal_id,
       admission_id, authority_epoch, stage, suppression_status, destruction_status,
       suppressed_at, verified_at)
      VALUES ($1, 1, $2, $3, 'resource', 'access_admission', $4, $5, 1,
        'verified', 'suppressed', 'destroyed', clock_timestamp(), clock_timestamp())`,
    [erasureId, `historical-erasure:${randomUUID()}`,
      createHash('sha256').update(randomUUID()).digest('hex'), randomUUID(), randomUUID()]);
    await upgradeRelay.query(`INSERT INTO relay.erasure_target
      (erasure_id, ordinal, owner, target_kind, target_ref)
      VALUES ($1, 1, 'content', 'content_revision', $2)`,
    [erasureId, `historical-target:${randomUUID()}`]);

    await upgradeRelay.query(readFileSync(join(migrationDirectory, completionFile), 'utf8'));
    const report = await readErasure(upgradeRelay, erasureId);
    expect(report.stage).toBe('verified');
    expect(report.targets).toMatchObject([{ completionState: 'legacy', completionReasonCode: null,
      completionEvidenceRef: null, completedAt: null }]);

    const evidence = createHash('sha256').update('historical owner inventory').digest('hex');
    await completeErasureTarget(upgradeRelay, erasureId, 1, evidence);
    const upgraded = await readErasure(upgradeRelay, erasureId);
    expect(upgraded.targets).toMatchObject([{ completionState: 'completed', completionReasonCode: null,
      completionEvidenceRef: evidence }]);
  } finally {
    await upgradeRelay.end();
    await admin.query(`DROP DATABASE ${databaseName}`);
  }
});
