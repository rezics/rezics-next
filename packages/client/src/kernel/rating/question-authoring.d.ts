import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
export declare const QUESTION_CREATED = "com.rezics.rating.question.created.v1";
export type QuestionGrain = 'work' | 'release' | 'episode' | 'character';
export type RealmQuestionInput = Readonly<{
    realmId: string;
    meaning: string;
    label: string;
    grain: QuestionGrain;
    scale: Readonly<{
        min: number;
        max: number;
        displayStep: number;
    }>;
}>;
export declare class QuestionDefinitionInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
/** This envelope is the installed vote SQL/event capability, not a scale codec.
 * Scale delivery owns expanding it across persistence, events and aggregates. */
export declare function validateQuestionDefinition(input: RealmQuestionInput): void;
/** One Realm-home command, receipt and event. The current native manage decision
 * precedes receipt lookup on every attempt, including an exact replay. */
export declare function createRealmRatingQuestion(deps: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
}, actor: Actor, input: RealmQuestionInput, context: {
    deadline: number;
    idempotencyKey: string;
}): Promise<import("../command/command.ts").CommandOutcome<{
    id: string;
    realmId: string;
    meaning: string;
    revision: number;
    label: string;
    canonicalLabel: string;
    labelRevision: number;
    grain: QuestionGrain;
    scale: {
        min: number;
        max: number;
        displayStep: number;
    };
}>>;
