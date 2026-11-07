import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from './access-port.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf } from '../route/route.ts';
import { countRoute, countTransaction, lockCountOwner, type CountRuntime } from './follow-count-source.ts';
import { withdrawFollowCountDestination } from './follow-count-target.ts';

/** Durable age admission on the existing participant's real Effect.admit hook.
 * This account-only fence is retained after local exhaustion, so keyed late
 * relay replay cannot recreate a private source/account maintenance item. */
export async function admitFollowCountErasure(client: PoolClient, event: CloudEvent) {
  if (
    !Value.Check(ACCESS_EVENTS()['com.rezics.access.account-tombstoned.v1'], event.data) ||
    typeof event.data !== 'object' ||
    event.data === null ||
    !('accountId' in event.data) ||
    typeof event.data.accountId !== 'string' ||
    event.subject !== event.data.accountId ||
    !Number.isFinite(Date.parse(event.time))
  )
    throw new TypeError('Invalid follow count terminal event');
  const accountId = event.data.accountId,
    route = countRoute(accountId);
  const current = (
    await client.query<{ state: string; authn_fenced: boolean }>(
      'SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
      [route, accountId],
    )
  ).rows[0];
  if (current?.state !== 'deleted' || !current.authn_fenced)
    throw new Error('Count erasure admission requires the native terminal fence');
  await client.query(
    `INSERT INTO library.follow_count_terminal_source(partition_no,account_id,oldest_pending_at)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [partitionOf(route), accountId, event.time],
  );
}

/** Count-owned phase of the existing fixed Library participant. Exact source-home
 * receiving locators include negative and never-positive attempts. No phase ACKs Library. */
export async function purgeFollowCountsPage(deps: CountRuntime, accountId: string) {
  const route = countRoute(accountId);
  const destinations = await countTransaction(deps, route, 'library.follow-count.erasure-locators', async (tx) => {
    if (!(await lockCountOwner(tx, accountId)).terminal)
      throw new Error('Count erasure requires a native terminal account');
    return (
      await tx.query<{ target_type: string; original_id: string; destination_route: number; destination_id: string }>(
        `SELECT target_type,original_id,destination_route,destination_id FROM library.follow_count_destination
       WHERE route=$1 AND account_id=$2 ORDER BY target_type,original_id,destination_route,destination_id LIMIT 100`,
        [route, accountId],
      )
    ).rows;
  });
  for (const locator of destinations) {
    await withdrawFollowCountDestination(deps, accountId, {
      route: locator.destination_route,
      targetType: locator.target_type,
      targetId: locator.destination_id,
      originalId: locator.original_id,
    });
    // Receiving commit precedes source evidence removal; a crash repeats fenced withdrawal.
    await countTransaction(deps, route, 'library.follow-count.erasure-ack', async (tx) => {
      if (!(await lockCountOwner(tx, accountId)).terminal) throw new Error('Lost terminal count authority');
      await tx.query(
        `DELETE FROM library.follow_count_destination WHERE route=$1 AND account_id=$2 AND target_type=$3
        AND original_id=$4 AND destination_route=$5 AND destination_id=$6`,
        [route, accountId, locator.target_type, locator.original_id, locator.destination_route, locator.destination_id],
      );
    });
  }
  if (destinations.length) return { examined: destinations.length, complete: false };
  return countTransaction(deps, route, 'library.follow-count.erasure-source', async (tx) => {
    if (!(await lockCountOwner(tx, accountId)).terminal) throw new Error('Lost terminal count authority');
    // No new receiver locator can be staged after the irreversible source fence.
    let rows = (
      await tx.query<{ target_type: string; target_id: string }>(
        `SELECT target_type,target_id
      FROM library.follow_count_source WHERE route=$1 AND account_id=$2 ORDER BY target_type,target_id LIMIT 100`,
        [route, accountId],
      )
    ).rows;
    if (!rows.length)
      rows = (
        await tx.query<{ target_type: string; target_id: string }>(
          'SELECT target_type,target_id FROM library.follow WHERE route=$1 AND account_id=$2 ORDER BY target_id LIMIT 100',
          [route, accountId],
        )
      ).rows;
    for (const row of rows) {
      // The installed all-writer trigger may write a final negative; erase it only
      // after raw deletion in this same terminal transaction.
      await tx.query('DELETE FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=$3', [
        route,
        accountId,
        row.target_id,
      ]);
      await tx.query(
        'DELETE FROM library.follow_count_source WHERE route=$1 AND account_id=$2 AND target_type=$3 AND target_id=$4',
        [route, accountId, row.target_type, row.target_id],
      );
    }
    if (rows.length) return { examined: rows.length, complete: false };
    // Oldest account-signal/dedup rows also pay a bounded page, never an account-wide DELETE.
    const signals = await tx.query(
      `WITH page AS MATERIALIZED(SELECT event_id FROM library.follow_count_account_signal
      WHERE route=$1 AND account_id=$2 ORDER BY event_id LIMIT 100)
      DELETE FROM library.follow_count_account_signal s USING page p WHERE s.route=$1 AND s.account_id=$2 AND s.event_id=p.event_id`,
      [route, accountId],
    );
    if (signals.rowCount) return { examined: signals.rowCount, complete: false };
    await tx.query('DELETE FROM library.follow_count_account_work WHERE route=$1 AND account_id=$2', [
      route,
      accountId,
    ]);
    await tx.query('DELETE FROM library.follow_count_owner WHERE route=$1 AND account_id=$2', [route, accountId]);
    await tx.query(
      `UPDATE library.follow_count_terminal_source SET local_complete=true,oldest_pending_at=NULL
      WHERE partition_no=$1 AND account_id=$2`,
      [partitionOf(route), accountId],
    );
    return { examined: 0, complete: true };
  });
}
