import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import {
  DISCOVERY_EXPIRED,
  DISCOVERY_PARTITION,
  discoverySnapshot,
  queueDiscoveryDue,
  refreshDiscoveryTotals,
  dayAfter,
} from './discovery-projection-store.ts';

type Due = {
  kind: 'realm' | 'bucket' | 'thread' | 'board';
  realm_id: string;
  realm_epoch: string;
  key: string;
  day: string;
  due_at: string;
};

/** A single shared-worker step consumes at most fifty indexed keys, including independent old storage cleanup. */
export async function expireRealmDiscovery(
  pool: Pool,
  options: { clock: () => Date; deadlineNow: () => number },
): Promise<number> {
  const now = options.clock();
  const due = await discoverySnapshot(
    pool,
    DISCOVERY_PARTITION,
    { deadline: options.deadlineNow() + 30_000, now: options.deadlineNow },
    async (client) =>
      (
        await client.query<Due>(
          `SELECT kind,realm_id,realm_epoch,key,day::text,due_at::text FROM community.discovery_due
      WHERE route=0 AND due_at <= $1 ORDER BY due_at,kind,realm_id,realm_epoch,key,day LIMIT 50`,
          [now.toISOString()],
        )
      ).rows,
  );
  for (const item of due) {
    await runCommand(pool, { partition: DISCOVERY_PARTITION, clock: options.clock }, async (tx, command) => {
      // Same lock order as source application. Timers never change generation, epoch or settled state.
      const state = (
        await tx.query<{ realm_epoch: string }>(
          `SELECT realm_epoch FROM community.discovery_realm
        WHERE route=0 AND realm_id=$1 FOR UPDATE`,
          [item.realm_id],
        )
      ).rows[0];
      const at = authoritativeTimeValue(command.time);
      const cutoff = new Date(at).toISOString().slice(0, 10);
      const deleted = await tx.query(
        `DELETE FROM community.discovery_due
        WHERE route=0 AND kind=$1 AND realm_id=$2 AND realm_epoch=$3 AND key=$4 AND day=$5
        AND due_at=$6 AND due_at <= $7 RETURNING key`,
        [item.kind, item.realm_id, item.realm_epoch, item.key, item.day, item.due_at, at],
      );
      if (!deleted.rowCount) return noEffect(null);
      const key = [item.realm_id, item.realm_epoch, item.key];
      if (item.kind === 'realm') {
        if (state) await refreshDiscoveryTotals(tx, item.realm_id, cutoff);
      } else if (item.kind === 'bucket') {
        await tx.query(
          `DELETE FROM community.discovery_bucket WHERE route=0 AND realm_id=$1 AND realm_epoch=$2
          AND board_id=$3 AND creation_day=$4`,
          [...key, item.day],
        );
      } else if (item.kind === 'thread') {
        await tx.query(
          `DELETE FROM community.discovery_thread WHERE route=0 AND realm_id=$1 AND realm_epoch=$2
          AND thread_id=$3 AND creation_day=$4`,
          [...key, item.day],
        );
      } else if (state?.realm_epoch !== item.realm_epoch) {
        await tx.query(
          `DELETE FROM community.discovery_board WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND board_id=$3`,
          key,
        );
      } else {
        await queueDiscoveryDue(
          tx,
          'board',
          item.realm_id,
          item.realm_epoch,
          item.key,
          item.day,
          `${dayAfter(cutoff, 31)}T00:00:00Z`,
        );
      }
      return {
        value: null,
        events: [
          { type: DISCOVERY_EXPIRED, subject: item.realm_id, data: { realmId: item.realm_id, kind: item.kind } },
        ],
      };
    });
  }
  return due.length;
}
