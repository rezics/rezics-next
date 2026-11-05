import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../request/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { CommandTransaction } from '../command/command.ts';

export const DISCOVERY_ROUTE = 0;
export const DISCOVERY_PARTITION = 0;
export const DISCOVERY_APPLIED = 'com.rezics.community.realm-discovery.applied.v1';
export const DISCOVERY_EXPIRED = 'com.rezics.community.realm-discovery.expired.v1';
export type DiscoveryState = {
  realm_id: string;
  realm_epoch: string;
  applied_generation: string;
  settled: boolean;
  cutoff: string;
  popular: string;
  trending: string;
};
export const stateColumns = `realm_id,realm_epoch,applied_generation::text,settled,cutoff::text,popular::text,trending::text`;

/** One released native home snapshot. Deadline/move failures never turn into missing rows. */
export async function discoverySnapshot<T>(
  pool: Pool,
  partition: number,
  deadline: number,
  read: (client: Pick<PoolClient, 'query'>, epoch: number) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new AccessUnavailableError('deadline');
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const anchor = await readPartition(client, partition);
      if (!anchor) throw new CommandUnavailableError('moved', partition);
      if (anchor.writeState !== 'active')
        throw new CommandUnavailableError(anchor.writeState, partition, anchor.movedTo);
      const value = await read(client, anchor.epoch);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  });
}

export async function queueDiscoveryDue(
  tx: CommandTransaction,
  kind: string,
  realmId: string,
  epoch: string,
  key: string,
  day: string,
  dueAt: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO community.discovery_due(route,kind,realm_id,realm_epoch,key,day,due_at)
    VALUES(0,$1,$2,$3,$4,$5,$6) ON CONFLICT(route,kind,realm_id,realm_epoch,key,day)
    DO UPDATE SET due_at=EXCLUDED.due_at`,
    [kind, realmId, epoch, key, day, dueAt],
  );
}

export function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Only the 31 retained Realm days; board/thread history is never consulted. */
export async function refreshDiscoveryTotals(tx: CommandTransaction, realmId: string, cutoff: string): Promise<void> {
  await tx.query(`DELETE FROM community.discovery_day WHERE route=0 AND realm_id=$1 AND creation_day<$2::date-30`, [
    realmId,
    cutoff,
  ]);
  await tx.query(
    `UPDATE community.discovery_realm SET cutoff=$2,
    popular=(SELECT COALESCE(sum(count),0) FROM community.discovery_day
      WHERE route=0 AND realm_id=$1 AND creation_day >= $2::date-30 AND creation_day < $2::date),
    trending=(SELECT COALESCE(sum(count),0) FROM community.discovery_day
      WHERE route=0 AND realm_id=$1 AND creation_day=$2::date-1)
    WHERE route=0 AND realm_id=$1`,
    [realmId, cutoff],
  );
  // Rollover key does not carry an epoch, so an old timer cannot replace a new epoch's work.
  await queueDiscoveryDue(tx, 'realm', realmId, '', realmId, '1970-01-01', `${dayAfter(cutoff, 1)}T00:00:00Z`);
}

export async function addDiscoveryDay(
  tx: CommandTransaction,
  realmId: string,
  day: string,
  change: bigint,
): Promise<void> {
  if (change === 0n) return;
  if (change < 0n) {
    const result = await tx.query(
      `UPDATE community.discovery_day SET count=count+$3::bigint
      WHERE route=0 AND realm_id=$1 AND creation_day=$2 RETURNING count`,
      [realmId, day, change.toString()],
    );
    if (result.rowCount !== 1) throw new Error('Discovery day predecessor unavailable');
    return;
  }
  await tx.query(
    `INSERT INTO community.discovery_day(route,realm_id,creation_day,count) VALUES(0,$1,$2,$3)
    ON CONFLICT(route,realm_id,creation_day) DO UPDATE SET count=community.discovery_day.count+$3::bigint`,
    [realmId, day, change.toString()],
  );
}
