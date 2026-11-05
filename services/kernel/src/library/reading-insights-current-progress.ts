import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { LibraryProfilePin } from './profile.ts';
import type { ProgressMode } from './progress.ts';

export const READING_INSIGHTS_CURRENT_PROGRESS_GROUP_LIMIT = 8;
export const MAX_READING_INSIGHTS_CURRENT_PROGRESS_BYTES = 32_768;

export type ReadingInsightsCurrentProgressGroup = Readonly<{
  meaning: Readonly<{
    profilePin: LibraryProfilePin;
    unitId: string;
    meaningRevision: number;
    mode: ProgressMode;
    unit: string;
    dimension: string | null;
    precision: number | null;
    minimum: string | null;
    maximum: string | null;
    totalPolicy: 'optional' | 'required' | 'forbidden' | null;
    identityKind: 'none' | 'session_local';
    structureKind: 'none';
    locator: string | null;
  }>;
  occurrences: string;
  currentValue: string | null;
  currentValueCount: string;
  missingCurrentValueCount: string;
  totalValue: string | null;
  totalValueCount: string;
  missingTotalValueCount: string;
}>;

export type ReadingInsightsCurrentProgressScope = Readonly<{
  sessionCount: string;
  coveredSessions: string;
  groups: readonly ReadingInsightsCurrentProgressGroup[];
  remainder: Readonly<{
    groupCount: string;
    occurrences: string;
    currentValueCount: string;
    missingCurrentValueCount: string;
    totalValueCount: string;
    missingTotalValueCount: string;
  }>;
}>;

export type ReadingInsightsCurrentProgress =
  | Readonly<{
      state: 'unavailable';
      reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
      coverage: Readonly<{
        initializedSessions: string | null;
        retainedSessions: string | null;
      }>;
    }>
  | Readonly<{
      state: 'available';
      scope: 'active_and_backlog_sessions';
      coverage: Readonly<{
        initializedSessions: string;
        retainedSessions: string;
        currentSessions: string;
        activeSessions: string;
        backlogSessions: string;
        coveredSessions: string;
        unsupportedSessions: string;
      }>;
      currentness: Readonly<{
        state: 'snapshot';
        source: 'reading_insights_current_progress_v1';
        revision: string;
        retainedSourceRevision: string;
      }>;
      active: ReadingInsightsCurrentProgressScope;
      backlog: ReadingInsightsCurrentProgressScope;
      limit: 8;
    }>;

type Head = {
  initialized: string;
  retained: string;
  current_sessions: string;
  covered_sessions: string;
  active_sessions: string;
  backlog_sessions: string;
  installed: boolean;
  maintenance_ready: boolean;
  revision: string;
  source_revision: string;
};
type ScopeRow = {
  scope: 'active' | 'backlog';
  session_count: string;
  covered_sessions: string;
  groups: ReadingInsightsCurrentProgressGroup[] | null;
  remainder_group_count: string;
  remainder_occurrences: string;
  remainder_current_value_count: string;
  remainder_missing_current_value_count: string;
  remainder_total_value_count: string;
  remainder_missing_total_value_count: string;
};

const headSql = `SELECT COALESCE(p.initialized_sessions,0)::text AS initialized,
  COALESCE(a.retained_sessions,0)::text AS retained,
  COALESCE(p.current_sessions,0)::text AS current_sessions,
  COALESCE(p.covered_sessions,0)::text AS covered_sessions,
  COALESCE(p.active_sessions,0)::text AS active_sessions,
  COALESCE(p.backlog_sessions,0)::text AS backlog_sessions,
  c.complete AS installed,
  CASE WHEN g.account_id IS NULL THEN COALESCE(a.retained_sessions,0)=0
    ELSE g.initialized AND g.ready AND g.mode='open' END AS maintenance_ready,
  COALESCE(p.revision::text,'empty-current-progress-v1') AS revision,
  COALESCE(a.revision::text,'empty-v1') AS source_revision
FROM library.reading_insights_current_progress_installation i
JOIN library.consumption_statistics_installation c ON c.singleton=true AND c.version=1
LEFT JOIN library.reading_insights_current_progress_owner p ON p.route=$1 AND p.account_id=$2
LEFT JOIN library.consumption_statistics_owner a ON a.route=$1 AND a.account_id=$2
LEFT JOIN library.shelf_maintenance g ON g.route=$1 AND g.account_id=$2
WHERE i.singleton=true AND i.version=1`;

const scopesSql = `WITH selected_scope(scope) AS (VALUES ('active'::text),('backlog'::text)), top AS (
  (SELECT * FROM library.reading_insights_current_progress_group
    WHERE route=$1 AND account_id=$2 AND scope='active' ORDER BY occurrences DESC,meaning LIMIT 8)
  UNION ALL
  (SELECT * FROM library.reading_insights_current_progress_group
    WHERE route=$1 AND account_id=$2 AND scope='backlog' ORDER BY occurrences DESC,meaning LIMIT 8)
), top_totals AS (
  SELECT scope,count(*)::bigint AS group_count,COALESCE(sum(occurrences),0)::bigint AS occurrences,
    COALESCE(sum(current_known),0)::bigint AS current_known,
    COALESCE(sum(total_known),0)::bigint AS total_known
  FROM top GROUP BY scope
)
SELECT selected_scope.scope,
  COALESCE(s.session_count,0)::text AS session_count,
  COALESCE(s.covered_sessions,0)::text AS covered_sessions,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'meaning',top.meaning,
    'occurrences',top.occurrences::text,
    'currentValue',CASE WHEN top.current_known=0 THEN NULL ELSE top.current_sum::text END,
    'currentValueCount',top.current_known::text,
    'missingCurrentValueCount',(top.occurrences-top.current_known)::text,
    'totalValue',CASE WHEN top.total_known=0 THEN NULL ELSE top.total_sum::text END,
    'totalValueCount',top.total_known::text,
    'missingTotalValueCount',(top.occurrences-top.total_known)::text
  ) ORDER BY top.occurrences DESC,top.meaning) FROM top WHERE top.scope=selected_scope.scope),'[]'::jsonb) AS groups,
  (COALESCE(s.group_count,0)-COALESCE(t.group_count,0))::text AS remainder_group_count,
  (COALESCE(s.occurrences,0)-COALESCE(t.occurrences,0))::text AS remainder_occurrences,
  (COALESCE(s.current_known,0)-COALESCE(t.current_known,0))::text AS remainder_current_value_count,
  ((COALESCE(s.occurrences,0)-COALESCE(t.occurrences,0))-(COALESCE(s.current_known,0)-COALESCE(t.current_known,0)))::text
    AS remainder_missing_current_value_count,
  (COALESCE(s.total_known,0)-COALESCE(t.total_known,0))::text AS remainder_total_value_count,
  ((COALESCE(s.occurrences,0)-COALESCE(t.occurrences,0))-(COALESCE(s.total_known,0)-COALESCE(t.total_known,0)))::text
    AS remainder_missing_total_value_count
FROM selected_scope
LEFT JOIN library.reading_insights_current_progress_scope s
  ON s.route=$1 AND s.account_id=$2 AND s.scope=selected_scope.scope
LEFT JOIN top_totals t ON t.scope=selected_scope.scope
ORDER BY selected_scope.scope`;

function unavailable(
  reason: 'not_installed' | 'initializing' | 'maintenance_unavailable',
  initializedSessions: string | null = null,
  retainedSessions: string | null = null,
): ReadingInsightsCurrentProgress {
  return { state: 'unavailable', reason, coverage: { initializedSessions, retainedSessions } };
}

function currentScope(row: ScopeRow | undefined): ReadingInsightsCurrentProgressScope {
  const groups = row?.groups ?? [];
  return {
    sessionCount: row?.session_count ?? '0',
    coveredSessions: row?.covered_sessions ?? '0',
    groups,
    remainder: {
      groupCount: row?.remainder_group_count ?? '0',
      occurrences: row?.remainder_occurrences ?? '0',
      currentValueCount: row?.remainder_current_value_count ?? '0',
      missingCurrentValueCount: row?.remainder_missing_current_value_count ?? '0',
      totalValueCount: row?.remainder_total_value_count ?? '0',
      missingTotalValueCount: row?.remainder_missing_total_value_count ?? '0',
    },
  };
}

/** Bounded, owner-only read over maintained groups; it never hydrates native sessions or schedules work. */
export function createReadingInsightsCurrentProgressReads(deps: { pool: Pool }) {
  async function currentProgress(actor: Actor, deadline: number, signal?: AbortSignal) {
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
          await client.query('SAVEPOINT reading_insights_current_progress_schema');
          let head: Head | undefined;
          try {
            head = (await client.query<Head>(headSql, [route, actor.accountId])).rows[0];
          } catch (error) {
            if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '42P01')
              throw error;
            await client.query('ROLLBACK TO SAVEPOINT reading_insights_current_progress_schema');
          }
          if (!head) {
            const value = unavailable('not_installed');
            await authorize();
            await client.query('COMMIT');
            committed = true;
            alive();
            return value;
          }
          if (!head.installed) {
            const value = unavailable('not_installed', head.initialized, head.retained);
            await authorize();
            await client.query('COMMIT');
            committed = true;
            alive();
            return value;
          }
          if (!head.maintenance_ready) {
            const value = unavailable('maintenance_unavailable', head.initialized, head.retained);
            await authorize();
            await client.query('COMMIT');
            committed = true;
            alive();
            return value;
          }
          if (BigInt(head.initialized) < BigInt(head.retained)) {
            const value = unavailable('initializing', head.initialized, head.retained);
            await authorize();
            alive();
            await client.query('COMMIT');
            committed = true;
            alive();
            return value;
          }

          const scopes = (await client.query<ScopeRow>(scopesSql, [route, actor.accountId])).rows;
          const active = currentScope(scopes.find((scope) => scope.scope === 'active'));
          const backlog = currentScope(scopes.find((scope) => scope.scope === 'backlog'));
          const currentSessions = BigInt(head.current_sessions);
          const coveredSessions = BigInt(head.covered_sessions);
          const value: ReadingInsightsCurrentProgress = {
            state: 'available',
            scope: 'active_and_backlog_sessions',
            coverage: {
              initializedSessions: head.initialized,
              retainedSessions: head.retained,
              currentSessions: head.current_sessions,
              activeSessions: head.active_sessions,
              backlogSessions: head.backlog_sessions,
              coveredSessions: head.covered_sessions,
              unsupportedSessions: (currentSessions > coveredSessions
                ? currentSessions - coveredSessions
                : 0n
              ).toString(),
            },
            currentness: {
              state: 'snapshot',
              source: 'reading_insights_current_progress_v1',
              revision: head.revision,
              retainedSourceRevision: head.source_revision,
            },
            active,
            backlog,
            limit: READING_INSIGHTS_CURRENT_PROGRESS_GROUP_LIMIT,
          };
          if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_READING_INSIGHTS_CURRENT_PROGRESS_BYTES)
            throw new ProblemError('dependency_unavailable');
          await authorize();
          const latest = (await client.query<Head>(headSql, [route, actor.accountId])).rows[0];
          if (!latest || JSON.stringify(latest) !== JSON.stringify(head))
            throw new ProblemError('dependency_unavailable');
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
  return { currentProgress };
}
