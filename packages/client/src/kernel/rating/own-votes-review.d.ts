import type { CommandTransaction } from '../command/command.ts';
import type { IdentityRatingReviewOperand } from '../semantic/index.ts';
export declare const VOTE_SCOPE = "rating:vote";
export declare class VoteInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export type VoteReviewEpoch = Readonly<{
    partition: number;
    epoch: string;
}>;
export type VoteReviewGuard = Readonly<{
    version: 1;
    question: Readonly<{
        revision: number;
        lifecycleRevision: number;
    }>;
    subject: Readonly<{
        canonicalId: string;
        epochs: readonly VoteReviewEpoch[];
        /** Absent on historical reviews, which can replay but cannot admit a fresh effect. */
        identity?: IdentityRatingReviewOperand;
    }>;
    ownVote: Readonly<{
        state: 'absent' | 'present';
        observation: string;
    }>;
}>;
export declare class VoteReviewStaleError extends Error {
    readonly reason: 'question_changed' | 'subject_changed' | 'identity_epoch_changed' | 'own_vote_changed';
    readonly code = "vote_review_stale";
    constructor(reason: 'question_changed' | 'subject_changed' | 'identity_epoch_changed' | 'own_vote_changed');
}
export declare class VoteReviewUnavailableError extends Error {
    readonly reason: 'question_observation_unavailable' | 'identity_pending' | 'identity_observation_unavailable' | 'own_vote_observation_unavailable' | 'atomic_guard_unavailable';
    readonly code = "vote_review_unavailable";
    constructor(reason: 'question_observation_unavailable' | 'identity_pending' | 'identity_observation_unavailable' | 'own_vote_observation_unavailable' | 'atomic_guard_unavailable');
}
export type VoteReviewRow = Readonly<{
    targetId: string;
    units: number | null;
    revision: number;
    countedRevision: number;
    countedTarget: string | null;
    changedAt: string;
    transactionId: string;
}>;
export type VoteReviewSlot = Readonly<{
    targetId: string;
    vote: VoteReviewRow | null;
}>;
/** Explicit null rows prove absence in this native account snapshot, including cleared/raw slots. */
export declare function readVoteReviewSlots(client: CommandTransaction, input: Readonly<{
    ownerId: string;
    questionId: string;
    targetIds: readonly string[];
}>): Promise<VoteReviewSlot[]>;
/** A bounded observation, never an authorization capability or an atomic fence. */
export declare function ownVoteReviewWitness(input: Readonly<{
    ownerId: string;
    questionId: string;
    requestedTargetId: string;
    canonicalId: string;
    original: VoteReviewRow | null;
    canonical: VoteReviewRow | null;
    effective: VoteReviewRow | null;
}>): VoteReviewGuard['ownVote'];
/** Closed, copied normalization also prevents mutation across an uncertain native retry. */
export declare function normalizeVoteReviewGuard(value: unknown, requestedTargetId: string): VoteReviewGuard;
