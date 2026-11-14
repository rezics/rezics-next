import type { Pool } from 'pg';
import { readAccountCommandState } from './access-port.ts';
import { createConsumptionStatisticsReads, type ConsumptionSummary } from './consumption-statistics.ts';
import { createReportedYearSummaryReads, type ReportedYearSummary } from './reported-year-summary.ts';
import { withReadingDashboardReadConnection } from './reading-dashboard-read-connection.ts';
import { boundedReadWindow, partitionReadClient } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  createReadingInsightsAssessmentReads,
  type ReadingInsightsAssessments,
} from './reading-insights-assessments.ts';
import {
  createReadingInsightsCurrentProgressReads,
  type ReadingInsightsCurrentProgress,
} from './reading-insights-current-progress.ts';
import { createReadingInsightsProfileReads, type ReadingInsightsProfiles } from './reading-insights-profiles.ts';

export const MAX_READING_INSIGHTS_OVERVIEW_BYTES = 65_536;

export type ReadingInsightsPanelFailure =
  | 'semantic_not_ready'
  | 'dependency_unavailable'
  | 'overloaded'
  | 'partition_unavailable'
  | 'transaction_retry_exhausted'
  | 'deadline_exceeded';
export type ReadingInsightsPanel<T> =
  | Readonly<{ status: 'received'; value: T }>
  | Readonly<{ status: 'failed'; reason: ReadingInsightsPanelFailure }>;
export type ReadingInsightsDiaryAction = Readonly<{
  operationId: 'library_diary.list';
  query: Readonly<{ year: number; month?: number | 'unallocated' }>;
}>;
export type ReadingInsightsOverview = Readonly<{
  scope: 'private_reading_insights';
  year: number;
  panels: Readonly<{
    allTime: ReadingInsightsPanel<ConsumptionSummary>;
    reportedYear: ReadingInsightsPanel<ReportedYearSummary>;
    profiles: ReadingInsightsPanel<ReadingInsightsProfiles>;
    currentProgress: ReadingInsightsPanel<ReadingInsightsCurrentProgress>;
    assessments: ReadingInsightsPanel<ReadingInsightsAssessments>;
  }>;
  actions: Readonly<{
    diary: ReadingInsightsDiaryAction;
    months: readonly (ReadingInsightsDiaryAction & { month: number })[];
    unallocatedMonth: ReadingInsightsDiaryAction;
  }>;
}>;

type ReadingInsightsOverviewReads = Readonly<{
  overview(actor: Actor, year: number, deadline: number, signal?: AbortSignal): Promise<ReadingInsightsOverview>;
  overview<T>(
    actor: Actor,
    year: number,
    deadline: number,
    signal: AbortSignal | undefined,
    deliver: (value: ReadingInsightsOverview, encoded: string) => T,
  ): Promise<T>;
}>;

function panelFailure(error: unknown): ReadingInsightsPanelFailure | undefined {
  if (!(error instanceof ProblemError)) return undefined;
  switch (error.code) {
    case 'semantic_not_ready':
    case 'dependency_unavailable':
    case 'overloaded':
    case 'partition_unavailable':
    case 'transaction_retry_exhausted':
    case 'deadline_exceeded':
      return error.code;
    default:
      return undefined;
  }
}

async function readPanel<T>(read: () => Promise<T>): Promise<ReadingInsightsPanel<T>> {
  try {
    return { status: 'received', value: await read() };
  } catch (error) {
    const reason = panelFailure(error);
    if (reason) return { status: 'failed', reason };
    throw error;
  }
}

/** Composes separately identified pure reads; each keeps its own authority and source revision. */
export function createReadingInsightsOverviewReads(deps: { pool: Pool }): ReadingInsightsOverviewReads {
  const allTimeReads = createConsumptionStatisticsReads(deps);
  const yearReads = createReportedYearSummaryReads(deps);
  const profileReads = createReadingInsightsProfileReads(deps);
  const currentProgressReads = createReadingInsightsCurrentProgressReads(deps);
  const assessmentReads = createReadingInsightsAssessmentReads(deps);

  return {
    async overview<T = ReadingInsightsOverview>(
      actor: Actor,
      year: number,
      deadline: number,
      signal?: AbortSignal,
      deliver?: (value: ReadingInsightsOverview, encoded: string) => T,
    ): Promise<T> {
      if (!Number.isInteger(year) || year < 1 || year > 9999) throw new ProblemError('invalid_request');
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const route = routeOf(actor.accountId);
      if (route === null || !actor.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      const pending: (() => Promise<void>)[] = [];
      const schedule = <T>(read: () => Promise<T>): Promise<ReadingInsightsPanel<T>> =>
        new Promise((resolve, reject) => {
          pending.push(async () => {
            try {
              resolve(await readPanel(read));
            } catch (error) {
              reject(error);
            }
          });
        });
      const settlement = Promise.allSettled([
        schedule(() => allTimeReads.summary(actor, deadline, signal)),
        schedule<ReportedYearSummary>(() => yearReads.summary(actor, year, deadline, signal)),
        schedule(() => profileReads.profiles(actor, year, deadline, signal)),
        schedule<ReadingInsightsCurrentProgress>(() => currentProgressReads.currentProgress(actor, deadline, signal)),
        schedule(() => assessmentReads.assessments(actor, deadline, signal)),
      ] as const);
      // Each panel retains its own checkout and revision; queueing spends the
      // original deadline and settles failures in the original panel order.
      await boundedReadWindow(pending, 2, (read) => read());
      const settled = await settlement;
      const unwrap = <T>(result: PromiseSettledResult<T>): T => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      };
      const allTime = unwrap(settled[0]);
      const reportedYear = unwrap(settled[1]);
      const profiles = unwrap(settled[2]);
      const currentProgress = unwrap(settled[3]);
      const assessments = unwrap(settled[4]);
      alive();
      const value: ReadingInsightsOverview = {
        scope: 'private_reading_insights',
        year,
        panels: {
          allTime,
          reportedYear,
          profiles,
          currentProgress,
          assessments,
        },
        actions: {
          diary: { operationId: 'library_diary.list', query: { year } },
          months: Array.from({ length: 12 }, (_, index) => {
            const month = index + 1;
            return { operationId: 'library_diary.list', query: { year, month }, month };
          }),
          unallocatedMonth: { operationId: 'library_diary.list', query: { year, month: 'unallocated' } },
        },
      };
      const readOptions = { deadline, ...(signal === undefined ? {} : { signal }) };
      return withReadingDashboardReadConnection(deps.pool, readOptions, async (client) => {
        // Earlier panels can outlive their admission while siblings finish.
        // Re-admit the composition outside every panel's source snapshot.
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [
          route,
          actor.accountId,
        ]);
        const owner = await readAccountCommandState(client, route, actor.accountId);
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
        await partitionReadClient(client, partitionOf(route));
        alive();
        await client.query('COMMIT');
        alive();
        const encoded = JSON.stringify(value);
        if (new TextEncoder().encode(encoded).byteLength > MAX_READING_INSIGHTS_OVERVIEW_BYTES)
          throw new ProblemError('dependency_unavailable');
        // Encoding consumes the same budget; delivery cannot await more work.
        alive();
        return deliver ? deliver(value, encoded) : (value as T);
      });
    },
  };
}
