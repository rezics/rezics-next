import type { Pool } from 'pg';
import { createConsumptionStatisticsReads, type ConsumptionSummary } from './consumption-statistics.ts';
import { createReportedYearSummaryReads, type ReportedYearSummary } from './reported-year-summary.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
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
export function createReadingInsightsOverviewReads(deps: { pool: Pool }) {
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
      const settled = await Promise.allSettled([
        readPanel(() => allTimeReads.summary(actor, deadline, signal)),
        readPanel(() => yearReads.summary(actor, year, deadline, signal)),
        readPanel(() => profileReads.profiles(actor, year, deadline, signal)),
        readPanel(() => currentProgressReads.currentProgress(actor, deadline, signal)),
        readPanel(() => assessmentReads.assessments(actor, deadline, signal)),
      ] as const);
      const unwrap = <T>(result: PromiseSettledResult<T>): T => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      };
      const allTime = unwrap(settled[0]);
      const reportedYear = unwrap(settled[1]);
      const profiles = unwrap(settled[2]);
      const currentProgress = unwrap(settled[3]);
      const assessments = unwrap(settled[4]);
      if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
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
      const encoded = JSON.stringify(value);
      if (new TextEncoder().encode(encoded).byteLength > MAX_READING_INSIGHTS_OVERVIEW_BYTES)
        throw new ProblemError('dependency_unavailable');
      return deliver ? deliver(value, encoded) : (value as T);
    },
  };
}
