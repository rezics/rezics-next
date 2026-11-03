import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

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
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      return within(deadline, () => withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          alive();
          const owner = await readAccount(client, route, actor.accountId);
          if (!owner || owner.kind !== 'actor' || owner.state !== 'active' || owner.fenced ||
            !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 ||
            owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)) throw new ProblemError('forbidden');
          const result = await client.query<SummaryRow>(summarySql, [route, actor.accountId]);
          const row = result.rows[0];
          if (!row?.complete) throw new ProblemError('dependency_unavailable');
          alive();
          await client.query('COMMIT');
          alive();
          return {
            scope: 'retained_native_sessions',
            completedOccurrences: row.completed,
            distinctCompletedSubjects: row.subjects,
            repeatOccurrences: row.repeats,
            completedOccurrencesWithUnknownProfile: row.unknown,
            coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
            currentness: { state: 'snapshot', revision: row.revision },
          };
        } catch (error) {
          await connection.query('ROLLBACK');
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
            throw new ProblemError('dependency_unavailable');
          throw error;
        }
      }));
    },
  };
}
