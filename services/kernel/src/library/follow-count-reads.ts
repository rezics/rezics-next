import type { Pool, PoolClient } from 'pg';
import { readAccount, readPublicAccountByAgent } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { readSpace } from '../community/space.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readCollection } from './collection-store.ts';
import { requireFollowCountHealth } from './follow-count-health.ts';
import { countRoute } from './follow-count-source.ts';
import {
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  resolveCountDestination,
} from './follow-count-target.ts';
import type { FollowTarget } from './follows.ts';
import { resolveSubject, SubjectIdentityUnavailableError } from '../semantic/subject-anchor.ts';

type Dependencies = { pool: Pool; access: Access };
export type CollectionDiscoveryFollowCountKey = Readonly<{ route: number; id: string }>;
const notFound = () => new ProblemError('not_found');
const unavailable = () => new ProblemError('dependency_unavailable', { headers: { 'Retry-After': '1' } });
function scalar(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new FollowCountUnavailableError();
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new FollowCountUnavailableError('Count exceeds DTO range');
  return Number(integer);
}

/** Public aggregate operand for an already-admitted public Collection batch. This is an internal
 * native reader; owner-only follow-count management remains behind createFollowCountReads. */
export async function readCollectionDiscoveryFollowCounts(
  client: Pick<PoolClient, 'query'>,
  keys: readonly CollectionDiscoveryFollowCountKey[],
): Promise<ReadonlyMap<string, string | null>> {
  if (keys.length === 0) return new Map();
  const rows = await client.query<{ id: string; total: string | null }>(
    `SELECT requested.id::text AS id, counts.total::text AS total
     FROM unnest($1::integer[], $2::uuid[]) requested(route,id)
     LEFT JOIN library.follow_count_total counts
       ON counts.route=requested.route AND counts.target_type='collection' AND counts.target_id=requested.id
     ORDER BY requested.route,requested.id`,
    [keys.map((key) => key.route), keys.map((key) => key.id)],
  );
  return new Map(rows.rows.map(({ id, total }) => [id, total]));
}

/** Closed owner-only DTOs. This service consumes native Access; it carries no role/grant policy. */
export function createFollowCountReads({ pool, access }: Dependencies) {
  async function read<T>(
    actor: Actor,
    deadline: number,
    body: (owner: AccountActor, time: AuthoritativeTime) => Promise<T>,
  ) {
    if (actor.kind !== 'account') throw new ProblemError('authentication_required');
    if (!actor.scopes.includes('follow:list')) throw new ProblemError('forbidden');
    try {
      const time = await withConnection(pool, async (client) => {
        const db = deadlineClient(client, deadline);
        const current = await readAccount(db, countRoute(actor.accountId), actor.accountId);
        if (
          !current ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(actor.authnEpoch) ||
          actor.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(actor.authnEpoch)
        )
          throw new ProblemError('invalid_credentials');
        return mintReadTime(db);
      });
      await requireFollowCountHealth(pool);
      const result = await within(deadline, () => body(actor, time));
      await requireFollowCountHealth(pool);
      return result;
    } catch (error) {
      if (error instanceof FollowCountTargetAbsentError) throw notFound();
      if (
        error instanceof FollowCountUnavailableError ||
        error instanceof SubjectIdentityUnavailableError ||
        classifyUnavailability(error)
      )
        throw unavailable();
      throw error;
    }
  }
  async function management(
    owner: AccountActor,
    action: string,
    id: string,
    time: AuthoritativeTime,
    deadline: number,
  ) {
    const resource = { route: countRoute(id), id };
    const check = await accessCheck(access, owner, action, resource, { pool, deadline });
    if (!(await withConnection(pool, (tx) => check(deadlineClient(tx, deadline), time)))) throw notFound();
  }
  async function target(actor: Actor, requested: FollowTarget, deadline: number) {
    return read(actor, deadline, async (owner, time) => {
      if (routeOf(requested.targetId) === null) throw notFound();
      const destination = await resolveCountDestination({ pool }, requested);
      let accountId: string | null = null;
      if (requested.targetType === 'subject') {
        if (!(await resolveSubject({ pool, access }, owner, requested.targetId, time))) throw notFound();
        const identities = await readPublicAccountByAgent(pool, destination.targetId);
        accountId = identities[0]?.id ?? null;
        if (!accountId) throw notFound();
        if (accountId !== owner.accountId) await management(owner, 'account:manage', accountId, time, deadline);
      } else if (requested.targetType === 'collection') {
        const collection = await withConnection(pool, (tx) =>
          readCollection(deadlineClient(tx, deadline), destination.route, destination.targetId),
        );
        if (collection?.state !== 'active') throw notFound();
        if (collection.visibility !== 'public') {
          if (!collection.curatorAccountId || routeOf(collection.curatorAccountId) === null) throw notFound();
          // Ordinary Collection visibility fences nonpublic contributions at the
          // curator's terminal state, independently of the manager's grant.
          const curatorId = collection.curatorAccountId;
          const curator = await withConnection(pool, (tx) =>
            readAccount(deadlineClient(tx, deadline), countRoute(curatorId), curatorId),
          );
          if (!curator || curator.state === 'deleted') throw notFound();
        }
        await management(owner, 'collection:update', requested.targetId, time, deadline);
      } else {
        const space = await withConnection(pool, (tx) =>
          readSpace(deadlineClient(tx, deadline), requested.targetId, authoritativeTimeValue(time)),
        );
        if (!space) throw notFound();
        await management(owner, 'space:manage', requested.targetId, time, deadline);
      }
      const followerCount = await withConnection(pool, async (client) => {
        const tx = deadlineClient(client, deadline);
        const partition = await readPartition(tx, partitionOf(destination.route));
        if (!partition || partition.writeState !== 'active') throw new FollowCountUnavailableError();
        const row = (
          await tx.query<{ total: string }>(
            `SELECT total::text FROM library.follow_count_total
          WHERE route=$1 AND target_type=$2 AND target_id=$3`,
            [destination.route, requested.targetType, destination.targetId],
          )
        ).rows[0];
        return scalar(row?.total);
      });
      if (requested.targetType === 'subject') {
        const current = await resolveCountDestination({ pool }, requested);
        const binding = await readPublicAccountByAgent(pool, current.targetId);
        if (
          current.targetId !== destination.targetId ||
          current.epoch !== destination.epoch ||
          binding[0]?.id !== accountId
        )
          throw new FollowCountUnavailableError('Count identity changed during read');
      }
      return { ...requested, followerCount };
    });
  }
  async function outgoing(actor: Actor, deadline: number) {
    return read(actor, deadline, async (owner) => ({
      followingCount: await withConnection(pool, async (client) => {
        const tx = deadlineClient(client, deadline),
          route = countRoute(owner.accountId);
        const partition = await readPartition(tx, partitionOf(route));
        if (!partition || partition.writeState !== 'active') throw new FollowCountUnavailableError();
        const row = (
          await tx.query<{ observed_live_count: string; bootstrap_complete: boolean }>(
            'SELECT observed_live_count::text,bootstrap_complete FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
            [route, owner.accountId],
          )
        ).rows[0];
        if (!row?.bootstrap_complete) throw new FollowCountUnavailableError();
        return scalar(row.observed_live_count);
      }),
    }));
  }
  return { target, outgoing };
}
