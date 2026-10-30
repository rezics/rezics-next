import type { Pool } from 'pg';
import canonicalize from 'canonicalize';
import { deadlineClient, within } from '../access/authenticate.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, AuthenticationError, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { realmParticipationAnchor } from './participation.ts';
import { realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import bindingRead from './container-lifecycle-binding.sql';
import continuityRead from './realm-continuity-read.sql';
import exactRead from './realm-claim-status-read.sql';
import currentRead from './realm-claim-status-mine.sql';

export type RealmClaimStatus = Readonly<{
  realmId: string;
  requestId: string;
  state: 'pending' | 'approved';
  orphanedAt: string;
  requestedAt: string;
  approvedAt: string | null;
  currentEpisode: boolean;
}>;

/** Own exact receipt, or the own request in the current native orphan episode.
 * Null means an authorized, active point has no matching request. Inaccessible
 * containers throw not_found; unavailable native authority throws its typed error.
 */
export type ReadOwnRealmClaim = (
  deps: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  actor: Actor,
  input: Readonly<{ realmId: string; requestId?: string }>,
  context: Readonly<{ deadline: number }>,
) => Promise<RealmClaimStatus | null>;

export const readOwnRealmClaim: ReadOwnRealmClaim = async (deps, actor, input, context) => {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const { realmId, requestId } = input;
  const route = routeOf(realmId);
  if (route === null || (requestId !== undefined && routeOf(requestId) !== route)) throw new ProblemError('not_found');
  const resource = { route, id: realmId };
  const partitionNo = partitionOf(route);
  const unavailable = () =>
    new ProblemError('dependency_unavailable', { detail: 'Native Realm claim source changed.' });

  const snapshot = <T>(read: (client: AccessClient, time: AuthoritativeTime) => Promise<T>) =>
    within(context.deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, context.deadline);
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const time = await mintReadTime(client, deps.clock);
          const value = await read(client, time);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch {
            discardConnection(connection, new Error('Realm claim read rollback failed'));
          }
          throw error;
        }
      }),
    );

  const source = async (client: AccessClient, time: AuthoritativeTime) => {
    const partition = await readPartition(client, partitionNo);
    if (!partition) throw new ProblemError('partition_unavailable');
    if (partition.writeState === 'moved') throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
    const at = authoritativeTimeValue(time);
    const binding = await bindingRead.run(client, { ...resource, subject: null, at });
    const continuity = await continuityRead.run(client, { ...resource, at });
    if (!binding || !continuity) throw new ProblemError('not_found');
    return { binding, continuity, epoch: partition.epoch };
  };

  try {
    // This point locates the native host; it supplies no permission. Release its
    // checkout before Access prepares current identity, roles and source anchors.
    const located = await snapshot(source);
    const admitted = async () => {
      const host = { route, id: located.binding.space_id };
      const accessContext = { pool: deps.pool, deadline: context.deadline };
      const read = await accessCheck(
        deps.access,
        actor,
        'realm:read',
        { ...resource, eligibility: realmReadEligibility(resource) },
        accessContext,
      );
      const participate = await accessCheck(
        deps.access,
        actor,
        'realm:participate',
        realmParticipationAnchor(resource).resource,
        accessContext,
      );
      const space = await accessCheck(
        deps.access,
        actor,
        'space:read',
        { ...host, eligibility: spaceReadEligibility(host) },
        accessContext,
      );
      return snapshot(async (client, time) => {
        const current = await source(client, time);
        if (canonicalize(current) !== canonicalize(located)) throw unavailable();
        if (!(await read(client, time)) || !(await participate(client, time)) || !(await space(client, time)))
          throw new ProblemError('not_found');
        const orphaned = current.continuity.ownership_state === 'orphaned' ? current.continuity.orphaned_at : null;
        const key = { route, realm: realmId, account: actor.accountId, orphaned };
        if (requestId !== undefined) return exactRead.run(client, { ...key, request: requestId });
        // An active owned Realm has no current orphan episode. This is known
        // point absence only after all three ordinary current decisions succeed.
        return orphaned === null ? null : currentRead.run(client, { ...key, orphaned });
      });
    };
    const first = await admitted();
    // Fresh native admission after releasing the request's source checkout.
    // Re-read even absence so erasure, approval and episode replacement cannot
    // disclose a stale result. Neither round holds a checkout across preparation.
    const final = await admitted();
    if (canonicalize(first) !== canonicalize(final)) throw unavailable();
    if (!final) return null;
    if (final.state !== 'pending' && final.state !== 'approved') throw unavailable();
    return {
      realmId,
      requestId: final.request_id,
      state: final.state,
      orphanedAt: new Date(final.orphaned_at).toISOString(),
      requestedAt: new Date(final.requested_at).toISOString(),
      approvedAt: final.approved_at === null ? null : new Date(final.approved_at).toISOString(),
      currentEpisode: final.current_episode,
    };
  } catch (error) {
    if (
      error instanceof ProblemError ||
      error instanceof AuthenticationError ||
      error instanceof AccessUnavailableError ||
      error instanceof CommandUnavailableError
    )
      throw error;
    throw new ProblemError('dependency_unavailable', { detail: 'Native Realm claim status is unavailable.' });
  }
};
