import type { Pool } from 'pg';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../../command/command.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { GrantDeniedError } from '../../access/contract/errors.ts';
import { accessCheck } from '../../request/access-check.ts';
import type { Access, AccessClient } from '../../request/access.ts';
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
  SubjectIdentityUnavailableError,
} from '../contract/index.ts';
import { readCollection } from '../collection-store.ts';
import { resolveSubject } from '../subject-anchor.ts';
import { admitPrivateFollowRead, type FollowReadAdmission } from '../follow-read-admission.ts';
import { withFollowWork } from '../follow-operation-bounds.ts';

import { countRoute } from './follow-count-runtime.ts';
import { requireFollowCountHealth, withFollowCountReadConnection } from './follow-count-observation.ts';

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
  const read = <T>(deadline: number, body: (client: AccessClient) => Promise<T>): Promise<T> =>
    withFollowCountReadConnection(pool, deadline, body, ports);
  const application = createFollowCountReadApplication<AuthoritativeTime, FollowReadAdmission>({
    route: routeOf,
    admit: (owner, deadline, expected) => admitPrivateFollowRead(pool, owner, deadline, expected),
    time: (deadline) => read(deadline, mintReadTime),
    health: (deadline) => requireFollowCountHealth(pool, deadline),
    within: ports.within,
    destination: (target) => ports.destination(pool, target),
    async subjectReadable(owner, id, time) {
      return (await resolveSubject({ pool, access }, owner, id, time)) !== null;
    },
    accountForAgent: (id) => ports.accountForAgent(pool, id),
    collection(destination, deadline) {
      return read(deadline, (tx) => readCollection(tx, destination.route, destination.targetId));
    },
    accountState(id, deadline) {
      return read(deadline, async (tx) => (await ports.account(tx, countRoute(id), id))?.state ?? null);
    },
    spaceExists(id, time, deadline) {
      return read(deadline, (tx) => ports.spaceExists(tx, id, authoritativeTimeValue(time)));
    },
    async management(owner, action, id, time, deadline) {
      const check = await accessCheck(access, owner, action, { route: countRoute(id), id }, { pool, deadline });
      return read(deadline, (tx) => check(tx, time));
    },
    total(destination, type, deadline) {
      return read(deadline, async (tx) => {
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
      return read(deadline, async (tx) => {
        const route = countRoute(owner.accountId);
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
  async function wire<T>(deadline: number, body: () => Promise<T>): Promise<T> {
    try {
      return await withFollowWork(deadline, body);
    } catch (error) {
      if (error instanceof GrantDeniedError) throw new ProblemError('invalid_credentials');
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
    target: (actor, target, deadline) => wire(deadline, () => application.target(actor, target, deadline)),
    outgoing: (actor, deadline) => wire(deadline, () => application.outgoing(actor, deadline)),
  };
}
