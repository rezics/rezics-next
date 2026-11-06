import type { Pool } from 'pg';
import { type Actor } from '../request/access.ts';
/** Counts are decimal strings: a long history must never lose integer precision. */
export type ConsumptionSummary = Readonly<{
    scope: 'retained_native_sessions';
    completedOccurrences: string;
    distinctCompletedSubjects: string;
    repeatOccurrences: string;
    completedOccurrencesWithUnknownProfile: string;
    coverage: Readonly<{
        nativeSessions: 'complete';
        otherHistory: 'unavailable';
        unitMeaning: 'not_evaluated';
    }>;
    currentness: Readonly<{
        state: 'snapshot';
        revision: string;
    }>;
}>;
/** Owner-only, pure, constant-row native summary. Physical admission belongs to the mounted route. */
export declare function createConsumptionStatisticsReads(deps: {
    pool: Pool;
}): {
    summary(actor: Actor, deadline: number, signal?: AbortSignal): Promise<ConsumptionSummary>;
};
