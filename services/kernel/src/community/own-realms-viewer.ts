import { deadlineClient } from '../access/authenticate.ts';
import {
  readRealmOwnerLeaveObservation,
  readRealmOwnershipRoles,
  REALM_OWNER_ROLE,
} from '../access/realm-ownership.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Actor, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { sameOwnRealmMembership, type OwnRealmMembership, type OwnRealmsDependencies } from './own-realms.ts';
import { createRealmParticipationCheck } from './participation.ts';
import { readRealm, readRealmSettingsHead, realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import bindingRead from './container-lifecycle-binding.sql';
import membershipRead from './own-realms-membership.sql';

export type RealmViewerInput = Readonly<{
  actor: Actor;
  realmId: string;
  deadline: number;
  /** The original inventory selection, never a refreshed substitute. */
  selected?: OwnRealmMembership;
}>;
const prohibited = (reason: 'not_authorized' | 'not_member' | 'signed_out' | 'governance_read_only') =>
  ({ state: 'prohibited', reason }) as const;
const command = (method: 'GET' | 'DELETE', path: string, expectedStatus: 200 | 202) =>
  ({ state: 'available', method, path, body: null, expectedStatus }) as const;
const retry = () => new ProblemError('transaction_retry_exhausted');

/** Native viewer observation shared by inventory and independent home assemblers.
 * Each handle captures actual source and episode values. finish re-prepares native
 * authority and returns the final values, or null on concealment. It never reserves
 * a command and never holds a checkout across another owner's observation.
 */
export function createRealmViewerObservation(deps: Pick<OwnRealmsDependencies, 'pool' | 'access' | 'clock'>) {
  const participation = createRealmParticipationCheck(deps);
  return async (input: RealmViewerInput) => {
    const { actor, realmId, deadline } = input;
    const selected = input.selected ? Object.freeze({ ...input.selected }) : undefined;
    const identity = JSON.stringify(actor);
    const requireIdentity = () => {
      if (JSON.stringify(actor) !== identity) throw new ProblemError('authentication_required');
    };
    const route = routeOf(realmId);
    if (route === null) return null;
    const context = { pool: deps.pool, deadline };
    const initial = await readRealm(deps, actor, realmId, context);
    if (!initial) return null;
    const resource = { route, id: realmId };
    const host = { route, id: initial.spaceId };
    const round = async () => {
      requireIdentity();
      // Prepare on released connections; plain join is the mounted leave command's
      // exact action/resource, not participation or the public read floor.
      const disclose = await accessCheck(
        deps.access,
        actor,
        'realm:read',
        { ...resource, eligibility: realmReadEligibility(resource) },
        context,
      );
      const manage = await accessCheck(deps.access, actor, 'realm:manage', resource, context);
      const leave = await accessCheck(deps.access, actor, 'realm:join', resource, context);
      const discloseHost = await accessCheck(
        deps.access,
        actor,
        'space:read',
        { ...host, eligibility: spaceReadEligibility(host) },
        context,
      );
      const observed = await withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        let time: Awaited<ReturnType<typeof mintReadTime>> | undefined;
        try {
          time = await mintReadTime(client, deps.clock);
          const at = authoritativeTimeValue(time);
          const home = await readPartition(client, partitionOf(route));
          if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
          if (!(await disclose(client, time))) {
            await client.query('COMMIT');
            return null;
          }
          const realm = await readRealmSettingsHead(client, realmId, at);
          const source = await bindingRead.run(client, {
            ...resource,
            subject: null,
            at,
          });
          if (
            !realm ||
            !source ||
            realm.spaceId !== host.id ||
            realm.headRevisionId !== initial.headRevisionId ||
            source.head_revision_id !== initial.headRevisionId
          )
            throw retry();
          const row =
            actor.kind === 'account'
              ? await membershipRead.run(client, {
                  route,
                  realm_id: realmId,
                  account_id: actor.accountId,
                  at,
                })
              : null;
          if (row && (row.since === null || !Number.isFinite(Date.parse(row.since))))
            throw new ProblemError('dependency_unavailable');
          const membership = row ? { ...row, since: row.since!, epoch: home.epoch } : null;
          if (selected && (!membership || !sameOwnRealmMembership(selected, membership))) throw retry();
          const mayManage = await manage(client, time);
          const mayLeave = actor.kind === 'account' && membership !== null && (await leave(client, time));
          // Direct-role data only selects the writer's invariant. It grants nothing.
          const roles =
            mayLeave && actor.kind === 'account'
              ? await readRealmOwnershipRoles(client, {
                  resource,
                  accountId: actor.accountId,
                  at: time,
                })
              : [];
          const owner = roles.some((role) => role.role === REALM_OWNER_ROLE);
          const ownership =
            mayLeave && owner && actor.kind === 'account'
              ? await readRealmOwnerLeaveObservation(client, {
                  resource,
                  accountId: actor.accountId,
                  at: time,
                })
              : null;
          if (ownership && !ownership.owner) throw retry();
          if (ownership && !ownership.source) throw retry();
          const hostReadable = mayManage && (await discloseHost(client, time));
          await client.query('COMMIT');
          return {
            realm,
            source: {
              realmId,
              headRevisionId: source.head_revision_id,
              lifecycleVersion: source.realm_version,
              spaceId: source.space_id,
              spaceHeadRevisionId: source.space_head,
              spaceLifecycleVersion: source.space_version,
              contextId: source.context_id,
              node: home.node,
              epoch: home.epoch,
              owner: ownership ? { roles, source: ownership.source } : null,
            },
            membership,
            actions: {
              state: 'current' as const,
              enter: command('GET', `/v1/realms/${realmId}`, 200),
              manage: realm.governanceReadOnly
                ? prohibited('governance_read_only')
                : mayManage && hostReadable
                  ? command('GET', `/v1/realms/${realmId}/settings`, 200)
                  : prohibited('not_authorized'),
              leave:
                actor.kind !== 'account'
                  ? prohibited('signed_out')
                  : !membership
                    ? prohibited('not_member')
                    : !mayLeave
                      ? prohibited('not_authorized')
                      : owner && !ownership?.remaining
                        ? {
                            state: 'unavailable' as const,
                            reason: 'last_explicit_holder' as const,
                          }
                        : command('DELETE', `/v1/realms/${realmId}/membership`, 202),
            },
          };
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        } finally {
          if (time) releaseOperationalTime(time);
        }
      });
      if (!observed) return null;
      const allowed = await participation(deps.pool as unknown as AccessClient, { realmId, actor });
      requireIdentity();
      return {
        ...observed,
        viewer: {
          readability: 'allowed' as const,
          membership: observed.membership
            ? {
                state: 'member' as const,
                since: new Date(observed.membership.since).toISOString(),
                reservationId: observed.membership.reservationId,
                transactionId: observed.membership.transactionId,
              }
            : {
                state: 'none' as const,
                since: null,
                reservationId: null,
                transactionId: null,
              },
          participation: allowed ? ('allowed' as const) : ('denied' as const),
        },
      };
    };
    const current = await round();
    if (!current) return null;
    // Keep comparison values private: a consumer cannot refresh or mutate its
    // exposed observation into becoming the original source witness.
    const expectedSource = { ...current.source };
    const expectedMembership = current.membership ? { ...current.membership } : null;
    const expectedOwnerSource = JSON.stringify(current.source.owner);
    const expectedParticipation = current.viewer.participation;
    const expectedActions = JSON.stringify(current.actions);
    return {
      current,
      async finish() {
        requireIdentity();
        // Re-enter through the ordinary native reader after dependent hydration.
        // Its original head is a witness, never a refreshed selection.
        const readable = await readRealm(deps, actor, realmId, context);
        if (!readable) return null;
        if (readable.headRevisionId !== initial.headRevisionId || readable.spaceId !== initial.spaceId) throw retry();
        const final = await round();
        if (!final) return null;
        const a = expectedSource,
          b = final.source;
        if (
          a.realmId !== b.realmId ||
          a.headRevisionId !== b.headRevisionId ||
          a.lifecycleVersion !== b.lifecycleVersion ||
          a.spaceId !== b.spaceId ||
          a.spaceHeadRevisionId !== b.spaceHeadRevisionId ||
          a.spaceLifecycleVersion !== b.spaceLifecycleVersion ||
          a.contextId !== b.contextId ||
          a.node !== b.node ||
          a.epoch !== b.epoch ||
          expectedOwnerSource !== JSON.stringify(b.owner) ||
          !sameOwnRealmMembership(expectedMembership, final.membership) ||
          expectedParticipation !== final.viewer.participation ||
          expectedActions !== JSON.stringify(final.actions)
        )
          throw retry();
        return final;
      },
    };
  };
}

export type RealmViewerObservation = NonNullable<Awaited<ReturnType<ReturnType<typeof createRealmViewerObservation>>>>;
