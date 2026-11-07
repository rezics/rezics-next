import type { PoolClient } from 'pg';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem-error.ts';
import { routeOf } from '../route/route.ts';

type Client = Pick<PoolClient, 'query'>;
/** Exact native SQL text; never round-trip this seek key through Date. */
export type OwnerActivitySeek = Readonly<{ lastActivityAt: string; subjectId: string }>;

/** Proactive bounded backfill within the existing owner's operational fence. */
export async function stepOwnerChronology(tx: OperationalTransaction, accountId: string): Promise<void> {
  if (!hasLiveOperationalTransaction(tx)) throw new TypeError('Owner chronology needs a live operational transaction');
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid owner account');
  const key = [route, accountId];
  const control = (
    await tx.query<{ ready: boolean; after: string | null }>(
      `SELECT chronology_ready AS ready,activity_after_subject AS after FROM library.owner_index_control
      WHERE route=$1 AND account_id=$2 AND phase='ready' FOR UPDATE`,
      key,
    )
  ).rows[0];
  if (!control || control.ready) return;
  const rows = (
    await tx.query<{ subject: string }>(
      `SELECT subject_id AS subject FROM library.owner_member_index
      WHERE route=$1 AND account_id=$2 AND ($3::uuid IS NULL OR subject_id>$3)
      ORDER BY subject_id LIMIT 100`,
      [...key, control.after],
    )
  ).rows;
  // These are at most 100 indexed point computations, including unchanged rows.
  await tx.query(`SELECT library.refresh_owner_activity($1,$2,s) FROM unnest($3::uuid[]) s`, [
    ...key,
    rows.map((row) => row.subject),
  ]);
  await tx.query(
    `UPDATE library.owner_index_control SET chronology_ready=$3,activity_after_subject=$4
      WHERE route=$1 AND account_id=$2`,
    [...key, rows.length < 100, rows.length < 100 ? null : rows.at(-1)!.subject],
  );
}

/** Raw chronological ORIGINAL candidates, never canonical/public membership or a successful useful page. */
export async function readOwnerOriginalActivityPrefix(
  client: Client,
  accountId: string,
  after: OwnerActivitySeek | null,
  limit: number,
): Promise<OwnerActivitySeek[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Owner activity limit must be 1..100');
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid owner account');
  const key = [route, accountId];
  const control = (
    await client.query<{ ready: boolean }>(
      `SELECT chronology_ready AND phase='ready' AS ready FROM library.owner_index_control
      WHERE route=$1 AND account_id=$2`,
      key,
    )
  ).rows[0];
  if (!control?.ready) throw new ProblemError('semantic_not_ready');
  const unknown = await client.query(
    `SELECT 1 FROM library.owner_member_index WHERE route=$1 AND account_id=$2 AND activity_unknown LIMIT 1`,
    key,
  );
  if (unknown.rows.length) throw new ProblemError('semantic_not_ready');
  return (
    await client.query<OwnerActivitySeek>(
      `SELECT subject_id AS "subjectId",to_char(activity_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt" FROM library.owner_member_index
      WHERE route=$1 AND account_id=$2 AND activity_at IS NOT NULL
        AND ($3::timestamptz IS NULL OR activity_at<$3 OR (activity_at=$3 AND subject_id>$4::uuid))
      ORDER BY activity_at DESC,subject_id ASC LIMIT $5`,
      [...key, after?.lastActivityAt ?? null, after?.subjectId ?? null, limit],
    )
  ).rows;
}
