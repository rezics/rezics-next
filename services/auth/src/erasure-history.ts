import type { AuthErasureBarrier, AuthErasureSource, TrustedAccessPorts } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import { beginAuthReceivingClosure, recordAuthReceivingCopy } from './receiving-closure.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NATIVE_PHASE_END, nativePhaseComplete } from './erasure-role-upgrade.ts';
import { nativeRoleCoverageComplete } from './erasure-coverage.ts';
import { copyTransaction, completeCopy, eraseCopy } from './erasure-copy.ts';

type Progress = {
  id: string;
  account_id: string;
  kernel_version: number | null;
  kernel_at: string | null;
  source_continuation_id: string | null;
  source_receipt_id: string | null;
  source_accepted_at: Date | null;
  source_discharged_at: Date | null;
  source_published_at: Date | null;
  copies_completed_at: Date | null;
  copies_published_at: Date | null;
  native_completed_at: Date | null;
  native_role_version: number;
  native_phase_version: number;
  phase: number;
  consent_completed_at: Date | null;
};
const unavailable = () => new Error('Auth erasure proof binding unavailable');
function barrier(row: Progress): AuthErasureBarrier | null {
  return row.kernel_at && row.kernel_version
    ? { accountId: row.account_id, version: row.kernel_version, at: row.kernel_at }
    : null;
}
export async function bindErasureBarrier(database: Pool, id: string, value: AuthErasureBarrier) {
  await copyTransaction(database, async (client) => {
    const row = (await client.query<Progress>('SELECT * FROM auth_erasure WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (
      !row ||
      row.account_id !== value.accountId ||
      (row.kernel_at && (row.kernel_at !== value.at || row.kernel_version !== value.version))
    )
      throw new Error('Auth erasure barrier mismatch');
    await client.query('UPDATE auth_erasure SET kernel_version=$2,kernel_at=$3 WHERE id=$1', [
      id,
      value.version,
      value.at,
    ]);
  });
}
/** The fixed erase-auth-owner consumer transfers its COMPLETE remaining work to
 * the existing native obligation under its producer fence. Native pages need
 * only that obligation: never the continuation, approval, receipt body or caller.
 * This is a separate commit after acceptance and final validation. */
export async function dischargeErasureSource(database: Pool, id: string, value: AuthErasureSource) {
  await copyTransaction(database, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${value.accountId}`]);
    const changed = await client.query(
      `UPDATE auth_erasure SET source_discharged_at=COALESCE(source_discharged_at,clock_timestamp())
      WHERE id=$1 AND account_id=$2 AND kernel_version=$3 AND kernel_at=$4
      AND source_workflow_id=$7 AND source_continuation_id=$5 AND source_receipt_id=$6 AND source_accepted_at IS NOT NULL RETURNING id`,
      [id, value.accountId, value.version, value.at, value.continuationId, value.receiptId, DBOS.workflowID ?? null],
    );
    if (!changed.rowCount) throw new Error('Auth erasure source missing');
  });
}
/** One page/unit. Missing coverage, live consumers and unmapped copies stay pending. */
export async function erasureHistoryPage(database: Pool, id: string, restoreGeneration?: string): Promise<boolean> {
  const row = (await database.query<Progress>('SELECT * FROM auth_erasure WHERE id=$1', [id])).rows[0];
  if (!row || !barrier(row) || !row.source_accepted_at || !row.source_discharged_at || !row.source_published_at)
    return false;
  if (restoreGeneration) {
    const replay = (
      await database.query(
        `SELECT 1 FROM auth_restore_replay WHERE generation=$1 AND obligation_id=$2 AND phase=${NATIVE_PHASE_END}
       AND native_completed_at IS NOT NULL AND consent_completed_at IS NOT NULL`,
        [restoreGeneration, id],
      )
    ).rowCount;
    if (!replay) return false;
  } else if (!row.native_completed_at || !row.consent_completed_at) return false;
  // One account prefix, eight raw exact keys. Multiple roles never duplicate an
  // artifact's cleanup; removed scopes are bounded independently of its history.
  const page = (
    await database.query<{ workflow_id: string }>(
      'SELECT workflow_id FROM auth_copy_role WHERE account_id=$1 ORDER BY workflow_id,role LIMIT 8',
      [row.account_id],
    )
  ).rows;
  const work = page[0];
  if (work) {
    // Recover the actual result consumer from its native commitment. No HTTP
    // retry, old approval or resurrected session participates.
    const consumed = await completeCopy(database, work.workflow_id);
    if (!(await eraseCopy(database, work.workflow_id))) {
      const pending = (
        await database.query<{ sdk_fence_pending: string | null }>(
          'SELECT sdk_fence_pending FROM auth_copy_work WHERE workflow_id=$1',
          [work.workflow_id],
        )
      ).rows[0]?.sdk_fence_pending;
      if (consumed && pending)
        await database.query('UPDATE auth_erasure SET pending_code=$2 WHERE id=$1', [id, pending]);
      return false;
    }
    if (!(await recordAuthReceivingCopy(database, id, work.workflow_id))) return false;
    await database.query('DELETE FROM auth_copy_role WHERE account_id=$1 AND workflow_id=$2', [
      row.account_id,
      work.workflow_id,
    ]);
    return false;
  }
  const covered = (
    await database.query(
      'SELECT 1 FROM auth_copy_coverage WHERE singleton AND version=1 AND covered AND native_covered',
    )
  ).rowCount;
  if (
    !covered ||
    row.native_role_version !== 1 ||
    (!restoreGeneration && !nativePhaseComplete(row)) ||
    !(await nativeRoleCoverageComplete(database))
  )
    return false;
  if (restoreGeneration) {
    await database.query(
      `UPDATE auth_restore_replay SET copies_completed_at=COALESCE(copies_completed_at,clock_timestamp()),
       pending_code='external-owner-pending' WHERE generation=$1 AND obligation_id=$2`,
      [restoreGeneration, id],
    );
    return true;
  }
  await database.query(
    `UPDATE auth_erasure SET copies_completed_at=COALESCE(copies_completed_at,clock_timestamp()),
    inventory_coverage='covered',pending_code='proof-submission' WHERE id=$1`,
    [id],
  );
  return true;
}
/** Every Auth query has released its connection before any trusted kernel call.
 * A lost reply replays the same immutable tuple from permanent native progress. */
export async function publishErasureProofs(database: Pool, ports: TrustedAccessPorts, id: string): Promise<number> {
  // Genuine original source consumption still redrives independently. A marked
  // image cannot publish carried history completion as closure of restored bytes.
  const restored = Boolean((await database.query('SELECT 1 FROM auth_restore_generation LIMIT 1')).rowCount);
  const row = (await database.query<Progress>('SELECT * FROM auth_erasure WHERE id=$1', [id])).rows[0];
  if (!row) return 0;
  const root = barrier(row);
  if (!root) return 0;
  if (row.source_discharged_at && !row.source_published_at) {
    if (!ports.recordAuthNativeConsumption || !row.source_continuation_id || !row.source_receipt_id)
      throw unavailable();
    await ports.recordAuthNativeConsumption({
      ...root,
      continuationId: row.source_continuation_id,
      receiptId: row.source_receipt_id,
    });
    await database.query(
      'UPDATE auth_erasure SET source_published_at=COALESCE(source_published_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
  }
  // An older ordinal/copy completion is not evidence of the added native roles.
  // Recovered obligations revisit the same native engine and any exact local
  // copy roles before their existing immutable completion can be published.
  const historyCovered =
    !restored &&
    row.copies_completed_at &&
    !row.copies_published_at &&
    row.native_role_version === 1 &&
    nativePhaseComplete(row) &&
    (await nativeRoleCoverageComplete(database)) &&
    row.native_completed_at &&
    row.consent_completed_at &&
    row.source_discharged_at &&
    (
      await database.query(
        `SELECT 1 FROM auth_copy_coverage
      WHERE singleton AND version=1 AND covered AND native_covered
      AND NOT EXISTS(SELECT 1 FROM auth_copy_role WHERE account_id=$1 LIMIT 1)`,
        [row.account_id],
      )
    ).rowCount;
  if (historyCovered) {
    if (!ports.recordAuthHistoryCompletion) throw unavailable();
    await ports.recordAuthHistoryCompletion(root);
    await database.query(
      'UPDATE auth_erasure SET copies_published_at=COALESCE(copies_published_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
  }
  // Current receiving publication is independently pending. Its unavailable
  // owner/home cannot hold the original discharged-source transfer hostage.
  const receivingDeadline = Date.now() + 5000;
  await beginAuthReceivingClosure(database, ports, id, receivingDeadline).catch(() => false);
  if (ports.publishAuthReceivingClosure)
    await ports
      .publishAuthReceivingClosure({ barrier: root, nativeObligationId: id, deadline: receivingDeadline })
      .catch(() => false);
  return 1;
}
export async function redriveErasureHistory(database: Pool, ports: TrustedAccessPorts): Promise<number> {
  const row = (
    await database.query<{ id: string }>(`SELECT id FROM auth_erasure WHERE copies_published_at IS NULL
    ORDER BY revision,id LIMIT 1`)
  ).rows[0];
  if (!row) return 0;
  await database.query('UPDATE auth_erasure SET revision=revision+1 WHERE id=$1', [row.id]);
  // Publish the discharged source before any later copy/consumer work. Neither
  // a live copy nor a failed final submission holds this phase hostage.
  let published = 0;
  try {
    published = await publishErasureProofs(database, ports, row.id);
  } catch {
    // Publication retains its permanent pending phase. It cannot hold already
    // authorized local cleanup hostage to a participant reply or unavailable port.
  }
  if (await erasureHistoryPage(database, row.id)) {
    try {
      return await publishErasureProofs(database, ports, row.id);
    } catch {
      return published;
    }
  }
  return published;
}
