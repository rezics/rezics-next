import type { AuthErasureBarrier, AuthErasureSource, TrustedAccessPorts } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { copyTransaction, completeCopy, eraseCopy } from './erasure-copy.ts';

type Progress = {
  id: string;
  account_id: string;
  kernel_version: number | null;
  kernel_at: string | null;
  source_continuation_id: string | null;
  source_receipt_id: string | null;
  source_discharged_at: Date | null;
  source_published_at: Date | null;
  copies_completed_at: Date | null;
  copies_published_at: Date | null;
  native_completed_at: Date | null;
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
export async function erasureHistoryPage(database: Pool, id: string): Promise<boolean> {
  const row = (await database.query<Progress>('SELECT * FROM auth_erasure WHERE id=$1', [id])).rows[0];
  if (!row || !barrier(row) || !row.native_completed_at || !row.consent_completed_at || !row.source_discharged_at)
    return false;
  if (row.copies_completed_at) return true;
  const covered = (
    await database.query(
      'SELECT 1 FROM auth_copy_coverage WHERE singleton AND version=1 AND covered AND native_covered',
    )
  ).rowCount;
  if (!covered) return false;
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
    await completeCopy(database, work.workflow_id);
    if (!(await eraseCopy(database, work.workflow_id))) return false;
    await database.query('DELETE FROM auth_copy_role WHERE account_id=$1 AND workflow_id=$2', [
      row.account_id,
      work.workflow_id,
    ]);
    return false;
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
  if (row.copies_completed_at && !row.copies_published_at) {
    if (!ports.recordAuthHistoryCompletion) throw unavailable();
    await ports.recordAuthHistoryCompletion(root);
    await database.query(
      'UPDATE auth_erasure SET copies_published_at=COALESCE(copies_published_at,clock_timestamp()) WHERE id=$1',
      [id],
    );
  }
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
  const published = await publishErasureProofs(database, ports, row.id);
  if (await erasureHistoryPage(database, row.id)) return publishErasureProofs(database, ports, row.id);
  return published;
}
