import { type CommandTransaction } from '../command/command.ts';
import { VoteReviewUnavailableError } from '../rating/own-votes-review.ts';
import { type IdentityRatingReviewOperand } from './identity-adapters/identity-epoch-read.ts';
declare const preparation: unique symbol;
/** Factory-local immutable input only; it conveys neither authorization nor a held lock. */
export type IdentityRatingCommitPreparation = Readonly<{
    [preparation]: true;
}>;
export type IdentityRatingCommitHeld = Readonly<{
    ownerId: string;
    ownerEpoch: number;
    partition: number;
    subjectId: string;
    publishedHeads: readonly Readonly<{
        partition: number;
        group: string;
        epoch: string;
    }>[];
}>;
export type IdentityRatingCommitParticipant = Readonly<{
    prepare(operand: IdentityRatingReviewOperand): IdentityRatingCommitPreparation;
    /** Fresh command body only, after receipt lookup and before no-op, cleanup or effects. */
    admit(tx: CommandTransaction, prepared: IdentityRatingCommitPreparation): Promise<IdentityRatingCommitHeld>;
}>;
export declare class IdentityRatingCommitUnavailableError extends VoteReviewUnavailableError {
    readonly home?: number | undefined;
    readonly identityState: 'pending' | 'moved' | 'absent' | 'undisclosed' | 'unavailable' | 'foreign-control';
    constructor(identityState: IdentityRatingCommitUnavailableError['identityState'], home?: number | undefined);
}
/** Native same-home mapping participant. Its stable core owner lock lasts to executor COMMIT/ROLLBACK. */
export declare function createIdentityRatingCommitParticipant(): IdentityRatingCommitParticipant;
export {};
