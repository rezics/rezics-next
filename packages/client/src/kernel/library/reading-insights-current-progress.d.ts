import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import type { LibraryProfilePin } from './profile.ts';
import type { ProgressMode } from './progress.ts';
export declare const READING_INSIGHTS_CURRENT_PROGRESS_GROUP_LIMIT = 8;
export declare const MAX_READING_INSIGHTS_CURRENT_PROGRESS_BYTES = 32768;
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
export type ReadingInsightsCurrentProgress = Readonly<{
    state: 'unavailable';
    reason: 'not_installed' | 'initializing' | 'maintenance_unavailable';
    coverage: Readonly<{
        initializedSessions: string | null;
        retainedSessions: string | null;
    }>;
}> | Readonly<{
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
/** Bounded, owner-only read over maintained groups; it never hydrates native sessions or schedules work. */
export declare function createReadingInsightsCurrentProgressReads(deps: {
    pool: Pool;
}): {
    currentProgress: (actor: Actor, deadline: number, signal?: AbortSignal) => Promise<ReadingInsightsCurrentProgress>;
};
