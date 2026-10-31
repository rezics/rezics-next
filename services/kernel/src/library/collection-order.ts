import type { PoolClient } from 'pg';
import { noEffect, type CommandEvent } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { newId } from '../route/route.ts';
import { orderRepairRange } from './ordinal.ts';

export const COLLECTION_ORDER_WORKFLOW = 'library.collectionOrderRepair';
export type CollectionOrderLocator = { collectionId: string; repairId: string; step: number };
type Client = Pick<PoolClient, 'query'>;
export type OrderParent = {
  curatorAccountId: string | null;
  state: string;
  membershipKind: string;
  memberCount: number;
  revision: number;
  sourceGeneration: string;
  orderEpoch: number;
};
export async function lockOrderParent(tx: Client, route: number, collectionId: string): Promise<OrderParent | null> {
  return (
    (
      await tx.query<OrderParent>(
        `SELECT curator_account_id AS "curatorAccountId", state, membership_kind AS "membershipKind",
       member_count AS "memberCount", revision, source_generation::text AS "sourceGeneration", order_epoch AS "orderEpoch"
     FROM library.collection WHERE route=$1 AND collection_id=$2 FOR UPDATE`,
        [route, collectionId],
      )
    ).rows[0] ?? null
  );
}

export async function assertCollectionOrderWritable(tx: Client, route: number, collectionId: string): Promise<void> {
  // Serialize before reading the barrier, rather than cache an allow from preparation.
  await lockOrderParent(tx, route, collectionId);
  const active = await tx.query(
    `SELECT 1 FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND state='active'`,
    [route, collectionId],
  );
  if (active.rows.length) throw new ProblemError('dependency_unavailable');
}

export function collectionOrderEvent(locator: CollectionOrderLocator): CommandEvent {
  return {
    type: 'com.rezics.library.collection.order-repair.advanced.v1',
    subject: locator.collectionId,
    data: locator,
  };
}

/** Called only inside the separately authorized repair-begin command, at its new T.
 * The failed edit's receipt has rolled back and cannot be consumed by this command.
 */
export async function beginCollectionOrderRepair(tx: Client, route: number, collectionId: string) {
  const parent = await lockOrderParent(tx, route, collectionId);
  if (!parent || parent.state !== 'active' || !parent.curatorAccountId) throw new ProblemError('not_found');
  if (parent.membershipKind !== 'curated') throw new ProblemError('dynamic_membership_immutable');
  const prior = await tx.query<{ repairId: string; step: number; state: string }>(
    `SELECT repair_id AS "repairId", step,state FROM library.collection_order_repair
     WHERE route=$1 AND collection_id=$2`,
    [route, collectionId],
  );
  if (prior.rows[0]?.state === 'active')
    return noEffect({ collectionId, repairId: prior.rows[0].repairId, step: prior.rows[0].step });
  if (prior.rows[0])
    await tx.query(
      `DELETE FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3 AND state<>'active'`,
      [route, collectionId, prior.rows[0].repairId],
    );
  if (!parent.memberCount) throw new ProblemError('dependency_unavailable');
  const minimum = (
    await tx.query<{ key: string }>(
      `SELECT ordinal_key AS key FROM library.collection_member WHERE route=$1 AND collection_id=$2
     ORDER BY ordinal_key,member_id LIMIT 1`,
      [route, collectionId],
    )
  ).rows[0]?.key;
  if (!minimum) throw new Error('Nonempty Collection has no original minimum');
  const { lower, upper } = orderRepairRange(minimum, parent.memberCount);
  const repairId = newId(route);
  await tx.query(
    `INSERT INTO library.collection_order_repair
       (route,collection_id,repair_id,admitted_count,original_minimum,lower_key,upper_key,
        admitted_revision,admitted_source_generation,admitted_order_epoch,
        expected_revision,expected_source_generation,expected_order_epoch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8,$9,$10)`,
    [
      route,
      collectionId,
      repairId,
      parent.memberCount,
      minimum,
      lower,
      upper,
      parent.revision,
      parent.sourceGeneration,
      parent.orderEpoch,
    ],
  );
  const locator = { collectionId, repairId, step: 0 };
  return { value: locator, events: [collectionOrderEvent(locator)] };
}
