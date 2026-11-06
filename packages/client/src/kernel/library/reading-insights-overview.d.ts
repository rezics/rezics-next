import type { Pool } from 'pg';
import { type ConsumptionSummary } from './consumption-statistics.ts';
import { type ReportedYearSummary } from './reported-year-summary.ts';
import type { Actor } from '../request/access.ts';
import { type ReadingInsightsAssessments } from './reading-insights-assessments.ts';
import { type ReadingInsightsCurrentProgress } from './reading-insights-current-progress.ts';
import { type ReadingInsightsProfiles } from './reading-insights-profiles.ts';
export declare const MAX_READING_INSIGHTS_OVERVIEW_BYTES = 65536;
export type ReadingInsightsPanelFailure = 'semantic_not_ready' | 'dependency_unavailable' | 'overloaded' | 'partition_unavailable' | 'transaction_retry_exhausted' | 'deadline_exceeded';
export type ReadingInsightsPanel<T> = Readonly<{
    status: 'received';
    value: T;
}> | Readonly<{
    status: 'failed';
    reason: ReadingInsightsPanelFailure;
}>;
export type ReadingInsightsDiaryAction = Readonly<{
    operationId: 'library_diary.list';
    query: Readonly<{
        year: number;
        month?: number | 'unallocated';
    }>;
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
        months: readonly (ReadingInsightsDiaryAction & {
            month: number;
        })[];
        unallocatedMonth: ReadingInsightsDiaryAction;
    }>;
}>;
/** Composes separately identified pure reads; each keeps its own authority and source revision. */
export declare function createReadingInsightsOverviewReads(deps: {
    pool: Pool;
}): {
    overview<T = ReadingInsightsOverview>(actor: Actor, year: number, deadline: number, signal?: AbortSignal, deliver?: (value: ReadingInsightsOverview, encoded: string) => T): Promise<T>;
};
