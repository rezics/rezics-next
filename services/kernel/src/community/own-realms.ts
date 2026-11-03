import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { MembershipInverseIncompleteError, requireMembershipInverseReady } from '../access/membership-inverse.ts';
import { ProblemError } from '../http/problem.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor, Access, AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { hydrateOwnRealms } from './own-realms-view.ts';
import inversePage from './own-realms-inverse-page.sql';
import confirmMembership from './own-realms-membership.sql';

const PAGE_SIZE = 20;
const SCAN_PAGE_SIZE = 20;
const MAX_INVERSE_ROWS = 80;
const START_AFTER = '00000000-0000-0000-0000-000000000000';

export type OwnRealmsDependencies = {
  pool: Pool;
  tokens: KeyRing;
  access: Access;
  clock?: () => Date;
};
export type OwnRealmMembership = NonNullable<Awaited<ReturnType<typeof confirmMembership.run>>> & {
  epoch: number;
  since: string;
};
type OwnRealmsInput = { cursor?: string };
type Context = { deadline: number; at: string };

function binding(actor: AccountActor) {
  return { operation: 'community.me.realms', parameters: { viewer: actor.accountId } };
}

async function snapshot<T>(pool: Pool, deadline: number, read: (client: AccessClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await read(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function accountEpoch(client: AccessClient, actor: AccountActor): Promise<number> {
  try {
    await requireMembershipInverseReady(client, actor);
  } catch (error) {
    if (error instanceof MembershipInverseIncompleteError) throw new ProblemError('dependency_unavailable');
    if (error instanceof LifecycleDeniedError) throw new ProblemError('authentication_required');
    throw error;
  }
  const partition = await readPartition(client, partitionOf(routeOf(actor.accountId)!));
  if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
  return partition.epoch;
}

/** The Realm owner reads its committed episode and head on a released native
 * checkout. No account-home snapshot spans a foreign-home observation.
 */
export async function observeOwnRealmMembership(
  deps: Pick<OwnRealmsDependencies, 'pool'>,
  actor: AccountActor,
  realmId: string,
  context: Context,
): Promise<OwnRealmMembership | null> {
  const route = routeOf(realmId);
  if (route === null) return null;
  return snapshot(deps.pool, context.deadline, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
    const member = await confirmMembership.run(client, {
      route,
      realm_id: realmId,
      account_id: actor.accountId,
      at: context.at,
    });
    if (member && (member.since === null || !Number.isFinite(Date.parse(member.since))))
      throw new ProblemError('dependency_unavailable');
    return member && { ...member, since: member.since!, epoch: partition.epoch };
  });
}

/** One inverse, bounded by raw work rather than the number of disclosed rows.
 * A failed read never publishes a continuation past an unobserved raw key.
 */
export async function listOwnRealms(
  dependencies: OwnRealmsDependencies,
  actor: AccountActor,
  context: Context,
  input: OwnRealmsInput = {},
) {
  // Authentication evidence belongs to this exact actor object. Preserve its
  // owner identity, and retire the response if request fields change in flight.
  const viewer = actor;
  const identity = JSON.stringify(viewer);
  const requireSameViewer = () => {
    if (JSON.stringify(viewer) !== identity) throw new ProblemError('authentication_required');
  };
  const accountRoute = routeOf(viewer.accountId);
  if (accountRoute === null) throw new ProblemError('authentication_required');
  const epoch = await snapshot(dependencies.pool, context.deadline, (client) => accountEpoch(client, viewer));
  let after = START_AFTER;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(dependencies.tokens, binding(viewer), input.cursor);
    if (!cursor.ok || cursor.after.length !== 1 || typeof cursor.after[0] !== 'string')
      throw new ProblemError('invalid_cursor');
    if (cursor.epoch !== epoch) throw new ProblemError('stale_cursor');
    after = cursor.after[0];
  }
  const scan = (key: string, limit: number) =>
    snapshot(dependencies.pool, context.deadline, async (client) => {
      requireSameViewer();
      if ((await accountEpoch(client, viewer)) !== epoch) throw new ProblemError('stale_cursor');
      return inversePage.run(client, { route: accountRoute, account_id: viewer.accountId, after: key, limit });
    });
  const selected: OwnRealmMembership[] = [];
  let fetched = 0;
  let lastConsumed: string | undefined;
  let nextExists = false;
  while (fetched < MAX_INVERSE_ROWS && selected.length < PAGE_SIZE) {
    const limit = Math.min(SCAN_PAGE_SIZE, MAX_INVERSE_ROWS - fetched);
    // Selection is committed and released before Realm confirmation starts.
    const candidates = await scan(after, limit);
    fetched += candidates.length;
    if (!candidates.length) break;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const confirmed = await observeOwnRealmMembership(dependencies, viewer, candidate.realmId, context);
      lastConsumed = after = candidate.realmId;
      if (confirmed) selected.push(confirmed);
      if (selected.length === PAGE_SIZE) {
        if (index < candidates.length - 1) nextExists = true;
        else if (candidates.length === limit) {
          if (fetched < MAX_INVERSE_ROWS) {
            const following = await scan(after, 1);
            fetched += following.length;
            nextExists = following.length > 0;
          } else nextExists = true;
        }
        break;
      }
    }
    if (selected.length === PAGE_SIZE || candidates.length < limit) break;
    nextExists = fetched === MAX_INVERSE_ROWS;
  }
  // Disclosure does not refill selection, even when every selected row conceals.
  const items = await hydrateOwnRealms(dependencies, viewer, selected, context);
  requireSameViewer();
  const at = (dependencies.clock ?? (() => new Date()))().toISOString();
  for (const member of selected) {
    const current = await observeOwnRealmMembership(dependencies, viewer, member.realmId, { ...context, at });
    if (JSON.stringify(current) !== JSON.stringify(member)) throw new ProblemError('transaction_retry_exhausted');
  }
  await snapshot(dependencies.pool, context.deadline, async (client) => {
    if ((await accountEpoch(client, viewer)) !== epoch) throw new ProblemError('stale_cursor');
  });
  requireSameViewer();
  return {
    items,
    next:
      nextExists && lastConsumed
        ? encodeCursor(dependencies.tokens, binding(viewer), { epoch, after: [lastConsumed] })
        : null,
  };
}
