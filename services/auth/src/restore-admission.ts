import { NATIVE_PHASE_END } from './erasure-role-upgrade.ts';
import type {
  AuthErasureBarrier,
  AuthErasureObligation,
  AuthErasureObligationCut,
  AuthErasureObligationCursor,
  AuthErasureObligationPage,
  AuthErasureObligationPorts,
  AuthErasureObligationVerification,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import { nativeErasurePage } from './erasure-native.ts';
import { erasureHistoryPage } from './erasure-history.ts';
import { installNativeRoleCoverage, reconcileNativeRoleCoveragePage } from './erasure-coverage.ts';
import type { NativeConsumerRuntime } from './erasure-consumers.ts';
import type { AuthErasureLivePorts, AuthErasureLiveReceiver } from '@rezics/auth-contract';
import type { KindConsentInvalidationReceiver } from '@rezics/auth-contract';
import { reconcileRestoredAuthPage, stageRestoredAuthLive, restoreDatabaseWithin } from './restore-live.ts';

export type AuthRestorePendingCode =
  | 'database-owner-unavailable'
  | 'restore-lineage-unavailable'
  | 'restore-lineage-mismatch'
  | 'original-progress-unavailable'
  | 'original-progress-mismatch'
  | 'source-authority-unavailable'
  | 'source-consumer-pending'
  | 'source-live-handoff-pending'
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
    deadline?: number | undefined;
  }): Promise<AuthRestoreInventory | { pending: 'restore-lineage-unavailable' | 'restore-lineage-mismatch' }>;
  recoverCommittedNativeProgress(input: {
    inventory: AuthRestoreInventory;
    accountId: string;
    deadline?: number | undefined;
  }): Promise<AuthRestoreNativeProgress | { pending: 'original-progress-unavailable' }>;
}

export interface AuthRestoredGeneration {
  /** Fixed native control operations; neither inventory nor live enrollment installs custody. */
  receiving?: Partial<import('@rezics/auth-contract').AuthReceivingClosurePorts>;
  kind: 'RESTORED';
  generation: string;
  databaseOwner?: AuthRestoreDatabaseOwner;
  /** Fixed native Access capability, supplied by trusted service/host composition.
   * No kernel pool or runtime request field crosses this boundary. */
  obligations?: AuthErasureObligationPorts;
  /** Trusted composition binds the original native Source factory to this exact
   * verified receiver. This is not a request or a readiness callback. */
  live?: (receiver: AuthErasureLiveReceiver) => AuthErasureLivePorts;
  /** Native same-home Kind invalidation receiver required before restored Auth
   * admissions can reopen when the restored image contains enrolled consumers. */
  kindConsentReceiver?: KindConsentInvalidationReceiver;
}

function fail(code: AuthRestorePendingCode): never {
  throw new AuthRestoreAdmissionError(code);
}
const key = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 64 && Number.isFinite(Date.parse(value));
const instant = (value: Date | string | null) => (value === null ? null : new Date(value).getTime());

/** A timeout can refuse work, never certify authority. Late owner replies are
 * ignored; no Auth checkout is held while these trusted reads are outstanding. */
async function boundedRead<T>(
  deadline: number | undefined,
  read: () => Promise<T>,
  pending: AuthRestorePendingCode,
): Promise<T> {
  if (deadline === undefined) return read();
  if (Date.now() >= deadline) fail(pending);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AuthRestoreAdmissionError(pending)), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function inventoryFor(
  database: Pool,
  restored: AuthRestoredGeneration,
  deadline?: number,
): Promise<AuthRestoreInventory> {
  if (restored.kind !== 'RESTORED' || !key(restored.generation)) fail('restore-lineage-mismatch');
  // NULL inventory records only the declaration, never verified backup evidence.
  // Failed native recovery must also keep later construction closed by omission.
  await restoreDatabaseWithin(database, deadline ?? Date.now() + 5000).query(
    'INSERT INTO auth_restore_generation(generation) VALUES ($1) ON CONFLICT DO NOTHING',
    [restored.generation],
  );
  if (!restored.databaseOwner) fail('database-owner-unavailable');
  let result: Awaited<ReturnType<AuthRestoreDatabaseOwner['verifyRestoredDatabase']>>;
  try {
    result = await boundedRead(
      deadline,
      () => restored.databaseOwner!.verifyRestoredDatabase({ database, generation: restored.generation, deadline }),
      'restore-lineage-unavailable',
    );
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
  // Keep only the nonsecret contract fields, not an owner's extra record fields.
  return {
    generation: result.generation,
    databaseIdentity: result.databaseIdentity,
    inventoryEntry: result.inventoryEntry,
    inventoryVersion: result.inventoryVersion,
    sourceCluster: result.sourceCluster,
    sourceTimeline: result.sourceTimeline,
    sourceLineage: result.sourceLineage,
    capturePoint: result.capturePoint,
    committedNativeTail: result.committedNativeTail,
  };
}

export async function bindInventory(database: Pool, inventory: AuthRestoreInventory) {
  // A single exact identity; this is NOT a backup catalogue or physical proof.
  const result = await database.query(
    `INSERT INTO auth_restore_generation(generation,inventory) VALUES ($1,$2::jsonb)
     ON CONFLICT(generation) DO UPDATE SET inventory=EXCLUDED.inventory
     WHERE auth_restore_generation.inventory IS NULL OR auth_restore_generation.inventory=EXCLUDED.inventory RETURNING generation`,
    [inventory.generation, JSON.stringify(inventory)],
  );
  if (!result.rowCount) fail('restore-lineage-mismatch');
  const live = await database.query(
    `INSERT INTO auth_restore_live_generation(generation,inventory,source_cut_id)
     SELECT generation,inventory,source_cut_id FROM auth_restore_generation WHERE generation=$1
     ON CONFLICT(generation) DO UPDATE SET generation=EXCLUDED.generation
     WHERE auth_restore_live_generation.inventory=EXCLUDED.inventory
     AND auth_restore_live_generation.source_cut_id=EXCLUDED.source_cut_id RETURNING generation`,
    [inventory.generation],
  );
  if (!live.rowCount) fail('restore-lineage-mismatch');
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
  const deadline = Date.now() + 5000;
  const inventory = await inventoryFor(database, restored, deadline);
  if (!key(accountId)) fail('original-progress-mismatch');
  const obligation = restored.obligations ? await sourcePoint(restored.obligations, accountId, deadline) : undefined;
  return importProgress(database, restored, inventory, accountId, obligation, deadline);
}

export async function importProgress(
  database: Pool,
  restored: AuthRestoredGeneration,
  inventory: AuthRestoreInventory,
  accountId: string,
  obligation?: AuthErasureObligation,
  deadline?: number,
): Promise<string> {
  let progress: Awaited<ReturnType<AuthRestoreDatabaseOwner['recoverCommittedNativeProgress']>>;
  try {
    progress = await boundedRead(
      deadline,
      () => restored.databaseOwner!.recoverCommittedNativeProgress({ inventory, accountId, deadline }),
      'original-progress-unavailable',
    );
  } catch {
    return fail('original-progress-unavailable');
  }
  if (!progress || typeof progress !== 'object') fail('original-progress-unavailable');
  if ('pending' in progress) fail(progress.pending);
  progress = normalizeProgress(progress, accountId);
  if (deadline !== undefined && Date.now() >= deadline) fail('source-consumer-pending');
  if (
    obligation &&
    (progress.source.route !== obligation.route ||
      progress.source.version !== obligation.version ||
      progress.source.at !== obligation.at ||
      String(progress.floor) !== obligation.minimumAuthnEpoch)
  )
    fail('original-progress-mismatch');
  const receiving = restored.receiving;
  if (!receiving?.invalidateAuthReceivingClosure || !receiving.registerAuthReceivingClosure)
    fail('receiving-closure-pending');
  const receivingDeadline = deadline ?? Date.now() + 5000;
  if (
    !(await receiving.invalidateAuthReceivingClosure({
      partition: Math.floor(progress.source.route / 16),
      restoreGeneration: restored.generation,
      deadline: receivingDeadline,
    }))
  )
    fail('receiving-closure-pending');
  const registration = await receiving.registerAuthReceivingClosure({
    barrier: {
      accountId: progress.source.accountId,
      version: progress.source.version,
      at: progress.source.at,
    },
    deadline: receivingDeadline,
  });
  if (
    registration.state !== 'bound' ||
    registration.binding.restoreGeneration !== restored.generation ||
    registration.binding.databaseIdentity !== inventory.databaseIdentity
  )
    fail('receiving-closure-pending');
  await bindInventory(database, inventory);
  // ALL owner reads have completed before this checkout. There is no foreign
  // call, wait or SDK recovery while holding a native producer lock.
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    if (deadline !== undefined) {
      if (Date.now() >= deadline) fail('source-consumer-pending');
      await connection.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
        String(Math.max(1, deadline - Date.now())),
      ]);
    }
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
    if (previous) {
      const imported = await connection.query<{ matches: boolean }>(
        `SELECT original_progress=$3::jsonb AS matches FROM auth_restore_replay
         WHERE generation=$1 AND obligation_id=$2 FOR UPDATE`,
        [restored.generation, previous.id, JSON.stringify(progress)],
      );
      if (imported.rows[0]) {
        if (!imported.rows[0].matches) fail('original-progress-mismatch');
        if (obligation) {
          const bound = await connection.query(
            `UPDATE auth_restore_replay SET source_obligation=$3::jsonb
             WHERE generation=$1 AND obligation_id=$2
             AND (source_obligation IS NULL OR source_obligation=$3::jsonb) RETURNING obligation_id`,
            [restored.generation, previous.id, JSON.stringify(obligation)],
          );
          if (!bound.rowCount) fail('original-progress-mismatch');
        }
        // Local native work may since have established its first cutoff or
        // published its genuine consumer proof. Never overwrite that progress
        // with the immutable evidence captured at the start of this generation.
        await connection.query(
          `INSERT INTO auth_restore_live_work(generation,obligation_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [restored.generation, previous.id],
        );
        await connection.query('COMMIT');
        return previous.id;
      }
    }
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
      `INSERT INTO auth_restore_replay(generation,obligation_id,original_progress,source_obligation)
       VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(generation,obligation_id)
       DO UPDATE SET generation=EXCLUDED.generation
       WHERE auth_restore_replay.original_progress=EXCLUDED.original_progress RETURNING obligation_id`,
      [restored.generation, row.id, JSON.stringify(progress), obligation ? JSON.stringify(obligation) : null],
    );
    if (!replay.rowCount) fail('original-progress-mismatch');
    await connection.query(
      `INSERT INTO auth_restore_live_work(generation,obligation_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [restored.generation, row.id],
    );
    await connection.query('COMMIT');
    return row.id;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeProgress(progress: AuthRestoreNativeProgress, accountId: string): AuthRestoreNativeProgress {
  const source = progress.source;
  if (
    !source ||
    source.accountId !== accountId ||
    !Number.isInteger(source.route) ||
    source.route < 0 ||
    source.route > 65535 ||
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
  const selected: AuthRestoreNativeProgress = {
    source: { accountId: source.accountId, route: source.route, version: source.version, at: source.at },
    originalNativeId: progress.originalNativeId,
    checkpoint: progress.checkpoint,
    floor: progress.floor,
    acceptedAt: progress.acceptedAt,
    applicable: progress.applicable,
    userDeletion:
      deletion.state === 'established'
        ? {
            state: 'established',
            deletedAt: deletion.deletedAt,
            consentDueAt: deletion.consentDueAt,
            consentCompletedAt: deletion.consentCompletedAt,
          }
        : { state: 'never-established' },
    consumer:
      consumer.state === 'accepted'
        ? {
            state: 'accepted',
            workflowId: consumer.workflowId,
            continuationId: consumer.continuationId,
            receiptId: consumer.receiptId,
            acceptedAt: consumer.acceptedAt,
            dischargedAt: consumer.dischargedAt,
            publishedAt: consumer.publishedAt,
          }
        : { state: 'pending' },
  };
  if (Buffer.byteLength(JSON.stringify(selected)) > 16384) fail('original-progress-mismatch');
  return selected;
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
  deadline = Date.now() + 5000,
): Promise<{ pending: AuthRestorePendingCode }> {
  const inventory = await inventoryFor(database, restored, deadline);
  database = restoreDatabaseWithin(database, deadline);
  await bindInventory(database, inventory);
  const row = (
    await database.query(
      'SELECT phase,native_completed_at,consent_completed_at FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2',
      [restored.generation, id],
    )
  ).rows[0];
  if (!row) return { pending: 'original-progress-unavailable' };
  const root = (
    await database.query<{ accountId: string; version: number; at: string; route: number | null }>(
      `SELECT account_id::text AS "accountId",kernel_version AS version,kernel_at AS at,source_route AS route
     FROM auth_erasure WHERE id=$1`,
      [id],
    )
  ).rows[0];
  const receiving = restored.receiving;
  if (
    !root ||
    root.route === null ||
    !receiving?.invalidateAuthReceivingClosure ||
    !receiving.registerAuthReceivingClosure
  )
    return { pending: 'receiving-closure-pending' };
  if (
    !(await receiving.invalidateAuthReceivingClosure({
      partition: Math.floor(root.route / 16),
      restoreGeneration: restored.generation,
      deadline,
    }))
  )
    return { pending: 'receiving-closure-pending' };
  const { route: _route, ...expected } = root;
  const registration = await receiving.registerAuthReceivingClosure({ barrier: expected, deadline });
  if (
    registration.state !== 'bound' ||
    registration.binding.restoreGeneration !== restored.generation ||
    registration.binding.databaseIdentity !== inventory.databaseIdentity
  )
    return { pending: 'receiving-closure-pending' };
  if (await reconcileRestoredAuthCoverage(database, restored)) return { pending: 'native-replay-pending' };
  if (row.phase !== NATIVE_PHASE_END || !row.native_completed_at || !row.consent_completed_at) {
    const page = await nativeErasurePage(database, id, runtime, restored.generation);
    return { pending: page.code === 'native-source' ? 'source-consumer-pending' : 'native-replay-pending' };
  }
  if (!(await erasureHistoryPage(database, id, restored.generation))) return { pending: 'receiving-closure-pending' };
  return { pending: 'external-owner-pending' };
}

/** One unit of the existing native deployment classifier, also needed when
 * the original Source cut contains no account obligations. Caller has verified
 * and bound this generation before invoking it. */
export async function reconcileRestoredAuthCoverage(
  database: Pool,
  restored: AuthRestoredGeneration,
): Promise<boolean> {
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
    return true;
  }
  if (await reconcileNativeRoleCoveragePage(database)) return true;
  return false;
}

/** Canonical native integer domains, checked as strings before conversion. */
const ordinal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const floor = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value) && BigInt(value) <= 2147483647n;
const partition = (value: number) => Number.isInteger(value) && value >= 0 && value < 4096;
function validCursor(value: AuthErasureObligationCursor): boolean {
  return !!value && partition(value.partition) && ordinal(value.afterOrdinal);
}
function validCut(cut: AuthErasureObligationCut, cutId: string): boolean {
  return (
    !!cut &&
    cut.cutId === cutId &&
    cut.participant === 'auth' &&
    cut.inventoryVersion === 1 &&
    cut.producerVersion === 1 &&
    cut.partitions === 4096 &&
    Number.isInteger(cut.sealedPartitions) &&
    cut.sealedPartitions >= 0 &&
    cut.sealedPartitions <= 4096
  );
}
export function exactObligation(value: AuthErasureObligation): AuthErasureObligation {
  if (
    !value ||
    !Number.isInteger(value.route) ||
    value.route < 0 ||
    value.route > 65535 ||
    !key(value.accountId) ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    value.version > 2147483647 ||
    !timestamp(value.at) ||
    !floor(value.minimumAuthnEpoch) ||
    !key(value.receiptId) ||
    !ordinal(value.ordinal) ||
    value.ordinal === '0' ||
    Buffer.byteLength(JSON.stringify(value)) > 1024
  )
    fail('original-progress-mismatch');
  return {
    route: value.route,
    accountId: value.accountId,
    version: value.version,
    at: value.at,
    minimumAuthnEpoch: value.minimumAuthnEpoch,
    receiptId: value.receiptId,
    ordinal: value.ordinal,
  };
}
const sameObligation = (a: AuthErasureObligation, b: AuthErasureObligation) =>
  JSON.stringify(exactObligation(a)) === JSON.stringify(exactObligation(b));
export async function sourceCall<T>(deadline: number, call: () => Promise<T>): Promise<T> {
  if (Date.now() >= deadline) fail('source-consumer-pending');
  try {
    const result = await boundedRead(deadline, call, 'source-consumer-pending');
    if (Date.now() >= deadline) fail('source-consumer-pending');
    return result;
  } catch (error) {
    if (error instanceof AuthRestoreAdmissionError) throw error;
    return fail('source-authority-unavailable');
  }
}
export async function sourcePoint(ports: AuthErasureObligationPorts, accountId: string, deadline: number) {
  const point = await sourceCall(deadline, () => ports.readAuthErasureObligation({ accountId, deadline }));
  if (!point || point.state !== 'ready') fail('source-consumer-pending');
  const obligation = exactObligation(point.obligation);
  if (obligation.accountId !== accountId) fail('original-progress-mismatch');
  return obligation;
}

type SourceCheckpoint = {
  source_cut_id: string;
  source_cursor: AuthErasureObligationCursor | null;
  source_verify_partition: number;
  source_revision: string;
};

/** One actual Source partition/page (max 48), or one current partition verifier.
 * Each foreign read runs after the previous Auth query/checkpoint has released
 * its checkout. CAS checkpoints make concurrent/crashed attempts replay the same
 * cut and page; a cut UUID is only a native locator, never backup evidence.
 * Native cleanup remains replayRestoredAuthPage's existing engine.
 */
export async function stageRestoredAuthObligations(
  database: Pool,
  restored: AuthRestoredGeneration,
  deadline = Date.now() + 5000,
): Promise<{ pending: AuthRestorePendingCode }> {
  const inventory = await inventoryFor(database, restored, deadline);
  database = restoreDatabaseWithin(database, deadline);
  await bindInventory(database, inventory);
  const ports = restored.obligations;
  if (!ports) return { pending: 'source-authority-unavailable' };
  const checkpoint = (
    await database.query<SourceCheckpoint>(
      `SELECT source_cut_id,source_cursor,source_verify_partition,source_revision
     FROM auth_restore_generation WHERE generation=$1`,
      [restored.generation],
    )
  ).rows[0]!;
  const cutId = checkpoint.source_cut_id;
  const cut = await sourceCall(deadline, () => ports.startAuthErasureObligationCut({ cutId, deadline }));
  if (!validCut(cut, cutId)) fail('source-consumer-pending');
  const cursor = checkpoint.source_cursor;
  if (cursor) {
    if (!validCursor(cursor)) fail('source-consumer-pending');
    const page = await sourceCall(deadline, () => ports.pageAuthErasureObligations({ cutId, cursor, deadline }));
    validatePage(page, cutId, cursor);
    for (const raw of page.obligations) {
      const obligation = exactObligation(raw);
      const current = await sourcePoint(ports, obligation.accountId, deadline);
      if (!sameObligation(current, obligation)) fail('original-progress-mismatch');
      await importProgress(database, restored, inventory, obligation.accountId, obligation, deadline);
    }
    // Pending/initializing pages may contain useful ready obligations, but their
    // next locator never skips an unresolved original floor or Source home.
    const advance = page.pending.length === 0 && (page.state === 'page' || page.state === 'partition-end');
    await checkpointSource(database, restored.generation, checkpoint, page, advance, deadline);
    return { pending: 'source-consumer-pending' };
  }
  if (checkpoint.source_verify_partition < 4096) {
    const selected = checkpoint.source_verify_partition;
    const verification = await sourceCall(deadline, () =>
      ports.verifyAuthErasureObligationCut({
        cutId,
        partition: selected,
        deadline,
      }),
    );
    const current = validVerification(verification, cutId, selected) && cut.sealedPartitions === 4096;
    await checkpointVerification(database, restored.generation, checkpoint, verification, current, deadline);
    return { pending: current && selected === 4095 ? 'source-live-handoff-pending' : 'source-consumer-pending' };
  }
  return stageRestoredAuthLive(database, restored, inventory, deadline);
}

function validatePage(page: AuthErasureObligationPage, cutId: string, cursor: AuthErasureObligationCursor) {
  if (
    !page ||
    Buffer.byteLength(JSON.stringify(page)) > 65536 ||
    !validCut(page.cut, cutId) ||
    !page.cursor ||
    page.cursor.partition !== cursor.partition ||
    page.cursor.afterOrdinal !== cursor.afterOrdinal ||
    !Array.isArray(page.obligations) ||
    !Array.isArray(page.pending) ||
    page.obligations.length + page.pending.length > 48 ||
    !['initializing', 'pending', 'page', 'partition-end'].includes(page.state)
  )
    fail('source-consumer-pending');
  let previous = BigInt(cursor.afterOrdinal);
  for (const item of page.obligations) {
    exactObligation(item);
    // Route matching belongs to Source, not the 4096-way feed cursor.
    if (BigInt(item.ordinal) <= previous) fail('source-consumer-pending');
    previous = BigInt(item.ordinal);
  }
  if (page.next !== null && !validCursor(page.next)) fail('source-consumer-pending');
  if (
    page.state === 'page' &&
    (!page.next ||
      page.next.partition !== cursor.partition ||
      BigInt(page.next.afterOrdinal) < previous ||
      BigInt(page.next.afterOrdinal) <= BigInt(cursor.afterOrdinal))
  )
    fail('source-consumer-pending');
  if (
    page.state === 'partition-end' &&
    (page.pending.length !== 0 ||
      (cursor.partition === 4095
        ? page.next !== null
        : !page.next || page.next.partition !== cursor.partition + 1 || page.next.afterOrdinal !== '0'))
  )
    fail('source-consumer-pending');
}
function validVerification(value: AuthErasureObligationVerification, cutId: string, selected: number): boolean {
  return (
    !!value &&
    value.cutId === cutId &&
    value.partition === selected &&
    value.state === 'current' &&
    key(value.sourceGeneration) &&
    key(value.sourceOwner) &&
    Number.isSafeInteger(value.sourceEpoch) &&
    value.sourceEpoch! >= 0 &&
    ordinal(value.highWater) &&
    ordinal(value.liveHighWater) &&
    value.highWater === value.liveHighWater
  );
}
async function checkpointSource(
  database: Pool,
  generation: string,
  checkpoint: SourceCheckpoint,
  page: AuthErasureObligationPage,
  advance: boolean,
  deadline: number,
) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    if (Date.now() >= deadline) fail('source-consumer-pending');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
      String(Math.max(1, deadline - Date.now())),
    ]);
    const changed = await client.query(
      `UPDATE auth_restore_generation SET source_cut=$3::jsonb,source_cursor=$4::jsonb,source_revision=source_revision+1
       WHERE generation=$1 AND source_revision=$2 RETURNING generation`,
      [
        generation,
        checkpoint.source_revision,
        JSON.stringify(page.cut),
        (advance ? page.next : checkpoint.source_cursor) === null
          ? null
          : JSON.stringify(advance ? page.next : checkpoint.source_cursor),
      ],
    );
    if (changed.rowCount)
      await client.query(
        `INSERT INTO auth_restore_source_partition(generation,partition,page) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(generation,partition) DO UPDATE SET page=EXCLUDED.page`,
        [generation, page.cursor.partition, JSON.stringify(page)],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function checkpointVerification(
  database: Pool,
  generation: string,
  checkpoint: SourceCheckpoint,
  verification: AuthErasureObligationVerification,
  current: boolean,
  deadline: number,
) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    if (Date.now() >= deadline) fail('source-consumer-pending');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
      String(Math.max(1, deadline - Date.now())),
    ]);
    const changed = await client.query(
      `UPDATE auth_restore_generation SET source_verify_partition=source_verify_partition+$3,source_revision=source_revision+1
       WHERE generation=$1 AND source_revision=$2 RETURNING generation`,
      [generation, checkpoint.source_revision, current ? 1 : 0],
    );
    if (changed.rowCount)
      await client.query(
        `UPDATE auth_restore_source_partition SET verification=$3::jsonb WHERE generation=$1 AND partition=$2`,
        [generation, checkpoint.source_verify_partition, JSON.stringify(verification)],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Admission precedes handler/issuer/SDK/maintenance construction. Native Source
 * staging is useful progress, never an assertion of external or physical custody.
 */
export async function requireRestoredAuthAdmission(database: Pool, restored?: AuthRestoredGeneration): Promise<void> {
  if (!restored) {
    const marked = await database.query('SELECT generation FROM auth_restore_generation LIMIT 1');
    if (marked.rowCount) fail('restore-lineage-unavailable');
    return;
  }
  const result = await reconcileRestoredAuthPage(database, restored);
  fail(result.pending);
}
