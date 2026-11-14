import type { Pool, PoolClient } from 'pg';
import accountShare from '../access/account-share.sql';
import { readAccount } from './access-port.ts';
import { withReadingDashboardReadConnection } from './reading-dashboard-read-connection.ts';
import { readPartition } from '../partition/partition.ts';
import { ProblemError } from '../http/problem-error.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** Counts are decimal strings: a long history must never lose integer precision. */
export type ConsumptionSummary = Readonly<{
  scope: 'retained_native_sessions';
  completedOccurrences: string;
  distinctCompletedSubjects: string;
  repeatOccurrences: string;
  completedOccurrencesWithUnknownProfile: string;
  coverage: Readonly<{
    nativeSessions: 'complete';
    otherHistory: 'unavailable';
    unitMeaning: 'not_evaluated';
  }>;
  currentness: Readonly<{ state: 'snapshot'; revision: string }>;
}>;

type SummaryRow = {
  complete: boolean;
  completed: string;
  subjects: string;
  repeats: string;
  unknown: string;
  revision: string;
};

// Both keys are exact. No sessions, subjects, publications or profile releases are
// fetched here. The installation marker makes an absent owner row a proven zero.
const summarySql = `SELECT i.complete,
  COALESCE(o.completed_occurrences,0)::text AS completed,
  COALESCE(o.completed_subjects,0)::text AS subjects,
  (COALESCE(o.completed_occurrences,0)-COALESCE(o.completed_subjects,0))::text AS repeats,
  COALESCE(o.unknown_profile_completed,0)::text AS unknown,
  COALESCE(o.revision::text,'empty-v1') AS revision
FROM library.consumption_statistics_installation i
LEFT JOIN library.consumption_statistics_owner o ON o.route=$1 AND o.account_id=$2
WHERE i.singleton=true AND i.version=1`;

/** Owner-only, pure, constant-row native summary. Physical admission belongs to the mounted route. */
export function createConsumptionStatisticsReads(deps: { pool: Pool }) {
  return {
    async summary(actor: Actor, deadline: number, signal?: AbortSignal): Promise<ConsumptionSummary> {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const route = routeOf(actor.accountId);
      if (route === null || !actor.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
      const partition = partitionOf(route);
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      const readOptions = { deadline, ...(signal === undefined ? {} : { signal }) };
      const authorize = async (client: PoolClient) => {
        const owner = await readAccount(client, route, actor.accountId);
        if (
          !owner ||
          owner.kind !== 'actor' ||
          owner.state !== 'active' ||
          owner.fenced ||
          !Number.isSafeInteger(actor.authnEpoch) ||
          actor.authnEpoch < 1 ||
          owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)
        )
          throw new ProblemError('forbidden');
      };
      const activeHome = async (client: PoolClient) => {
        const home = await readPartition(client, partition);
        if (!home || home.writeState !== 'active' || home.movedTo !== null)
          throw new ProblemError('partition_unavailable');
        return { node: home.node, epoch: home.epoch };
      };
      try {
        const selected = await withReadingDashboardReadConnection(deps.pool, readOptions, async (client) => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          alive();
          await authorize(client);
          const home = await activeHome(client);
          const result = await client.query<SummaryRow>(summarySql, [route, actor.accountId]);
          const row = result.rows[0];
          if (!row?.complete) throw new ProblemError('dependency_unavailable');
          alive();
          await client.query('COMMIT');
          alive();
          return { row, home };
        });

        // Release the selection snapshot before observing current Access and home authority.
        await withReadingDashboardReadConnection(deps.pool, readOptions, async (client) => {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await accountShare.run(client, { route, account_id: actor.accountId });
          await authorize(client);
          const home = await activeHome(client);
          if (home.epoch !== selected.home.epoch || home.node !== selected.home.node)
            throw new ProblemError('partition_unavailable');
          alive();
          await client.query('COMMIT');
          alive();
        });
        alive();
        return {
          scope: 'retained_native_sessions',
          completedOccurrences: selected.row.completed,
          distinctCompletedSubjects: selected.row.subjects,
          repeatOccurrences: selected.row.repeats,
          completedOccurrencesWithUnknownProfile: selected.row.unknown,
          coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
          currentness: { state: 'snapshot', revision: selected.row.revision },
        };
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
          throw new ProblemError('dependency_unavailable');
        throw error;
      }
    },
  };
}
