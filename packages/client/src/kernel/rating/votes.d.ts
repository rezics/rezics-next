import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { Access, Actor } from '../request/access.ts';
import { type RatingQuestionScale } from './question-scale.ts';
import { type VoteReviewGuard } from './own-votes-review.ts';
export { VoteReviewStaleError, VoteReviewUnavailableError } from './own-votes-review.ts';
export type { VoteReviewGuard } from './own-votes-review.ts';
export declare const STANDARD_QUESTION_ID = "00000000-0000-7000-8000-000000000001";
export declare const VOTE_SCOPE = "rating:vote";
export type RatingQuestion = RatingQuestionScale & {
    id: string;
    ownerId: string | null;
    realmId: string | null;
    meaning: string | null;
    revision: number;
    label: string;
    grain: 'work' | 'release' | 'episode' | 'character';
    lifecycleState: 'active' | 'retired';
    lifecycleRevision: number;
};
export type Vote = {
    voterId: string;
    questionId: string;
    targetId: string;
    units: number | null;
    revision: number;
    changedAt: string;
    transactionId: string;
};
export type PutVoteInput = {
    questionId: string;
    targetId: string;
    units: number | null;
    guard?: VoteReviewGuard;
};
export type PutVoteOutcome = {
    vote: Vote | null;
    component: SessionComponent | null;
};
export declare class VoteInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export declare class RatingQuestionNotFoundError extends Error {
    constructor();
}
export declare class RatingQuestionRetiredError extends Error {
    readonly reason: 'retired';
    constructor();
}
type Dependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
/** Shared native command preparation for a selected exact slot. Advice retains no authorization. */
export declare function prepareVoteTarget(config: Dependencies, actor: Actor, input: {
    questionId: string;
    targetId: string;
    units?: number | null;
}, deadline: number): Promise<{
    question: RatingQuestion;
    target: import("../library/subject-anchor.ts").ResolvedSubject;
}>;
/** Writes and reads the signed-in person's current rating vote on the account's partition. */
export declare function createVoteCommands(config: Dependencies): {
    putVote: (actor: Actor, input: PutVoteInput, idempotencyKey: string) => Promise<Vote | null>;
    putVoteOutcome: (actor: Actor, input: PutVoteInput, idempotencyKey: string) => Promise<PutVoteOutcome>;
    readOwnVote: (actor: Actor, questionId: string, targetId: string) => Promise<Vote | null>;
    readRatingQuestion: (actor: Actor, questionId: string) => Promise<RatingQuestion>;
};
