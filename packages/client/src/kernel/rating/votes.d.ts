import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { type RatingVoteSemantic } from './adapters/vote-semantic.ts';
import type { Access, Actor } from '../request/access.ts';
import { type OwnCountedVoteObservation } from './own-votes-counted.ts';
import { type RatingQuestionScale } from './question-scale.ts';
import { type VoteReviewGuard } from './own-votes-review.ts';
export { STANDARD_QUESTION_ID } from './standard-question.ts';
export { VOTE_SCOPE, VoteInvalidError, VoteReviewStaleError, VoteReviewUnavailableError } from './own-votes-review.ts';
export type { VoteReviewGuard } from './own-votes-review.ts';
import { type VoteObservation } from './vote-observation.ts';
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
    observation?: VoteObservation;
};
export type PutVoteOutcome = {
    vote: Vote | null;
    component: SessionComponent | null;
};
/** Trusted caller source operands join the receipt digest; admission runs only in a fresh native body. */
export type VoteCommandAdmission = {
    input: unknown;
    prepare(): Promise<(tx: import('../command/command.ts').CommandTransaction) => Promise<void>>;
};
/** Bounded native linkage retained after the provider input has been scrubbed. */
export type PutVoteReceipt = Readonly<{
    requestKey: string;
    digest: string;
    questionId: string;
    targetId: string;
}>;
export type PreparedPutVote = Readonly<{
    input: PutVoteInput;
    receipt: PutVoteReceipt;
}>;
export type VoteReviewCurrentVote = Exclude<OwnCountedVoteObservation, {
    state: 'unavailable';
}>;
export type VoteReview = Readonly<{
    question: RatingQuestion;
    currentVote: VoteReviewCurrentVote;
    guard: VoteReviewGuard;
}>;
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
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
    semantic?: RatingVoteSemantic;
};
/** Shared native command preparation for a selected exact slot. Advice retains no authorization. */
export declare function prepareVoteTarget(config: Dependencies, actor: Actor, input: {
    questionId: string;
    targetId: string;
    units?: number | null;
}, deadline: number): Promise<{
    question: RatingQuestion;
    target: Readonly<{
        subjectId: string;
        requestedSubjectId: string | null;
    }>;
}>;
/** Writes and reads the signed-in person's current rating vote on the account's partition. */
export declare function createVoteCommands(config: Dependencies): {
    preparePutVote: (actor: Actor, input: PutVoteInput, idempotencyKey: string, admission?: VoteCommandAdmission) => PreparedPutVote;
    reconcilePutVote: (actor: Actor, receipt: PutVoteReceipt) => Promise<PutVoteOutcome | null>;
    putVote: (actor: Actor, input: PutVoteInput, idempotencyKey: string) => Promise<Vote | null>;
    putVoteOutcome: (actor: Actor, input: PutVoteInput, idempotencyKey: string, admission?: VoteCommandAdmission) => Promise<PutVoteOutcome>;
    readOwnVote: (actor: Actor, questionId: string, targetId: string) => Promise<Vote | null>;
    readRatingQuestion: (actor: Actor, questionId: string) => Promise<RatingQuestion>;
    readVoteReview: (actor: Actor, questionId: string, targetId: string) => Promise<VoteReview>;
};
