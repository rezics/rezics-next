import type { PoolClient } from 'pg';
import type { CloudEvent } from '../events/log.ts';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from '../events/contracts/access.ts';
import {
  countRoute,
  countTransaction,
  lockCountOwner,
  ZERO_COUNT_KEY,
  type CountRuntime,
} from './follow-count-source.ts';

export const FOLLOW_COUNT_ACCOUNT_EVENTS = [
  'com.rezics.access.account.suspended.v1',
  'com.rezics.access.account.reinstated.v1',
  'com.rezics.access.operator.subject-fenced.v1',
  'com.rezics.access.operator.subject-unfenced.v1',
] as const;

/** The real Effect.admit client commits owner admission before enqueue and relay checkpoint.
 * Event ID deduplicates keyed replay; event time, never workflow time, ages the item. */
export async function admitFollowCountAccount(client: PoolClient, event: CloudEvent) {
  const type = FOLLOW_COUNT_ACCOUNT_EVENTS.find((type) => type === event.type);
  if (
    !type ||
    !Value.Check(ACCESS_EVENTS[type], event.data) ||
    typeof event.data !== 'object' ||
    event.data === null ||
    !('accountId' in event.data) ||
    typeof event.data.accountId !== 'string' ||
    !Number.isFinite(Date.parse(event.time))
  )
    throw new TypeError('Invalid follow count account event');
  const accountId = event.data.accountId,
    route = countRoute(accountId);
  const current = (
    await client.query<{ state: string }>(
      'SELECT state FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
      [route, accountId],
    )
  ).rows[0];
  // Terminal erasure has its own fixed Library participant. Never recreate private work after T.
  if (!current || current.state === 'deleted') return;
  const inserted = await client.query(
    `INSERT INTO library.follow_count_account_signal(route,account_id,event_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
    [route, accountId, event.id],
  );
  if (!inserted.rowCount) return;
  await client.query(
    `INSERT INTO library.follow_count_account_work(route,account_id,oldest_pending_at)
    VALUES($1,$2,$3) ON CONFLICT(route,account_id) DO UPDATE SET revision=library.follow_count_account_work.revision+1,
    after_id=NULL,scan_complete=false,oldest_pending_at=LEAST(library.follow_count_account_work.oldest_pending_at,EXCLUDED.oldest_pending_at)`,
    [route, accountId, event.time],
  );
}

/** Account reset, source replacements and cursor commit under the same native owner mutex.
 * Target acknowledgements, rather than scan completion, release the oldest pending age. */
export async function reconcileFollowCountAccountPage(deps: CountRuntime, accountId: string) {
  return countTransaction(deps, countRoute(accountId), 'library.follow-count.account-page', async (tx) => {
    const owner = await lockCountOwner(tx, accountId);
    if (owner.terminal) return { examined: 0, complete: false };
    const work = (
      await tx.query<{ revision: string; after_id: string | null; oldest_pending_at: string; scan_complete: boolean }>(
        `SELECT revision::text,after_id,oldest_pending_at::text,scan_complete FROM library.follow_count_account_work
       WHERE route=$1 AND account_id=$2 FOR UPDATE`,
        [owner.route, accountId],
      )
    ).rows[0];
    if (!work) return { examined: 0, complete: true };
    const rows = work.scan_complete
      ? []
      : (
          await tx.query<{ target_id: string }>(
            `WITH page AS MATERIALIZED (
      SELECT s.target_type,s.target_id,s.desired_eligible,(f.state='following' AND $4) IS TRUE AS eligible
      FROM library.follow_count_source s LEFT JOIN library.follow f
        ON f.route=s.route AND f.account_id=s.account_id AND f.target_id=s.target_id AND f.target_type=s.target_type
      WHERE s.route=$1 AND s.account_id=$2 AND s.target_id>$3 ORDER BY s.target_id LIMIT 100
    ) UPDATE library.follow_count_source s SET revision=s.revision+CASE WHEN s.desired_eligible IS DISTINCT FROM p.eligible THEN 1 ELSE 0 END,
      desired_eligible=p.eligible,pending_since=LEAST(s.pending_since,$5::timestamptz)
      FROM page p WHERE s.route=$1 AND s.account_id=$2 AND s.target_type=p.target_type AND s.target_id=p.target_id
      RETURNING s.target_id`,
            [owner.route, accountId, work.after_id ?? ZERO_COUNT_KEY, owner.active, work.oldest_pending_at],
          )
        ).rows;
    // RETURNING has no ordering promise; seek uses the maximum examined immutable ID.
    const last =
      rows
        .map((row) => row.target_id)
        .sort()
        .at(-1) ?? work.after_id;
    const complete = work.scan_complete || rows.length < 100;
    await tx.query(
      `UPDATE library.follow_count_account_work SET after_id=$3,scan_complete=$4
      WHERE route=$1 AND account_id=$2 AND revision=$5`,
      [owner.route, accountId, last, complete, work.revision],
    );
    const pending = await tx.query(
      `SELECT 1 FROM library.follow_count_source WHERE route=$1 AND account_id=$2
      AND pending_since IS NOT NULL ORDER BY pending_since,target_type,target_id LIMIT 1`,
      [owner.route, accountId],
    );
    if (complete && !pending.rowCount)
      await tx.query(`DELETE FROM library.follow_count_account_work WHERE route=$1 AND account_id=$2 AND revision=$3`, [
        owner.route,
        accountId,
        work.revision,
      ]);
    return { examined: rows.length, complete: complete && !pending.rowCount };
  });
}
