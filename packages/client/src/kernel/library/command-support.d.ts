import { type LibraryCommandExecutionPlan, type LibraryCommandExecutionBinding } from './library-command-execution.ts';
export { type LibraryCommandExecutionPlan, type LibraryCommandExecutionBinding, runLibraryCommand, } from './library-command-execution.ts';
import type { Pool } from 'pg';
import { runCommand, type AuthoritativeTime, type CommandAttempt, type CommandAuthorization, type CommandOutcome, type CommandResult, type CommandTransaction, type PrincipalCommandIdentity } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { type SessionOperationKind } from './session-operation-bounds.ts';
export { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
export { runLibraryBoundedStep, runLibraryBoundedOperation, workStepDeadline, LibraryNotFoundError, requireRoute, sameAccountRoute, } from './collection-command-work.ts';
export declare function libraryCommandAuthorization(...args: Parameters<typeof accessCommandAuthorization>): ReturnType<typeof accessCommandAuthorization>;
/** Authorization precedes identity disclosure. Missing disclosure, unbound or Collection-shaped
 * subject checks defer to the native subject resolver and library_entry admission. */
export declare function admitComposedEntryProgress(input: {
    actor: Actor;
    subjectId: string;
    deadline: number;
    at?: unknown;
}): Promise<void>;
type CommandContext = {
    transactionId: string;
    time: AuthoritativeTime;
};
export type LibraryCommandBody<T> = (tx: CommandTransaction, command: CommandContext) => Promise<CommandResult<T>>;
export type OwnAccountCommand = {
    action: string;
    kind: string;
    requestKey: string;
    input: unknown;
    /** Local cost owners may bind this execution to their existing descriptor. */
    execution?: LibraryCommandExecutionBinding;
    /** Complete static operation cost, separate from a custom caller execution wrapper. */
    executionPlan?: LibraryCommandExecutionPlan;
    /** One native attempt's closed cost, consumed again on each Core retry. */
    attemptPlan?: LibraryCommandExecutionPlan;
    sessionOperation?: SessionOperationKind;
    sessionPreparation?: boolean;
    deadline?: number;
    followOperation?: true;
};
export type TrustedAccountCommand = {
    kind: string;
    stepKey: string;
    input: unknown;
    /** Local cost owners may bind this execution to their existing descriptor. */
    execution?: LibraryCommandExecutionBinding;
    /** Complete static operation cost, separate from a custom caller execution wrapper. */
    executionPlan?: LibraryCommandExecutionPlan;
    followOperation?: true;
    deadline?: number;
};
export declare function libraryCommandReceiptDigest(identity: PrincipalCommandIdentity, kind: string, input: unknown): string;
export declare function libraryCommandReceiptDigestForActor(actor: Actor, kind: string, input: unknown): string;
/** Shared command boundary for account-owned library data and durable workflow steps. */
export declare function createLibraryCommandRunner(config: {
    pool: Pool;
    clock?: KernelClock;
    access?: Access;
    command?: typeof runCommand;
}): {
    ownAccount: <T>(actor: Actor, request: OwnAccountCommand, body: LibraryCommandBody<T>) => Promise<CommandOutcome<T>>;
    ownAccountPrepared: <P, T>(actor: Actor, request: OwnAccountCommand & {
        prepare: (attempt: CommandAttempt) => Promise<P>;
    }, body: (tx: CommandTransaction, context: CommandContext, prepared: P) => Promise<CommandResult<T>>, authorizePrepared?: (tx: CommandTransaction, attempt: CommandAttempt, prepared: P) => Promise<void>) => Promise<CommandOutcome<T>>;
    ownAccountReceiptOnly: <P, T>(actor: Actor, request: {
        action: string;
        kind: string;
        requestKey: string;
        digest: string;
        prepare: (attempt: CommandAttempt) => Promise<P>;
        authorize: (tx: CommandTransaction, attempt: CommandAttempt, prepared: P) => Promise<void>;
    }) => Promise<CommandOutcome<T> | null>;
    trustedAccount: <T>(accountId: string, request: TrustedAccountCommand, body: LibraryCommandBody<T>, prepare?: CommandAuthorization['prepare']) => Promise<CommandOutcome<T>>;
};
