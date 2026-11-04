import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';

export const READING_INSIGHTS_PROFILE_LIMIT = 8;
export const MAX_READING_INSIGHTS_PROFILE_BYTES = 16_384;
export type ReadingInsightsCounts = Readonly<{ completedOccurrences: string; repeatOccurrencesWithinProfile: string }>;
export type ReadingInsightsCoverage = Readonly<{
  initializedSessions: string | null;
  retainedSessions: string | null;
}>;
export type ReadingInsightsProfiles = Readonly<{
  scope: 'selected_reported_year';
  year: number;
}> &
  (
    | Readonly<{
        state: 'available';
        dateSource: 'explicitly_reported_journal_finish';
        grouping: 'exact_retained_profile_pin';
        historicalLabels: 'unavailable';
        coverage: ReadingInsightsCoverage & { nativeSessions: 'complete'; otherHistory: 'unavailable' };
        currentness: Readonly<{
          state: 'snapshot';
          source: 'reading_insights_v1';
          revision: string;
          retainedSourceRevision: string;
        }>;
        totals: ReadingInsightsCounts;
        profiles: readonly (ReadingInsightsCounts & { profile: LibraryProfilePin })[];
        unknown: ReadingInsightsCounts;
        remainder: ReadingInsightsCounts & { profileGroups: string };
        limit: 8;
      }>
    | Readonly<{
        state: 'unavailable';
        reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
        coverage: ReadingInsightsCoverage;
      }>
  );

type Head = {
  initialized: string;
  retained: string;
  ready: boolean;
  revision: string;
  source_revision: string;
};
type Counts = { completed: string; repeats: string };
type Group = Counts & { profile_key: string };
type Year = Counts & { known_profiles: string };
type Snapshot = { head: Head; year: Year | null; groups: Group[]; unknown: Counts | null };

const headSql = `SELECT COALESCE(p.initialized_sessions,0)::text AS initialized,
  COALESCE(a.retained_sessions,0)::text AS retained,
  i.version=1 AND c.complete AND CASE WHEN g.account_id IS NULL THEN a.retained_sessions IS NULL
    ELSE g.initialized AND g.ready AND g.mode='open' END AS ready,
  COALESCE(p.revision::text,'empty-v1') AS revision,
  COALESCE(a.revision::text,'empty-v1') AS source_revision
FROM library.reading_insights_installation i
JOIN library.consumption_statistics_installation c ON c.singleton=true AND c.version=1
LEFT JOIN library.reading_insights_owner p ON p.route=$1 AND p.account_id=$2
LEFT JOIN library.consumption_statistics_owner a ON a.route=$1 AND a.account_id=$2
LEFT JOIN library.shelf_maintenance g ON g.route=$1 AND g.account_id=$2
WHERE i.singleton=true AND i.version=1`;

// No source sessions, Subject details, current definitions or presentation hydration.
// The partial order index bounds the top set independently of historical cardinality.
const snapshotSql = `WITH head AS (${headSql}), year AS (
  SELECT completed::text,repeats::text AS repeats,known_profiles::text
  FROM library.reading_insights_year WHERE route=$1 AND account_id=$2 AND year=$3
), groups AS (
  SELECT p.profile_key,p.completed::text,(p.completed-p.subjects)::text AS repeats
  FROM library.reading_insights_profile p WHERE p.route=$1 AND p.account_id=$2 AND p.year=$3 AND p.profile_key<>''
  ORDER BY p.completed DESC,p.profile_key LIMIT ${READING_INSIGHTS_PROFILE_LIMIT}
), unknown AS (
  SELECT completed::text,(completed-subjects)::text AS repeats FROM library.reading_insights_profile
  WHERE route=$1 AND account_id=$2 AND year=$3 AND profile_key=''
)
SELECT row_to_json(head) AS head,(SELECT row_to_json(year) FROM year) AS year,
  COALESCE((SELECT json_agg(groups ORDER BY groups.completed::bigint DESC,groups.profile_key COLLATE "C") FROM groups),'[]'::json) AS groups,
  (SELECT row_to_json(unknown) FROM unknown) AS unknown FROM head`;

function counts(value: Counts | null | undefined): ReadingInsightsCounts {
  return { completedOccurrences: value?.completed ?? '0', repeatOccurrencesWithinProfile: value?.repeats ?? '0' };
}
function unavailable(year: number, reason: 'not_installed' | 'initializing' | 'maintenance_unavailable', head?: Head): ReadingInsightsProfiles {
  return {
    scope: 'selected_reported_year', year, state: 'unavailable', reason,
    coverage: { initializedSessions: head?.initialized ?? null, retainedSessions: head?.retained ?? null },
  };
}
function present(year: number, snapshot: Snapshot | undefined): ReadingInsightsProfiles {
  if (!snapshot) return unavailable(year, 'not_installed');
  const { head } = snapshot;
  if (head.initialized !== head.retained) return unavailable(year, 'initializing', head);
  if (!head.ready) return unavailable(year, 'maintenance_unavailable', head);
  const profiles = snapshot.groups.map((group) => {
    const profile = decodeLibraryProfilePin(JSON.parse(group.profile_key));
    if (!profile) throw new ProblemError('dependency_unavailable');
    return { profile, ...counts(group) };
  });
  const totals = counts(snapshot.year), unknown = counts(snapshot.unknown);
  const remaining = (field: keyof ReadingInsightsCounts) => (
    BigInt(totals[field]) - BigInt(unknown[field]) - profiles.reduce((sum, group) => sum + BigInt(group[field]), 0n)
  ).toString();
  return {
    scope: 'selected_reported_year', year, state: 'available',
    dateSource: 'explicitly_reported_journal_finish', grouping: 'exact_retained_profile_pin',
    historicalLabels: 'unavailable',
    coverage: { nativeSessions: 'complete', initializedSessions: head.initialized, retainedSessions: head.retained,
      otherHistory: 'unavailable' },
    currentness: { state: 'snapshot', source: 'reading_insights_v1', revision: head.revision,
      retainedSourceRevision: head.source_revision },
    totals, profiles, unknown,
    remainder: { completedOccurrences: remaining('completedOccurrences'),
      repeatOccurrencesWithinProfile: remaining('repeatOccurrencesWithinProfile'),
      profileGroups: (BigInt(snapshot.year?.known_profiles ?? '0') - BigInt(profiles.length)).toString() },
    limit: READING_INSIGHTS_PROFILE_LIMIT,
  };
}

/** Bounded native reader; final delivery runs under current owner authority. */
export function createReadingInsightsProfileReads(deps: { pool: Pool }) {
  return {
    async profiles<T = ReadingInsightsProfiles>(
      actor: Actor, year: number, deadline: number, signal?: AbortSignal,
      deliver?: (value: ReadingInsightsProfiles, encoded: string) => T,
    ): Promise<ReadingInsightsProfiles | T> {
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
          await client.query('BEGIN');
          await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [route, actor.accountId]);
          const authorize = async () => {
            const owner = await readAccount(client, route, actor.accountId);
            if (!owner || owner.kind !== 'actor' || owner.state !== 'active' || owner.fenced ||
              !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 ||
              owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)) throw new ProblemError('forbidden');
          };
          await authorize();
          // An absent optional installation cannot abort the surrounding authority
          // transaction or make independently usable summaries unavailable.
          await client.query('SAVEPOINT reading_insights_schema');
          let snapshot: Snapshot | undefined;
          let installed = true;
          try {
            snapshot = (await client.query<Snapshot>(snapshotSql, [route, actor.accountId, year])).rows[0];
          } catch (error) {
            if (typeof error !== 'object' || error === null || !('code' in error) ||
              (error.code !== '42P01' && error.code !== '42703')) throw error;
            await client.query('ROLLBACK TO SAVEPOINT reading_insights_schema');
            installed = false;
          }
          const value = present(year, snapshot);
          const encoded = JSON.stringify(value);
          if (new TextEncoder().encode(encoded).byteLength > MAX_READING_INSIGHTS_PROFILE_BYTES)
            throw new ProblemError('dependency_unavailable');
          await authorize();
          if (installed) {
            const latest = (await client.query<Head>(headSql, [route, actor.accountId])).rows[0];
            if (JSON.stringify(latest) !== JSON.stringify(snapshot?.head)) throw new ProblemError('dependency_unavailable');
          }
          alive();
          await client.query('COMMIT');
          committed = true;
          alive();
          return deliver ? deliver(value, encoded) : value;
        } catch (error) {
          if (!committed) await connection.query('ROLLBACK');
          throw error;
        }
      }));
    },
  };
}
