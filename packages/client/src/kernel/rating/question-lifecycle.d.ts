import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
export declare const QUESTION_LIFECYCLE_CHANGED = "com.rezics.rating.question.lifecycle-changed.v1";
export type QuestionLifecycleState = 'active' | 'retired';
export type QuestionLifecycleInput = Readonly<{
    questionId: string;
    expectedRevision: number;
}>;
type Dependencies = {
    pool: Pool;
    access: Access;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
export declare class QuestionLifecycleConflictError extends Error {
    constructor();
}
export declare class QuestionLifecycleNotFoundError extends Error {
    constructor();
}
export declare function retireRealmRatingQuestion(deps: Dependencies, actor: Actor, input: QuestionLifecycleInput, context: {
    deadline: number;
    idempotencyKey: string;
}): Promise<import("../command/command.ts").CommandOutcome<{
    questionId: string;
    lifecycle: {
        state: QuestionLifecycleState;
        revision: number;
    };
}>>;
export declare function restoreRealmRatingQuestion(deps: Dependencies, actor: Actor, input: QuestionLifecycleInput, context: {
    deadline: number;
    idempotencyKey: string;
}): Promise<import("../command/command.ts").CommandOutcome<{
    questionId: string;
    lifecycle: {
        state: QuestionLifecycleState;
        revision: number;
    };
}>>;
export {};
