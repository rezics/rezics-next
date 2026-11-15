import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { type ReportedYearSummary } from './reported-year-summary.ts';
export declare const YEARLY_COMPLETION_GOAL_METRIC: 'completed_consumption_occurrences';
export declare const YEARLY_COMPLETION_GOAL_TARGET_MIN = 1;
export declare const YEARLY_COMPLETION_GOAL_TARGET_MAX = 1000;
export type YearlyCompletionGoalChange = Readonly<{
    year: number;
    metric: typeof YEARLY_COMPLETION_GOAL_METRIC;
    target: number | null;
    expectedRevision: string | null;
}>;
export type YearlyCompletionGoalTargetRead = Readonly<{
    state: 'none';
    revision: string | null;
}> | Readonly<{
    state: 'set';
    target: number;
    revision: string;
}> | Readonly<{
    state: 'unavailable';
    reason: 'not_installed';
}>;
export type YearlyCompletionGoalRead = Readonly<{
    target: YearlyCompletionGoalTargetRead;
    progress: Readonly<{
        state: 'available';
        summary: ReportedYearSummary;
    }> | Readonly<{
        state: 'unavailable';
        reason: 'summary_unavailable';
    }>;
}>;
export type YearlyCompletionGoalChangeResult = Readonly<{
    year: number;
    metric: typeof YEARLY_COMPLETION_GOAL_METRIC;
    target: number | null;
    revision: string;
}>;
/** Strict native validation; JSON numbers and explicit absence never coerce. */
export declare function validateYearlyCompletionGoalChange(value: unknown): YearlyCompletionGoalChange;
export declare function createYearlyCompletionGoalReads(dependencies: {
    pool: Pool;
}): {
    target(actor: Actor, year: number, deadline: number, signal?: AbortSignal): Promise<YearlyCompletionGoalTargetRead>;
    /** Delivery is synchronous so HTTP encoding remains inside final admission. */
    read<T = YearlyCompletionGoalRead>(actor: Actor, year: number, deadline: number, signal?: AbortSignal, deliver?: (value: YearlyCompletionGoalRead) => T): Promise<T>;
};
export declare function createYearlyCompletionGoalCommands(dependencies: {
    pool: Pool;
    access?: Access;
    clock?: KernelClock;
}): {
    change(actor: Actor, input: YearlyCompletionGoalChange, requestKey: string): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        year: number;
        metric: typeof YEARLY_COMPLETION_GOAL_METRIC;
        target: number | null;
        revision: string;
    }>>>;
};
