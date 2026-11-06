import type { Pool } from 'pg';
import { type Actor } from '../request/access.ts';
import type { LibraryProfilePin } from './profile.ts';
export declare const READING_INSIGHTS_PROFILE_LIMIT = 8;
export declare const MAX_READING_INSIGHTS_PROFILE_BYTES = 16384;
export type ReadingInsightsCounts = Readonly<{
    completedOccurrences: string;
    repeatOccurrencesWithinProfile: string;
}>;
export type ReadingInsightsCoverage = Readonly<{
    initializedSessions: string | null;
    retainedSessions: string | null;
}>;
export type ReadingInsightsProfiles = Readonly<{
    scope: 'selected_reported_year';
    year: number;
}> & (Readonly<{
    state: 'available';
    dateSource: 'explicitly_reported_journal_finish';
    grouping: 'exact_retained_profile_pin';
    historicalLabels: 'unavailable';
    coverage: ReadingInsightsCoverage & {
        nativeSessions: 'complete';
        otherHistory: 'unavailable';
    };
    currentness: Readonly<{
        state: 'snapshot';
        source: 'reading_insights_v1';
        revision: string;
        retainedSourceRevision: string;
    }>;
    totals: ReadingInsightsCounts;
    profiles: readonly (ReadingInsightsCounts & {
        profile: LibraryProfilePin;
    })[];
    unknown: ReadingInsightsCounts;
    remainder: ReadingInsightsCounts & {
        profileGroups: string;
    };
    limit: 8;
}> | Readonly<{
    state: 'unavailable';
    reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
    coverage: ReadingInsightsCoverage;
}>);
/** Bounded native reader; final delivery runs under current owner authority. */
export declare function createReadingInsightsProfileReads(deps: {
    pool: Pool;
}): {
    profiles: {
        (actor: Actor, year: number, deadline: number, signal?: AbortSignal): Promise<ReadingInsightsProfiles>;
        <T>(actor: Actor, year: number, deadline: number, signal: AbortSignal | undefined, deliver: (value: ReadingInsightsProfiles, encoded: string) => T): Promise<T>;
    };
};
