import type { PoolClient } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { MemberPosition, MemberReordering } from './collection-model.ts';
import { memberNeighbors } from './collection-store.ts';
import { localOrderKeys, ORDER_BATCH_SIZE, ORDER_WINDOW_SIZE } from './ordinal.ts';

/** Rolls back the original intent. The request runner separately authorizes repair admission. */
export class CollectionOrderRepairRequired extends Error {
  constructor(
    readonly collectionId: string,
    readonly fence: string,
  ) {
    super('Collection order requires retained repair');
  }
}

type Client = Pick<PoolClient, 'query'>;
type Row = { memberId: string; ordinalKey: string };

export async function planCollectionPlacement(
  tx: Client,
  route: number,
  collectionId: string,
  position: MemberPosition,
  placedIds: readonly string[],
  excludedIds: readonly string[] = [],
): Promise<{ keys: string[]; members: MemberReordering[] }> {
  if (!placedIds.length || placedIds.length > ORDER_BATCH_SIZE || excludedIds.length > ORDER_BATCH_SIZE)
    throw new RangeError('Invalid placement batch');
  const neighbors = await memberNeighbors(tx, route, collectionId, position, excludedIds);
  if (!neighbors) throw new ProblemError('not_found');
  const direct = localOrderKeys(neighbors.before, neighbors.after, placedIds.length);
  if (direct) return { keys: direct, members: [] };

  // Two directional index seeks examine <=128 resting occurrences. The farthest
  // row of a full side is an untouched boundary, leaving <=126 rows to rewrite.
  const side = ORDER_WINDOW_SIZE / 2;
  const left =
    neighbors.before === null
      ? []
      : (
          await tx.query<Row>(
            `SELECT member_id AS "memberId", ordinal_key AS "ordinalKey" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key <= $3::text COLLATE "C"
       AND NOT (member_id=ANY($4::uuid[]))
     ORDER BY ordinal_key DESC, member_id DESC LIMIT $5`,
            [route, collectionId, neighbors.before, excludedIds, side],
          )
        ).rows.reverse();
  const right =
    neighbors.after === null
      ? []
      : (
          await tx.query<Row>(
            `SELECT member_id AS "memberId", ordinal_key AS "ordinalKey" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key >= $3::text COLLATE "C"
       AND NOT (member_id=ANY($4::uuid[]))
     ORDER BY ordinal_key, member_id LIMIT $5`,
            [route, collectionId, neighbors.after, excludedIds, side],
          )
        ).rows;
  const lower = left.length === side ? left.shift()!.ordinalKey : null;
  const upper = right.length === side ? right.pop()!.ordinalKey : null;
  const order = [...left.map((row) => row.memberId), ...placedIds, ...right.map((row) => row.memberId)];
  const keys = localOrderKeys(lower, upper, order.length);
  if (!keys) {
    const fence = (
      await tx.query<{ fence: string }>(
        `SELECT collection.revision::text || ':' || collection.source_generation::text || ':' ||
                collection.order_epoch::text || ':' || account.minimum_authn_epoch::text AS fence
       FROM library.collection AS collection JOIN access.account AS account
         ON account.route=collection.route AND account.account_id=collection.curator_account_id
       WHERE collection.route=$1 AND collection.collection_id=$2`,
        [route, collectionId],
      )
    ).rows[0]?.fence;
    if (!fence) throw new ProblemError('not_found');
    throw new CollectionOrderRepairRequired(collectionId, fence);
  }
  const selected = new Set(placedIds);
  return {
    keys: keys.slice(left.length, left.length + placedIds.length),
    members: order.flatMap((memberId, index) =>
      selected.has(memberId) ? [] : [{ memberId, ordinalKey: keys[index]! }],
    ),
  };
}
