import type { Pool, PoolClient } from 'pg';
import { type Actor } from '../request/access.ts';
export declare const MAX_REPORTED_YEAR_SUMMARY_BYTES = 16384;
export type ReportedYearCounts = Readonly<{
    completedOccurrences: string;
    distinctCompletedSubjects: string;
    repeatOccurrences: string;
    completedOccurrencesWithUnknownProfile: string;
    finishPrecision: Readonly<{
        year: string;
        month: string;
        day: string;
    }>;
}>;
export type ReportedYearSummary = ReportedYearCounts & Readonly<{
    scope: 'retained_native_sessions';
    year: number;
    calendar: 'gregorian';
    dateSource: 'explicitly_reported_journal_finish';
    months: readonly (ReportedYearCounts & {
        month: number;
    })[];
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
    currentness: Readonly<{
        state: 'snapshot';
        revision: string;
    }>;
}>;
/** Shared coverage and source revision for summary-to-diary navigation; no preparation. */
export declare function reportedYearRevision(client: Pick<PoolClient, 'query'>, route: number, accountId: string): Promise<string>;
/** Pure bounded read. The optional delivery callback encodes HTTP while final
 * authority and cancellation checks still apply; it cannot await more work. */
export declare function createReportedYearSummaryReads(deps: {
    pool: Pool;
}): {
    summary<T = ReportedYearSummary>(actor: Actor, year: number, deadline: number, signal?: AbortSignal, deliver?: (value: ReportedYearSummary, encoded: string) => T): Promise<T>;
};
