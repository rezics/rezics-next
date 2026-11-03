import type { PoolClient } from 'pg';
import { newId } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import { DIARY_LIFETIME_MS } from './diary-model.ts';
import type { DiaryOccurrence } from './diary-model.ts';

type Client = Pick<PoolClient, 'query'>;
export type DiaryRow = Pick<
  DiaryOccurrence,
  'id' | 'subjectId' | 'versionSubjectId' | 'state' | 'revision' | 'recordedStartedAt' | 'recordedCompletedAt'
>;
export type DiaryKey = { recordedStartedAt: string; id: string };
export type DiaryNavigation = {
  id: string;
  epoch: number;
  createdAt: string;
  expiresAt: string;
};

/** Separate initial/continuation statements keep the tuple seek in the index condition. */
export async function diaryRows(
  client: Client,
  route: number,
  accountId: string,
  after: DiaryKey | null,
  limit: number,
): Promise<DiaryRow[]> {
  const columns = `session_id AS id, subject_id AS "subjectId", version_subject_id AS "versionSubjectId",
    state, revision,
    to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedStartedAt",
    to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedCompletedAt"`;
  const parameters = after ? [route, accountId, after.recordedStartedAt, after.id, limit] : [route, accountId, limit];
  return (
    await client.query<DiaryRow>(
      `SELECT ${columns} FROM library.progress_session
     WHERE route=$1 AND account_id=$2
     ${after ? 'AND (started_at, session_id) < ($3::timestamptz, $4::uuid)' : ''}
     ORDER BY started_at DESC, session_id DESC LIMIT $${after ? 5 : 3}`,
      parameters,
    )
  ).rows;
}

/** The caller locks the native account first, serializing slot allocation with other diary requests. */
export async function createDiaryNavigation(
  client: Client,
  route: number,
  accountId: string,
  caller: string,
  epoch: number,
  now: Date,
): Promise<DiaryNavigation> {
  const id = newId(route);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DIARY_LIFETIME_MS).toISOString();
  const result = await client.query(
    `INSERT INTO library.diary_navigation
      (route,account_id,slot,navigation_id,caller,epoch,created_at,expires_at)
     SELECT $1,$2,slots.slot,$3,$4,$5,$6,$7 FROM generate_series(0,7) AS slots(slot)
     LEFT JOIN library.diary_navigation existing ON existing.route=$1 AND existing.account_id=$2
       AND existing.slot=slots.slot
     WHERE existing.slot IS NULL OR existing.expires_at <= $6::timestamptz
     ORDER BY slots.slot LIMIT 1
     ON CONFLICT (route,account_id,slot) DO UPDATE SET navigation_id=EXCLUDED.navigation_id,
       caller=EXCLUDED.caller,epoch=EXCLUDED.epoch,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at
     RETURNING navigation_id`,
    [route, accountId, id, caller, epoch, createdAt, expiresAt],
  );
  if (result.rowCount !== 1) throw new ProblemError('overloaded');
  return { id, epoch, createdAt, expiresAt };
}

export async function readDiaryNavigation(
  client: Client,
  route: number,
  accountId: string,
  id: string,
  caller: string,
): Promise<DiaryNavigation | null> {
  return (
    (
      await client.query<DiaryNavigation>(
        `SELECT navigation_id AS id, epoch,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
       to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
     FROM library.diary_navigation WHERE route=$1 AND account_id=$2 AND navigation_id=$3 AND caller=$4`,
        [route, accountId, id, caller],
      )
    ).rows[0] ?? null
  );
}

export async function cancelDiaryNavigation(client: Client, route: number, accountId: string, id: string) {
  await client.query('DELETE FROM library.diary_navigation WHERE route=$1 AND account_id=$2 AND navigation_id=$3', [
    route,
    accountId,
    id,
  ]);
}
