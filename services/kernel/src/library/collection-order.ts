import type { PoolClient } from 'pg';
import { noEffect, type CommandEvent } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import { newId } from '../route/route.ts';
import { orderRepairRange } from './ordinal.ts';
import { COLLECTION_ORDER_SQL, withCollectionOrderDeclaration } from './collection-order-bounds.ts';

export { COLLECTION_ORDER_WORKFLOW } from './collection-order-bounds.ts';
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
  return (await tx.query<OrderParent>(COLLECTION_ORDER_SQL.parent, [route, collectionId])).rows[0] ?? null;
}

export async function assertCollectionOrderWritable(tx: Client, route: number, collectionId: string): Promise<void> {
  // Serialize before reading the barrier, rather than cache an allow from preparation.
  return withCollectionOrderDeclaration('barrier', async () => {
    await lockOrderParent(tx, route, collectionId);
    const active = await tx.query(COLLECTION_ORDER_SQL.barrier, [route, collectionId]);
    if (active.rows.length) throw new ProblemError('dependency_unavailable');
  });
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
  const prior = await tx.query<{ repairId: string; step: number; state: string }>(COLLECTION_ORDER_SQL.beginRepair, [
    route,
    collectionId,
  ]);
  if (prior.rows[0]?.state === 'active')
    return noEffect({ collectionId, repairId: prior.rows[0].repairId, step: prior.rows[0].step });
  if (prior.rows[0])
    await tx.query(COLLECTION_ORDER_SQL.removeTerminalRepair, [route, collectionId, prior.rows[0].repairId]);
  if (!parent.memberCount) throw new ProblemError('dependency_unavailable');
  const minimum = (await tx.query<{ key: string }>(COLLECTION_ORDER_SQL.originalMinimum, [route, collectionId])).rows[0]
    ?.key;
  if (!minimum) throw new Error('Nonempty Collection has no original minimum');
  const { lower, upper } = orderRepairRange(minimum, parent.memberCount);
  const repairId = newId(route);
  await tx.query(COLLECTION_ORDER_SQL.insertRepair, [
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
  ]);
  const locator = { collectionId, repairId, step: 0 };
  return { value: locator, events: [collectionOrderEvent(locator)] };
}
