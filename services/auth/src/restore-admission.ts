import type { AuthErasureBarrier } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import { nativeErasurePage } from './erasure-native.ts';
import { erasureHistoryPage } from './erasure-history.ts';
import { installNativeRoleCoverage, reconcileNativeRoleCoveragePage } from './erasure-coverage.ts';
import type { NativeConsumerRuntime } from './erasure-consumers.ts';

export type AuthRestorePendingCode =
  | 'database-owner-unavailable'
  | 'restore-lineage-unavailable'
  | 'restore-lineage-mismatch'
  | 'original-progress-unavailable'
  | 'original-progress-mismatch'
  | 'source-authority-unavailable'
  | 'source-consumer-pending'
  | 'native-replay-pending'
  | 'receiving-closure-pending'
  | 'external-owner-pending';

export class AuthRestoreAdmissionError extends Error {
  override readonly name = 'AuthRestoreAdmissionError';
  constructor(readonly code: AuthRestorePendingCode) {
    super(`Auth restored generation admission closed: ${code}`);
  }
}

/** Database-owner evidence, not an assertion of physical deletion. Each identity
 * names existing inventory/recovery records. There are no generated defaults.
 * The owner must verify these against the actual connected restored database,
 * its isolated inventory entry and the independently recovered committed tail.
 */
export interface AuthRestoreInventory {
  generation: string;
  databaseIdentity: string;
  inventoryEntry: string;
  inventoryVersion: string;
  sourceCluster: string;
  sourceTimeline: string;
  sourceLineage: string;
  capturePoint: string;
  committedNativeTail: string;
}

/** Auth's recovered native row, not a Source feed declaration. The route/T are
 * the original binding recovered by the database owner. Only the independent
 * Access owner can establish their CURRENT authority or sealed feed boundary.
 */
export interface AuthRestoreNativeProgress {
  source: AuthErasureBarrier & { route: number };
  originalNativeId: string;
  checkpoint: string;
  floor: number;
  acceptedAt: string;
  applicable: boolean;
  userDeletion:
    | { state: 'never-established' }
    | { state: 'established'; deletedAt: string; consentDueAt: string; consentCompletedAt: string | null };
  consumer:
    | { state: 'pending' }
    | {
        state: 'accepted';
        workflowId: string;
        continuationId: string;
        receiptId: string;
        acceptedAt: string;
        dischargedAt: string | null;
        publishedAt: string | null;
      };
}

/** Trusted database/deployment composition. No implementation is installed in
 * this repository. Implementations use genuine PostgreSQL recovery/inventory,
 * including the committed tail beyond the old snapshot; a caller flag, an old
 * row's absence or a current timestamp cannot implement either method.
 * Neither method runs inside an Auth transaction or receives a kernel pool.
 */
export interface AuthRestoreDatabaseOwner {
  verifyRestoredDatabase(input: {
    database: Pool;
    generation: string;
  }): Promise<AuthRestoreInventory | { pending: 'restore-lineage-unavailable' | 'restore-lineage-mismatch' }>;
  recoverCommittedNativeProgress(input: {
    inventory: AuthRestoreInventory;
    accountId: string;
  }): Promise<AuthRestoreNativeProgress | { pending: 'original-progress-unavailable' }>;
}

export interface AuthRestoredGeneration {
  kind: 'RESTORED';
  generation: string;
  databaseOwner?: AuthRestoreDatabaseOwner;
}

function fail(code: AuthRestorePendingCode): never {
  throw new AuthRestoreAdmissionError(code);
}
const key = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024;
const timestamp = (value: string) => Number.isFinite(Date.parse(value));
const instant = (value: Date | string | null) => (value === null ? null : new Date(value).getTime());

async function inventoryFor(database: Pool, restored: AuthRestoredGeneration): Promise<AuthRestoreInventory> {
  if (restored.kind !== 'RESTORED' || !key(restored.generation)) fail('restore-lineage-mismatch');
  if (!restored.databaseOwner) fail('database-owner-unavailable');
  let result: Awaited<ReturnType<AuthRestoreDatabaseOwner['verifyRestoredDatabase']>>;
  try {
    result = await restored.databaseOwner.verifyRestoredDatabase({ database, generation: restored.generation });
  } catch {
    return fail('restore-lineage-unavailable');
  }
  if (!result || typeof result !== 'object') fail('restore-lineage-unavailable');
  if ('pending' in result) fail(result.pending);
  if (
    result.generation !== restored.generation ||
    ![
      result.generation,
      result.databaseIdentity,
      result.inventoryEntry,
      result.inventoryVersion,
      result.sourceCluster,
      result.sourceTimeline,
      result.sourceLineage,
      result.capturePoint,
      result.committedNativeTail,
    ].every(key)
  )
    fail('restore-lineage-mismatch');
  return result;
}

async function bindInventory(database: Pool, inventory: AuthRestoreInventory) {
  // A single exact identity; this is NOT a backup catalogue or physical proof.
  const result = await database.query(
    `INSERT INTO auth_restore_generation(generation,inventory) VALUES ($1,$2::jsonb)
     ON CONFLICT(generation) DO UPDATE SET inventory=EXCLUDED.inventory
     WHERE auth_restore_generation.inventory IS NULL OR auth_restore_generation.inventory=EXCLUDED.inventory RETURNING generation`,
    [inventory.generation, JSON.stringify(inventory)],
  );
  if (!result.rowCount) fail('restore-lineage-mismatch');
}

/** Recovery/import proceeds independently of Source availability. It never
 * registers a new Source consumer, renews an approval or discharges a root.
 * Each invocation recovers ONE exact native obligation, with no user polling.
 */
export async function importRestoredAuthProgress(
  database: Pool,
  restored: AuthRestoredGeneration,
  accountId: string,
): Promise<string> {
  const inventory = await inventoryFor(database, restored);
  if (!key(accountId)) fail('original-progress-mismatch');
  let progress: Awaited<ReturnType<AuthRestoreDatabaseOwner['recoverCommittedNativeProgress']>>;
  try {
    progress = await restored.databaseOwner!.recoverCommittedNativeProgress({ inventory, accountId });
  } catch {
    return fail('original-progress-unavailable');
  }
  if (!progress || typeof progress !== 'object') fail('original-progress-unavailable');
  if ('pending' in progress) fail(progress.pending);
  validateProgress(progress, accountId);
  await bindInventory(database, inventory);
  // ALL owner reads have completed before this checkout. There is no foreign
  // call, wait or SDK recovery while holding a native producer lock.
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${accountId}`]);
    const source = progress.source;
    const deletion = progress.userDeletion.state === 'established' ? progress.userDeletion : null;
    const consumer = progress.consumer.state === 'accepted' ? progress.consumer : null;
    const previous = (
      await connection.query(
        `SELECT *,accepted_at=$2::timestamptz AS accepted_matches,
       (user_deleted_at IS NULL OR user_deleted_at=$3::timestamptz) AS deletion_matches,
       (consent_due_at IS NULL OR consent_due_at=$4::timestamptz) AS due_matches,
       (consent_completed_at IS NULL OR consent_completed_at=$5::timestamptz) AS consent_matches,
       (source_accepted_at IS NULL OR source_accepted_at=$6::timestamptz) AS source_accepted_matches,
       (source_discharged_at IS NULL OR source_discharged_at=$7::timestamptz) AS discharged_matches,
       (source_published_at IS NULL OR source_published_at=$8::timestamptz) AS published_matches
       FROM auth_erasure WHERE account_id=$1 FOR UPDATE`,
        [
          accountId,
          progress.acceptedAt,
          deletion?.deletedAt ?? null,
          deletion?.consentDueAt ?? null,
          deletion?.consentCompletedAt ?? null,
          consumer?.acceptedAt ?? null,
          consumer?.dischargedAt ?? null,
          consumer?.publishedAt ?? null,
        ],
      )
    ).rows[0];
    if (
      previous &&
      (previous.barrier !== progress.floor ||
        (previous.kernel_at !== null &&
          (previous.kernel_at !== source.at || previous.kernel_version !== source.version)) ||
        (previous.source_route !== null && previous.source_route !== source.route) ||
        (previous.original_native_id !== null && previous.original_native_id !== progress.originalNativeId) ||
        !previous.accepted_matches ||
        (previous.user_deleted_at !== null && !previous.deletion_matches) ||
        (previous.consent_due_at !== null && !previous.due_matches) ||
        (previous.consent_completed_at !== null && !previous.consent_matches) ||
        (previous.source_accepted_at !== null &&
          (!consumer ||
            previous.source_workflow_id !== consumer.workflowId ||
            previous.source_continuation_id !== consumer.continuationId ||
            previous.source_receipt_id !== consumer.receiptId ||
            !previous.source_accepted_matches)) ||
        (previous.source_discharged_at !== null && !previous.discharged_matches) ||
        (previous.source_published_at !== null && !previous.published_matches))
    )
      fail('original-progress-mismatch');
    const row = (
      await connection.query<{ id: string }>(
        `INSERT INTO auth_erasure(account_id,barrier,version,applicable,kernel_version,kernel_at,
          source_route,original_native_id,accepted_at,user_deleted_at,consent_due_at,consent_completed_at,
          source_workflow_id,source_continuation_id,source_receipt_id,source_accepted_at,source_discharged_at,source_published_at)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT(account_id) DO UPDATE SET applicable=auth_erasure.applicable OR EXCLUDED.applicable,
          kernel_version=EXCLUDED.kernel_version,kernel_at=EXCLUDED.kernel_at,source_route=EXCLUDED.source_route,
          original_native_id=EXCLUDED.original_native_id,
          user_deleted_at=COALESCE(auth_erasure.user_deleted_at,EXCLUDED.user_deleted_at),
          consent_due_at=COALESCE(auth_erasure.consent_due_at,EXCLUDED.consent_due_at),
          consent_completed_at=COALESCE(auth_erasure.consent_completed_at,EXCLUDED.consent_completed_at),
          source_workflow_id=EXCLUDED.source_workflow_id,source_continuation_id=EXCLUDED.source_continuation_id,
          source_receipt_id=EXCLUDED.source_receipt_id,source_accepted_at=EXCLUDED.source_accepted_at,
          source_discharged_at=EXCLUDED.source_discharged_at,source_published_at=EXCLUDED.source_published_at
         RETURNING id`,
        [
          accountId,
          progress.floor,
          progress.applicable,
          source.version,
          source.at,
          source.route,
          progress.originalNativeId,
          progress.acceptedAt,
          deletion?.deletedAt ?? null,
          deletion?.consentDueAt ?? null,
          deletion?.consentCompletedAt ?? null,
          consumer?.workflowId ?? null,
          consumer?.continuationId ?? null,
          consumer?.receiptId ?? null,
          consumer?.acceptedAt ?? null,
          consumer?.dischargedAt ?? null,
          consumer?.publishedAt ?? null,
        ],
      )
    ).rows[0]!;
    // The original Auth evidence is immutable within this restore generation.
    // New generations get a fresh native cursor even when the old one completed.
    const replay = await connection.query(
      `INSERT INTO auth_restore_replay(generation,obligation_id,original_progress)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT(generation,obligation_id)
       DO UPDATE SET generation=EXCLUDED.generation
       WHERE auth_restore_replay.original_progress=EXCLUDED.original_progress RETURNING obligation_id`,
      [restored.generation, row.id, JSON.stringify(progress)],
    );
    if (!replay.rowCount) fail('original-progress-mismatch');
    await connection.query('COMMIT');
    return row.id;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

function validateProgress(progress: AuthRestoreNativeProgress, accountId: string) {
  if (Buffer.byteLength(JSON.stringify(progress)) > 16384) fail('original-progress-mismatch');
  const source = progress.source;
  if (
    !source ||
    source.accountId !== accountId ||
    !Number.isInteger(source.route) ||
    source.route < 0 ||
    source.route >= 4096 ||
    !Number.isSafeInteger(source.version) ||
    source.version < 1 ||
    source.version > 2147483647 ||
    !key(source.at) ||
    Buffer.byteLength(source.at) > 64 ||
    !timestamp(source.at) ||
    !key(progress.originalNativeId) ||
    !key(progress.checkpoint) ||
    !Number.isSafeInteger(progress.floor) ||
    progress.floor < 0 ||
    progress.floor > 2147483647 ||
    !timestamp(progress.acceptedAt) ||
    typeof progress.applicable !== 'boolean'
  )
    fail('original-progress-mismatch');
  const deletion = progress.userDeletion;
  if (!deletion || !['established', 'never-established'].includes(deletion.state))
    fail('original-progress-unavailable');
  if (
    deletion.state === 'established' &&
    (!timestamp(deletion.deletedAt) ||
      !timestamp(deletion.consentDueAt) ||
      instant(deletion.consentDueAt)! - instant(deletion.deletedAt)! < 309_000 ||
      instant(deletion.consentDueAt)! - instant(deletion.deletedAt)! > 310_000 ||
      (deletion.consentCompletedAt !== null &&
        (!timestamp(deletion.consentCompletedAt) ||
          instant(deletion.consentCompletedAt)! < instant(deletion.consentDueAt)!)))
  )
    fail('original-progress-mismatch');
  const consumer = progress.consumer;
  if (!consumer || !['pending', 'accepted'].includes(consumer.state)) fail('original-progress-unavailable');
  if (
    consumer.state === 'accepted' &&
    (![consumer.workflowId, consumer.continuationId, consumer.receiptId].every(key) ||
      !timestamp(consumer.acceptedAt) ||
      (consumer.dischargedAt !== null && !timestamp(consumer.dischargedAt)) ||
      (consumer.publishedAt !== null && (!consumer.dischargedAt || !timestamp(consumer.publishedAt))))
  )
    fail('original-progress-mismatch');
}

/** One existing native page, then (on a later invocation) one shared-copy page.
 * Native held consumers retain their original supported continuation/proofs.
 * Returning a pending reason is never an admission or physical-copy result.
 */
export async function replayRestoredAuthPage(
  database: Pool,
  restored: AuthRestoredGeneration,
  id: string,
  runtime?: NativeConsumerRuntime,
): Promise<{ pending: AuthRestorePendingCode }> {
  const inventory = await inventoryFor(database, restored);
  await bindInventory(database, inventory);
  const row = (
    await database.query(
      'SELECT native_completed_at,consent_completed_at FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2',
      [restored.generation, id],
    )
  ).rows[0];
  if (!row) return { pending: 'original-progress-unavailable' };
  const deployment = (
    await database.query<{ armed: boolean }>(
      'SELECT armed FROM auth_native_role_deployment WHERE singleton AND version=1',
    )
  ).rows[0];
  const generation = (
    await database.query<{ native_coverage_started: boolean }>(
      'SELECT native_coverage_started FROM auth_restore_generation WHERE generation=$1',
      [restored.generation],
    )
  ).rows[0]!;
  if (!deployment?.armed || !generation.native_coverage_started) {
    await installNativeRoleCoverage(database);
    const connection = await database.connect();
    try {
      await connection.query('BEGIN');
      // Same deployment lock order as native role discovery. An older image's
      // EOF cannot classify reintroduced version-zero rows for a new image.
      await connection.query('SELECT 1 FROM auth_native_role_deployment WHERE singleton FOR UPDATE');
      const claimed = await connection.query(
        `UPDATE auth_restore_generation SET native_coverage_started=true
         WHERE generation=$1 AND NOT native_coverage_started RETURNING generation`,
        [restored.generation],
      );
      if (claimed.rowCount) {
        await connection.query('UPDATE auth_native_role_deployment SET store_index=0 WHERE singleton');
        await connection.query('UPDATE auth_copy_coverage SET native_covered=false WHERE singleton');
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    return { pending: 'native-replay-pending' };
  }
  if (await reconcileNativeRoleCoveragePage(database)) return { pending: 'native-replay-pending' };
  if (!row.native_completed_at || !row.consent_completed_at) {
    const page = await nativeErasurePage(database, id, runtime, restored.generation);
    return { pending: page.code === 'native-source' ? 'source-consumer-pending' : 'native-replay-pending' };
  }
  if (!(await erasureHistoryPage(database, id, restored.generation))) return { pending: 'receiving-closure-pending' };
  return { pending: 'external-owner-pending' };
}

/** FIRST is the Source owner's required initial cursor. Its opaque floor/cut,
 * point/feed APIs and live handoff must be consumed from the actual original
 * packages/auth-contract/src/auth-erasure-obligations.ts and
 * services/kernel/src/access/auth-erasure-obligations.ts declarations verbatim.
 * Neither exists in this revision, nor is there an owner-authored declaration
 * adapter. Do not invent a cursor/seal/provider here. Exact native import above
 * can proceed, but no generation can be admitted from native progress alone.
 */
export async function requireRestoredAuthAdmission(database: Pool, restored?: AuthRestoredGeneration): Promise<void> {
  if (!restored) {
    // Also refuse a database already marked RESTORED when configuration omits
    // the declaration. A copied old marker is not an admission for a new image.
    const marked = await database.query('SELECT generation FROM auth_restore_generation LIMIT 1');
    if (marked.rowCount) fail('restore-lineage-unavailable');
    return;
  }
  if (restored.kind !== 'RESTORED' || !key(restored.generation)) fail('restore-lineage-mismatch');
  // Record the declaration even when its owner is missing. NULL inventory is
  // explicitly UNVERIFIED, and can never authorize replay or admission. A later
  // construction cannot turn this same image into a fresh database by omission.
  await database.query('INSERT INTO auth_restore_generation(generation) VALUES ($1) ON CONFLICT DO NOTHING', [
    restored.generation,
  ]);
  const inventory = await inventoryFor(database, restored);
  await bindInventory(database, inventory);
  fail('source-authority-unavailable');
}
