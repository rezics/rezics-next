import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

export const MAX_REPORTED_YEAR_SUMMARY_BYTES = 16_384;
export type ReportedYearCounts = Readonly<{
  completedOccurrences: string;
  distinctCompletedSubjects: string;
  repeatOccurrences: string;
  completedOccurrencesWithUnknownProfile: string;
  finishPrecision: Readonly<{ year: string; month: string; day: string }>;
}>;
export type ReportedYearSummary = ReportedYearCounts & Readonly<{
  scope: 'retained_native_sessions';
  year: number;
  calendar: 'gregorian';
  dateSource: 'explicitly_reported_journal_finish';
  months: readonly (ReportedYearCounts & { month: number })[];
  monthUnallocated: ReportedYearCounts;
  coverage: Readonly<{
    nativeSessions: 'complete';
    initializedSessions: string;
    retainedSessions: string;
    completedOccurrencesWithMissingFinish: string;
    completedOccurrencesWithUnsupportedFinish: string;
    otherHistory: 'unavailable';
    unitMeaning: 'not_evaluated';
  }>;
  currentness: Readonly<{ state: 'snapshot'; revision: string }>;
}>;

type Head = {
  complete: boolean;
  ready: boolean;
  initialized: string;
  retained: string;
  missing: string;
  unsupported: string;
  revision: string;
};
type Bucket = { bucket: number; completed: string; subjects: string; unknown: string; month: string; day: string };

// All keys are addressed. Completeness is equality against the installed all-time
// source counter, never an inferred empty owner or a migration's synthetic marker.
const headSql = `SELECT i.complete,
  CASE WHEN a.retained_sessions IS NULL THEN true
    ELSE COALESCE(g.initialized AND g.ready AND g.mode='open',false) END AS ready,
  COALESCE(y.initialized_sessions,0)::text AS initialized,
  COALESCE(a.retained_sessions,0)::text AS retained,
  COALESCE(y.missing_finish,0)::text AS missing,
  COALESCE(y.unsupported_finish,0)::text AS unsupported,
  COALESCE(y.revision::text,'empty-v1') AS revision
FROM library.consumption_statistics_installation i
LEFT JOIN library.reported_year_owner y ON y.route=$1 AND y.account_id=$2
LEFT JOIN library.consumption_statistics_owner a ON a.route=$1 AND a.account_id=$2
LEFT JOIN library.shelf_maintenance g ON g.route=$1 AND g.account_id=$2
WHERE i.singleton=true AND i.version=1`;
const bucketsSql = `SELECT bucket,completed::text,subjects::text,unknown_profile::text AS unknown,
  month_precision::text AS month,day_precision::text AS day
FROM library.reported_year_bucket WHERE route=$1 AND account_id=$2 AND year=$3 ORDER BY bucket LIMIT 14`;

function counts(row?: Bucket): ReportedYearCounts {
  const completed = BigInt(row?.completed ?? '0');
  return {
    completedOccurrences: completed.toString(),
    distinctCompletedSubjects: row?.subjects ?? '0',
    repeatOccurrences: (completed - BigInt(row?.subjects ?? '0')).toString(),
    completedOccurrencesWithUnknownProfile: row?.unknown ?? '0',
    finishPrecision: {
      year: (completed - BigInt(row?.month ?? '0') - BigInt(row?.day ?? '0')).toString(),
      month: row?.month ?? '0',
      day: row?.day ?? '0',
    },
  };
}

/** Pure bounded read. The optional delivery callback encodes HTTP while final
 * authority and cancellation checks still apply; it cannot await more work. */
export function createReportedYearSummaryReads(deps: { pool: Pool }) {
  return {
    async summary<T = ReportedYearSummary>(
      actor: Actor, year: number, deadline: number, signal?: AbortSignal,
      deliver?: (value: ReportedYearSummary, encoded: string) => T,
    ): Promise<T> {
      if (!Number.isInteger(year) || year < 1 || year > 9999) throw new ProblemError('invalid_request');
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const route = routeOf(actor.accountId);
      if (route === null || !actor.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      return within(deadline, () => withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        let committed = false;
        try {
          // Hold native lifecycle authority through response preparation. Source writers
          // already share this owner; this adds no maintenance or write effect.
          await client.query('BEGIN');
          await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
            [route, actor.accountId]);
          const authorize = async () => {
            const owner = await readAccount(client, route, actor.accountId);
            if (!owner || owner.kind !== 'actor' || owner.state !== 'active' || owner.fenced ||
              !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 ||
              owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)) throw new ProblemError('forbidden');
          };
          await authorize();
          // One statement snapshot covers both heads and the 14 fixed keys. A
          // later source mutation is a later snapshot, never partial receiving.
          const result = await client.query<{ head: Head; buckets: Bucket[] }>(
            `WITH head AS (${headSql}), buckets AS (${bucketsSql})
             SELECT row_to_json(head) AS head,
               COALESCE((SELECT json_agg(buckets ORDER BY bucket) FROM buckets),'[]'::json) AS buckets FROM head`,
            [route, actor.accountId, year]);
          const row = result.rows[0];
          if (!row?.head.complete || !row.head.ready || row.head.initialized !== row.head.retained)
            throw new ProblemError('dependency_unavailable');
          const indexed = new Map(row.buckets.map((bucket) => [bucket.bucket, bucket]));
          const value: ReportedYearSummary = {
            ...counts(indexed.get(0)), scope: 'retained_native_sessions', year, calendar: 'gregorian',
            dateSource: 'explicitly_reported_journal_finish',
            months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, ...counts(indexed.get(index + 1)) })),
            monthUnallocated: counts(indexed.get(13)),
            coverage: {
              nativeSessions: 'complete', initializedSessions: row.head.initialized, retainedSessions: row.head.retained,
              completedOccurrencesWithMissingFinish: row.head.missing,
              completedOccurrencesWithUnsupportedFinish: row.head.unsupported,
              otherHistory: 'unavailable', unitMeaning: 'not_evaluated',
            },
            currentness: { state: 'snapshot', revision: row.head.revision },
          };
          const encoded = JSON.stringify(value);
          if (new TextEncoder().encode(encoded).byteLength > MAX_REPORTED_YEAR_SUMMARY_BYTES)
            throw new ProblemError('dependency_unavailable');
          await authorize();
          alive();
          await client.query('COMMIT');
          committed = true;
          // No await between the actual delivery check and HTTP encoding.
          alive();
          return deliver ? deliver(value, encoded) : value as T;
        } catch (error) {
          if (!committed) await connection.query('ROLLBACK');
          if (typeof error === 'object' && error !== null && 'code' in error &&
            (error.code === '42P01' || error.code === '42703')) throw new ProblemError('dependency_unavailable');
          throw error;
        }
      }));
    },
  };
}
