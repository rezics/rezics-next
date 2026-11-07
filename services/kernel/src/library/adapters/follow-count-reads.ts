import type { Pool } from 'pg';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../../command/command.ts';
import { withConnection } from '../../database/pool.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { accessCheck, type Access, type AccessClient } from '../../request/access.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import partitionRead from '../../partition/read.sql';
import { createFollowCountReadApplication } from '../application/index.ts';
import {
  FollowCountReadRefusedError,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  type CountDestination,
  type FollowCountReads,
  type FollowCountTarget,
} from '../contract/index.ts';
import { readCollection } from '../collection-store.ts';
import { resolveSubject, SubjectIdentityUnavailableError } from '../subject-anchor.ts';
import { countRoute } from './follow-count-runtime.ts';
import { requireFollowCountHealth } from './follow-count-observation.ts';

/** Only composition supplies foreign behavior. Account and Space observations
 * retain the exact borrowed client and native instant used before the migration. */
export interface NativeFollowCountReadPorts {
  account(
    client: AccessClient,
    route: number,
    id: string,
  ): Promise<Readonly<{
    state: string;
    fenced: boolean;
    minimumAuthnEpoch: bigint;
  }> | null>;
  accountForAgent(pool: Pool, id: string): Promise<string | null>;
  spaceExists(client: AccessClient, id: string, at: string): Promise<boolean>;
  deadlineClient(client: AccessClient, deadline: number): AccessClient;
  within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
  destination(pool: Pool, target: FollowCountTarget): Promise<CountDestination>;
  isUnavailable(error: unknown): boolean;
}

export function createNativeFollowCountReads(
  pool: Pool,
  access: Access,
  ports: NativeFollowCountReadPorts,
): FollowCountReads {
  const application = createFollowCountReadApplication<AuthoritativeTime>({
    route: routeOf,
    authenticate(owner, deadline) {
      return withConnection(pool, async (client) => {
        const db = ports.deadlineClient(client, deadline);
        const current = await ports.account(db, countRoute(owner.accountId), owner.accountId);
        if (
          !current ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(owner.authnEpoch) ||
          owner.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
        )
          throw new ProblemError('invalid_credentials');
        return mintReadTime(db);
      });
    },
    health: () => requireFollowCountHealth(pool),
    within: ports.within,
    destination: (target) => ports.destination(pool, target),
    async subjectReadable(owner, id, time) {
      return (await resolveSubject({ pool, access }, owner, id, time)) !== null;
    },
    accountForAgent: (id) => ports.accountForAgent(pool, id),
    collection(destination, deadline) {
      return withConnection(pool, (tx) =>
        readCollection(ports.deadlineClient(tx, deadline), destination.route, destination.targetId),
      );
    },
    accountState(id, deadline) {
      return withConnection(
        pool,
        async (tx) => (await ports.account(ports.deadlineClient(tx, deadline), countRoute(id), id))?.state ?? null,
      );
    },
    spaceExists(id, time, deadline) {
      return withConnection(pool, (tx) =>
        ports.spaceExists(ports.deadlineClient(tx, deadline), id, authoritativeTimeValue(time)),
      );
    },
    async management(owner, action, id, time, deadline) {
      const check = await accessCheck(access, owner, action, { route: countRoute(id), id }, { pool, deadline });
      return withConnection(pool, (tx) => check(ports.deadlineClient(tx, deadline), time));
    },
    total(destination, type, deadline) {
      return withConnection(pool, async (client) => {
        const tx = ports.deadlineClient(client, deadline);
        const partition = await partitionRead.run(tx, { partition_no: partitionOf(destination.route) });
        if (!partition || partition.writeState !== 'active') throw new FollowCountUnavailableError();
        const row = (
          await tx.query<{ total: string }>(
            `SELECT total::text FROM library.follow_count_total
          WHERE route=$1 AND target_type=$2 AND target_id=$3`,
            [destination.route, type, destination.targetId],
          )
        ).rows[0];
        return row?.total;
      });
    },
    outgoing(owner, deadline) {
      return withConnection(pool, async (client) => {
        const tx = ports.deadlineClient(client, deadline),
          route = countRoute(owner.accountId);
        const partition = await partitionRead.run(tx, { partition_no: partitionOf(route) });
        if (!partition || partition.writeState !== 'active') throw new FollowCountUnavailableError();
        const row = (
          await tx.query<{ observed_live_count: string; bootstrap_complete: boolean }>(
            'SELECT observed_live_count::text,bootstrap_complete FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
            [route, owner.accountId],
          )
        ).rows[0];
        if (!row?.bootstrap_complete) throw new FollowCountUnavailableError();
        return row.observed_live_count;
      });
    },
  });
  async function wire<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof FollowCountReadRefusedError) throw new ProblemError(error.reason);
      if (error instanceof FollowCountTargetAbsentError) throw new ProblemError('not_found');
      if (
        error instanceof FollowCountUnavailableError ||
        error instanceof SubjectIdentityUnavailableError ||
        ports.isUnavailable(error)
      )
        throw new ProblemError('dependency_unavailable', { headers: { 'Retry-After': '1' } });
      throw error;
    }
  }
  return {
    target: (actor, target, deadline) => wire(() => application.target(actor, target, deadline)),
    outgoing: (actor, deadline) => wire(() => application.outgoing(actor, deadline)),
  };
}
