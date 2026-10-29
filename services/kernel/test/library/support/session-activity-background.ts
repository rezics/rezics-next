import { newId, partitionOf } from '../../../src/route/route.ts';
import type { GrowthDatabase } from '../../support/growth.ts';

/** Unmeasured noise only; measured sessions always use the real native commands. */
export async function seedSessionActivityBackground(
  database: GrowthDatabase,
  route: number,
  accountId: string,
  count: number,
  time: Date,
) {
  const ids = Array.from({ length: count }, () => newId(route));
  const subjects = ids.map(() => newId(0x7b20));
  await database.admin.query(
    `INSERT INTO library.progress_session
    (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision, started_at, transaction_id, last_changed_at)
    SELECT $1, id, $2, subject, 'scalar_amount', 'minute', 0, 'abandoned', 2, $5, id, $5
    FROM unnest($3::uuid[], $4::uuid[]) AS background(id, subject)`,
    [route, accountId, ids, subjects, time],
  );
  await database.admin.query(
    `INSERT INTO library.progress_head (route, account_id, subject_id, last_changed_at)
    SELECT $1, $2, subject, $4 FROM unnest($3::uuid[]) AS subject`,
    [route, accountId, subjects, time],
  );
  await database.admin.query(
    `INSERT INTO library.progress_change (route, session_id, change_no, intent, recorded_at, transaction_id)
    SELECT $1, id, 2, '{"amount":"1"}'::jsonb, $3, id FROM unnest($2::uuid[]) AS id`,
    [route, ids, time],
  );
}

/** Keep the command-receipt relation out of the small-table planner transition too. */
export async function seedSessionActivityReceipts(database: GrowthDatabase, route: number, accountId: string) {
  const ids = Array.from({ length: 4096 }, () => newId(route));
  await database.admin.query(
    `INSERT INTO core.receipt
    (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
     epoch, position, transaction_id, response)
    SELECT $1, 'account', $2, 'progress_session.record', id::text, decode(repeat('ab', 32), 'hex'),
      1, n, id, '{}'::jsonb FROM unnest($3::uuid[]) WITH ORDINALITY AS background(id, n)`,
    [partitionOf(route), accountId, ids],
  );
}
