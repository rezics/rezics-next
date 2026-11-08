import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
export declare const READING_INSIGHTS_ASSESSMENT_REVISION_LIMIT = 16;
export declare const MAX_READING_INSIGHTS_ASSESSMENT_BYTES = 16384;
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
export type ReadingInsightsAssessments = Readonly<{
    scope: 'retained_nonretired_sessions';
    state: 'available';
    coverage: ReadingInsightsAssessmentCoverage & {
        includedSessions: string;
    };
    currentness: Readonly<{
        state: 'snapshot';
        source: 'reading_insights_assessments_v1';
        revision: string;
        retainedSourceRevision: string;
    }>;
    revisions: readonly Readonly<{
        meaningRevision: number;
        counts: ReadingInsightsAssessmentCounts;
        values: readonly Readonly<{
            units: number;
            occurrences: string;
        }>[];
    }>[];
}> | Readonly<{
    scope: 'retained_nonretired_sessions';
    state: 'unavailable';
    reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
    coverage: ReadingInsightsAssessmentCoverage;
}>;
/** Bounded, owner-only receiver view; journal writes and the completion summary remain independent. */
export declare function createReadingInsightsAssessmentReads(deps: {
    pool: Pool;
}): {
    assessments: (actor: Actor, deadline: number, signal?: AbortSignal) => Promise<ReadingInsightsAssessments>;
};
