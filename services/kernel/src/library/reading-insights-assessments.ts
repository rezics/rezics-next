import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

export const READING_INSIGHTS_ASSESSMENT_REVISION_LIMIT = 16;
export const MAX_READING_INSIGHTS_ASSESSMENT_BYTES = 16_384;

export type ReadingInsightsAssessmentCounts = Readonly<{
  absent: string;
  explicitNull: string;
  value: string;
  historicalUnknown: string;
}>;
export type ReadingInsightsAssessmentCoverage = Readonly<{
  initializedSessions: string | null;
  retainedSessions: string | null;
}>;
export type ReadingInsightsAssessments =
  | Readonly<{
      scope: 'retained_nonretired_sessions';
      state: 'available';
      coverage: ReadingInsightsAssessmentCoverage & { includedSessions: string };
      currentness: Readonly<{
        state: 'snapshot';
        source: 'reading_insights_assessments_v1';
        revision: string;
        retainedSourceRevision: string;
      }>;
      revisions: readonly Readonly<{
        meaningRevision: number;
        counts: ReadingInsightsAssessmentCounts;
        values: readonly Readonly<{ units: number; occurrences: string }>[];
      }>[];
    }>
  | Readonly<{
      scope: 'retained_nonretired_sessions';
      state: 'unavailable';
      reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
      coverage: ReadingInsightsAssessmentCoverage;
    }>;

type Head = {
  initialized: string;
  retained: string;
  ready: boolean;
  revision: string;
  source_revision: string;
};
type RevisionRow = {
  meaning_revision: number;
  absent: string;
  explicit_null: string;
  valued: string;
  historical_unknown: string;
  values: { units: number; occurrences: string }[];
};
type Snapshot = { head: Head; revisions: RevisionRow[] };

const headSql = `SELECT COALESCE(p.initialized_sessions,0)::text AS initialized,
  COALESCE(a.retained_sessions,0)::text AS retained,
  i.version=1 AND c.complete AND CASE WHEN g.account_id IS NULL THEN a.retained_sessions IS NULL
    ELSE g.initialized AND g.ready AND g.mode='open' END AS ready,
  COALESCE(p.revision::text,'empty-assessment-v1') AS revision,
  COALESCE(a.revision::text,'empty-v1') AS source_revision
FROM library.reading_insights_assessment_installation i
JOIN library.consumption_statistics_installation c ON c.singleton=true AND c.version=1
LEFT JOIN library.reading_insights_assessment_owner p ON p.route=$1 AND p.account_id=$2
LEFT JOIN library.consumption_statistics_owner a ON a.route=$1 AND a.account_id=$2
LEFT JOIN library.shelf_maintenance g ON g.route=$1 AND g.account_id=$2
WHERE i.singleton=true AND i.version=1`;

// The revision and value tables bound this read independently of session history.
const snapshotSql = `WITH head AS (${headSql}), revisions AS (
  SELECT meaning_revision,absent::text,explicit_null::text,valued::text,historical_unknown::text
  FROM library.reading_insights_assessment_revision WHERE route=$1 AND account_id=$2
  ORDER BY meaning_revision DESC LIMIT ${READING_INSIGHTS_ASSESSMENT_REVISION_LIMIT}
), groups AS (
  SELECT r.meaning_revision,r.absent,r.explicit_null,r.valued,r.historical_unknown,
    COALESCE((SELECT json_agg(json_build_object('units',v.units,'occurrences',v.occurrences::text)
      ORDER BY v.units) FROM library.reading_insights_assessment_value v
      WHERE v.route=$1 AND v.account_id=$2 AND v.meaning_revision=r.meaning_revision),'[]'::json) AS values
  FROM revisions r
)
SELECT (SELECT row_to_json(head) FROM head) AS head,
  COALESCE((SELECT json_agg(groups ORDER BY groups.meaning_revision DESC) FROM groups),'[]'::json) AS revisions`;

function unavailable(
  reason: 'not_installed' | 'initializing' | 'maintenance_unavailable',
  head?: Head,
): ReadingInsightsAssessments {
  return {
    scope: 'retained_nonretired_sessions',
    state: 'unavailable',
    reason,
    coverage: { initializedSessions: head?.initialized ?? null, retainedSessions: head?.retained ?? null },
  };
}

function present(snapshot: Snapshot | undefined): ReadingInsightsAssessments {
  if (!snapshot) return unavailable('not_installed');
  const { head } = snapshot;
  if (head.initialized !== head.retained) return unavailable('initializing', head);
  if (!head.ready) return unavailable('maintenance_unavailable', head);
  const revisions = snapshot.revisions.map((revision) => ({
    meaningRevision: revision.meaning_revision,
    counts: {
      absent: revision.absent,
      explicitNull: revision.explicit_null,
      value: revision.valued,
      historicalUnknown: revision.historical_unknown,
    },
    values: revision.values,
  }));
  const includedSessions = revisions
    .reduce(
      (sum, revision) =>
        sum +
        BigInt(revision.counts.absent) +
        BigInt(revision.counts.explicitNull) +
        BigInt(revision.counts.value) +
        BigInt(revision.counts.historicalUnknown),
      0n,
    )
    .toString();
  return {
    scope: 'retained_nonretired_sessions',
    state: 'available',
    coverage: { initializedSessions: head.initialized, retainedSessions: head.retained, includedSessions },
    currentness: {
      state: 'snapshot',
      source: 'reading_insights_assessments_v1',
      revision: head.revision,
      retainedSourceRevision: head.source_revision,
    },
    revisions,
  };
}

/** Bounded, owner-only receiver view; journal writes and the completion summary remain independent. */
export function createReadingInsightsAssessmentReads(deps: { pool: Pool }) {
  async function assessments(
    actor: Actor,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ReadingInsightsAssessments> {
    if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
    const route = routeOf(actor.accountId);
    if (route === null || !actor.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
    const alive = () => {
      if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
    };
    alive();
    return within(deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        let committed = false;
        try {
          await client.query('BEGIN');
          await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [
            route,
            actor.accountId,
          ]);
          const authorize = async () => {
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
          await authorize();
          await client.query('SAVEPOINT reading_insights_assessment_schema');
          let snapshot: Snapshot | undefined;
          let installed = true;
          try {
            snapshot = (await client.query<Snapshot>(snapshotSql, [route, actor.accountId])).rows[0];
          } catch (error) {
            if (
              typeof error !== 'object' ||
              error === null ||
              !('code' in error) ||
              (error.code !== '42P01' && error.code !== '42703')
            )
              throw error;
            await client.query('ROLLBACK TO SAVEPOINT reading_insights_assessment_schema');
            installed = false;
          }
          const value = present(snapshot);
          const encoded = JSON.stringify(value);
          if (new TextEncoder().encode(encoded).byteLength > MAX_READING_INSIGHTS_ASSESSMENT_BYTES)
            throw new ProblemError('dependency_unavailable');
          await authorize();
          if (installed && snapshot) {
            const latest = (await client.query<Head>(headSql, [route, actor.accountId])).rows[0];
            if (JSON.stringify(latest) !== JSON.stringify(snapshot.head))
              throw new ProblemError('dependency_unavailable');
          }
          alive();
          await client.query('COMMIT');
          committed = true;
          alive();
          return value;
        } catch (error) {
          if (!committed) await connection.query('ROLLBACK');
          throw error;
        }
      }),
    );
  }
  return { assessments };
}
