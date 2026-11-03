import type { Pool } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';

/** One indexed due window, then exact episode deletes under the shared account/command barrier. */
export async function purgeLabelConsolidations(deps: { pool: Pool; clock?: KernelClock }, partition: number) {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096) throw new RangeError('Invalid partition');
  const due = await withConnection(deps.pool, async tx => {
    const time = await mintReadTime(tx, deps.clock);
    try {
      return (await tx.query<{ route: number; account_id: string; consolidation_id: string; expires_at: string }>(
        `SELECT route,account_id,consolidation_id,expires_at::text FROM library.label_consolidation
         WHERE partition_no=$1 AND expires_at<=$2::timestamptz ORDER BY expires_at,route,account_id LIMIT 100`,
        [partition, authoritativeTimeValue(time)],
      )).rows;
    } finally { releaseOperationalTime(time); }
  });
  let removed = 0;
  for (const key of due) {
    try {
      const result = await runCommand(deps.pool, {
        partition, clock: deps.clock, deadline: deadlineFor(5000), authorization: {
          action: 'library:label-retention-maintenance', resource: { route: key.route, id: key.account_id },
          denied: () => new LifecycleDeniedError(),
          async authorize(tx) { await shareAccount(tx, key.account_id); return 'execute'; },
        },
      }, async (tx, command) => {
        const deleted = await tx.query(
          `DELETE FROM library.label_consolidation WHERE route=$1 AND account_id=$2 AND consolidation_id=$3
           AND expires_at=$4::timestamptz AND expires_at<=$5::timestamptz`,
          [key.route, key.account_id, key.consolidation_id, key.expires_at, authoritativeTimeValue(command.time)],
        );
        return noEffect(deleted.rowCount ?? 0);
      });
      removed += result.value;
    } catch (error) { if (!(error instanceof LifecycleDeniedError)) throw error; }
  }
  return { examined: due.length, removed };
}
