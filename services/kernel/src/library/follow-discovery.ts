/** Private bounded follow preparation shared by Search and Space entry. The writer remains follows.ts. */
import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { deadlineClient } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { classifyUnavailability, requireAccessDeadline, CommandUnavailableError } from '../request/unavailable.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KernelClock } from '../clock.ts';

export type FollowDiscoveryTarget = Readonly<{
  targetId: string;
  targetType: 'subject' | 'collection' | 'space';
  source: string;
}>;
export type FollowDiscoveryRow = FollowDiscoveryTarget &
  Readonly<{
    following: boolean;
    actions: Readonly<{ follow: boolean; unfollow: boolean }>;
  }>;
export type FollowDiscovery =
  | Readonly<{ state: 'signed-out' }>
  | Readonly<{ state: 'unavailable'; reason: 'identity' | 'changed' | 'native' }>
  | Readonly<{ state: 'current'; accountId: string; partition: number; rows: readonly FollowDiscoveryRow[] }>;
export type FollowDiscoveryDependencies = Readonly<{ pool: Pool; access: Access; clock?: KernelClock }>;

/** Targets must come from the composing owner's final public disclosure, never from a public index.
 * The account partition is derived only from the authenticated actor. No target-home inference.
 */
export async function readFollowDiscovery(
  dependencies: FollowDiscoveryDependencies,
  actor: Actor,
  targets: readonly FollowDiscoveryTarget[],
  deadline: number,
): Promise<FollowDiscovery> {
  if (
    !Array.isArray(targets) ||
    targets.length > 100 ||
    targets.some(
      (target) =>
        routeOf(target.targetId) === null ||
        !['subject', 'collection', 'space'].includes(target.targetType) ||
        typeof target.source !== 'string' ||
        target.source.length > 1024,
    ) ||
    new Set(targets.map((target) => target.targetId)).size !== targets.length
  )
    throw new RangeError('Invalid bounded follow discovery targets');
  const owned = targets.map((target) => ({ ...target }));
  if (actor.kind === 'anonymous') return { state: 'signed-out' };
  const viewer = { ...actor, scopes: [...actor.scopes] };
  const route = routeOf(viewer.accountId);
  if (route === null || !Number.isSafeInteger(viewer.authnEpoch) || viewer.authnEpoch <= 0)
    return { state: 'unavailable', reason: 'identity' };
  const partition = partitionOf(route);
  const snapshot = async () => {
    requireAccessDeadline(deadline);
    const context = { pool: dependencies.pool, deadline };
    // Foreign Access preparation completes before the account-home checkout.
    // The existing own follow reader requires an authenticated account, without a read scope.
    const follow = viewer.scopes.includes('follow:create')
      ? await accessCheck(dependencies.access, viewer, 'follow:create', { route, id: viewer.accountId }, context)
      : null;
    const unfollow = viewer.scopes.includes('follow:delete')
      ? await accessCheck(dependencies.access, viewer, 'follow:delete', { route, id: viewer.accountId }, context)
      : null;
    return withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      let time: Awaited<ReturnType<typeof mintReadTime>> | undefined;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        time = await mintReadTime(client, dependencies.clock);
        const home = await readPartition(client, partition);
        if (!home || home.writeState !== 'active' || home.movedTo !== null)
          throw new CommandUnavailableError('fenced', partition);
        const account = await readAccount(client, route, viewer.accountId);
        if (
          !account ||
          account.kind !== 'actor' ||
          account.state !== 'active' ||
          account.fenced ||
          account.minimumAuthnEpoch > BigInt(viewer.authnEpoch)
        ) {
          await client.query('COMMIT');
          return null;
        }
        const actions = {
          follow: follow ? await follow(client, time) : false,
          unfollow: unfollow ? await unfollow(client, time) : false,
        };
        const found = await client.query<{ targetId: string; targetType: string; state: string }>(
          `SELECT f.target_id::text AS "targetId", f.target_type AS "targetType", f.state
           FROM unnest($3::uuid[]) requested(id)
           JOIN library.follow f ON f.route=$1 AND f.account_id=$2 AND f.target_id=requested.id`,
          [route, viewer.accountId, owned.map((target) => target.targetId)],
        );
        const rows = new Map(found.rows.map((row) => [row.targetId, row]));
        if (rows.size !== found.rows.length || rows.size > owned.length)
          throw new Error('Follow discovery exceeded its full-key bound');
        const result = {
          epoch: home.epoch,
          node: home.node,
          rows: owned.map((target) => {
            const row = rows.get(target.targetId);
            if (row && row.targetType !== target.targetType) throw new Error('Follow discovery target type changed');
            return { ...target, following: row?.state === 'following', actions: { ...actions } };
          }),
        };
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (cleanup) {
          discardConnection(connection, cleanup instanceof Error ? cleanup : new Error('Follow read rollback failed'));
        }
        throw error;
      } finally {
        if (time) releaseOperationalTime(time);
      }
    });
  };
  try {
    const before = await snapshot();
    const final = await snapshot();
    if (!before || !final) return { state: 'unavailable', reason: 'identity' };
    if (!isDeepStrictEqual(before, final)) return { state: 'unavailable', reason: 'changed' };
    requireAccessDeadline(deadline);
    const result = { state: 'current', accountId: viewer.accountId, partition, rows: final.rows } as const;
    return Buffer.byteLength(JSON.stringify(result)) <= 32768 ? result : { state: 'unavailable', reason: 'native' };
  } catch (error) {
    if (classifyUnavailability(error) !== undefined) return { state: 'unavailable', reason: 'native' };
    throw error;
  }
}
