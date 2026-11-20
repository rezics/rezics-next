import type { AccessClient } from '../../request/access.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { GLOBAL_CONTEXT } from './catalogue.ts';

/** Lock owner facts on the Economy checkout before a private read, replay or posting.
 * The configured node is the owner of this pool; this port admits only collocated homes.
 */
export async function lockNativeEconomyAdmission(
  client: AccessClient,
  input: { node: string; accountId: string; recipientId?: string },
): Promise<'allowed' | 'source_denied' | 'recipient_denied' | 'unavailable'> {
  const sourceId = input.accountId.toLowerCase();
  const recipientId = input.recipientId?.toLowerCase();
  const sourceRoute = routeOf(sourceId);
  if (sourceRoute === null) return 'source_denied';
  const recipientRoute = recipientId === undefined ? null : routeOf(recipientId);
  const sourceHome = partitionOf(sourceRoute);
  const recipientHome = recipientRoute === null ? null : partitionOf(recipientRoute);
  const globalHome = partitionOf(GLOBAL_CONTEXT.route);

  // Match lifecycle and grant commands' partition-before-resource lock order.
  const allowedHomes = await client.query<{ partition_no: number }>(
    `SELECT partition_no FROM core.partition
     WHERE partition_no = ANY($1::integer[]) AND node = $2 AND write_state = 'active'
     ORDER BY partition_no FOR SHARE`,
    [[globalHome, sourceHome, ...(recipientHome === null ? [] : [recipientHome])], input.node],
  );
  const owned = new Set(allowedHomes.rows.map(({ partition_no }) => partition_no));
  if (!owned.has(globalHome) || !owned.has(sourceHome)) return 'unavailable';

  const parties = [{ id: sourceId, route: sourceRoute }];
  if (recipientId !== undefined && recipientId !== sourceId && recipientRoute !== null && owned.has(recipientHome!))
    parties.push({ id: recipientId, route: recipientRoute });
  parties.sort((a, b) => a.route - b.route || a.id.localeCompare(b.id));
  const active: string[] = [];
  for (const { id, route } of parties) {
    const account = await client.query<{ state: string; fenced: boolean }>(
      `SELECT state, authn_fenced AS fenced FROM access.account
       WHERE route = $1 AND account_id = $2 FOR SHARE`,
      [route, id],
    );
    const row = account.rows[0];
    if (row?.state === 'active' && !row.fenced) active.push(id);
  }
  if (!active.includes(sourceId)) return 'source_denied';

  // Recheck time after obtaining locks. A revocation that won the row lock
  // may have narrowed an interval that covered the statement's start time.
  const grants = await client.query<{ subject_id: string }>(
    `WITH locked AS MATERIALIZED (
       SELECT subject_id, valid FROM access.resource_grant
       WHERE route = 0 AND resource_id = $1 AND subject_kind = 'identity' AND subject_role = ''
         AND action = 'gate:economy' AND subject_id = ANY($2::uuid[]) AND valid @> statement_timestamp()
       ORDER BY subject_id FOR SHARE
     )
     SELECT subject_id::text FROM locked WHERE valid @> clock_timestamp()`,
    [GLOBAL_CONTEXT.id, active],
  );
  const admitted = new Set(grants.rows.map(({ subject_id }) => subject_id));
  if (!admitted.has(sourceId)) return 'source_denied';
  if (recipientId !== undefined && !admitted.has(recipientId)) return 'recipient_denied';
  return 'allowed';
}
