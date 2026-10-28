import type { PoolClient } from 'pg';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import duePage from './entry-due-page.sql';
import dueDelete from './entry-due-delete.sql';

export type DueEntryDeletionKey = Readonly<{
  restoreUntil: string;
  route: number;
  accountId: string;
  deletionId: string;
}>;

type Client = Pick<PoolClient, 'query'>;

function assertKey(key: DueEntryDeletionKey): void {
  partitionOf(key.route);
  if (routeOf(key.accountId) !== key.route) throw new RangeError('Account does not carry the deletion route');
  // A deletion locator need not be routable, including the all-zero first tie checkpoint.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key.deletionId))
    throw new RangeError('Deletion id must be a lowercase canonical UUID');
}

/**
 * Private storage seek, before any caller eligibility filters. Resume a full page after its last raw key,
 * keeping the original cutoff; a final empty page may be necessary. Keys confer no deletion authority.
 */
export async function pageDueEntryDeletions(
  client: Client,
  input: { partition: number; cutoff: string; after?: DueEntryDeletionKey; limit: number },
): Promise<DueEntryDeletionKey[]> {
  const { partition, cutoff, after, limit } = input;
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError(`Partition must be an integer from 0 to ${PARTITIONS - 1}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Limit must be an integer from 1 to 100');
  if (after !== undefined) {
    assertKey(after);
    if (partitionOf(after.route) !== partition) throw new RangeError('Checkpoint belongs to a different partition');
  }
  return duePage.run(client, {
    partition_no: partition,
    cutoff,
    after_restore_until: after?.restoreUntil ?? null,
    after_route: after?.route ?? null,
    after_account_id: after?.accountId ?? null,
    after_deletion_id: after?.deletionId ?? null,
    page_limit: limit,
  });
}

/**
 * Exact ordinary archive CAS on the caller's transaction. The trusted caller supplies authorization and
 * current kernel time; this helper owns neither. Native timestamps retain their full precision.
 */
export async function purgeDueEntryDeletion(
  client: Client,
  key: DueEntryDeletionKey,
  context: { time: string },
): Promise<boolean> {
  assertKey(key);
  const deleted = await dueDelete.run(client, {
    route: key.route,
    account_id: key.accountId,
    deletion_id: key.deletionId,
    expected_original_deadline: key.restoreUntil,
    time: context.time,
  });
  return deleted?.deleted === true;
}
