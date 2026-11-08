import type { CommandTransaction } from '../command/command.ts';
import type { NativeIdentityCapabilities } from './identity-adapter-port.ts';
import type { IdentityRatingCommitParticipant as CommitParticipant } from './contract/index.ts';
export type { IdentityRatingCommitPreparation, IdentityRatingCommitHeld } from './contract/index.ts';
export type IdentityRatingCommitParticipant = CommitParticipant<CommandTransaction>;
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
export declare function createIdentityRatingCommitParticipant(capabilities?: NativeIdentityCapabilities): IdentityRatingCommitParticipant;
