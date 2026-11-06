import { type CommandTransaction } from '../command/command.ts';
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
export declare function IdentityRatingCommitUnavailableError(): {
    new (identityState: "absent" | "foreign-control" | "moved" | "pending" | "unavailable" | "undisclosed", home?: number | undefined): {
        readonly identityState: 'pending' | 'moved' | 'absent' | 'undisclosed' | 'unavailable' | 'foreign-control';
        readonly home?: number | undefined;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        readonly code: "vote_review_unavailable";
        readonly reason: 'question_observation_unavailable' | 'identity_pending' | 'identity_observation_unavailable' | 'own_vote_observation_unavailable' | 'atomic_guard_unavailable';
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type IdentityRatingCommitUnavailableError = InstanceType<ReturnType<typeof IdentityRatingCommitUnavailableError>>;
/** Native same-home mapping participant. Its stable core owner lock lasts to executor COMMIT/ROLLBACK. */
export declare function createIdentityRatingCommitParticipant(): IdentityRatingCommitParticipant;
export {};
