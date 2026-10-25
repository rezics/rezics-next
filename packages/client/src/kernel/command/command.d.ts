import type { Pool, PoolClient } from 'pg';
export type CommandEvent = {
    type: string;
    subject?: string;
    data: unknown;
};
export type CommandTransaction = Pick<PoolClient, 'query'>;
type CommandResult<T> = {
    value: T;
    events: CommandEvent[];
};
export type CommandReceipt = {
    actorAccountId: string;
    kind: string;
    key: string;
    digest: Uint8Array;
};
export type CommandBasis = {
    actorAccountId: string;
    clientId: string;
    requestedBy: string | null;
};
export type CommandOutcome<T> = {
    value: T;
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    replayed: boolean;
};
declare const authoritativeTime: unique symbol;
/** Only runCommand can mint a time. Its value is usable for the live attempt only. */
export type AuthoritativeTime = {
    readonly [authoritativeTime]: true;
};
export type CommandAttempt = Readonly<{
    partition: number;
    basis: Readonly<CommandBasis> | null;
    time: AuthoritativeTime;
}>;
export type CommandAuthorizationMode = 'execute' | 'receipt-only';
/** Trusted service binding, never operation JSON. prepare runs with no resource
 * connection held; it can check a separately anchored parent at this attempt's T.
 * authorize makes the final resource check before any receipt is read.
 */
export type CommandAuthorization = {
    readonly action: string;
    readonly resource: Readonly<{
        route: number;
        id: string;
    }>;
    prepare?(attempt: CommandAttempt): Promise<unknown>;
    authorize(tx: CommandTransaction, attempt: CommandAttempt, evidence: unknown): Promise<CommandAuthorizationMode>;
    denied(): Error;
};
declare const completedAuthorization: unique symbol;
export type CompletedCommandAuthorization = Readonly<{
    [completedAuthorization]: true;
    action: string;
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    mode: CommandAuthorizationMode;
}>;
export type CurrentCommand = CommandAttempt & Readonly<{
    authorization: CompletedCommandAuthorization | null;
}>;
type CommandContext = {
    transactionId: string;
    time: AuthoritativeTime;
};
export declare function authoritativeTimeValue(time: AuthoritativeTime): string;
/** Read-only context is unavailable before authorization or after the attempt. */
export declare function currentCommand(tx: CommandTransaction): CurrentCommand;
/** Allows existing Access checks in a mutation to reuse the same attempt time. */
export declare function commandTime(tx: CommandTransaction): AuthoritativeTime | undefined;
export declare class IdempotencyConflictError extends Error {
    readonly partition: number;
    constructor(partition: number);
}
export declare class CommandUnavailableError extends Error {
    readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
    readonly partition: number;
    readonly movedTo: string | null;
    constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo?: string | null);
}
export declare function runCommand<T>(pool: Pool, options: {
    partition: number;
    deadline?: number;
    basis?: CommandBasis;
    receipt?: CommandReceipt;
    authorization?: CommandAuthorization | undefined;
    /** Trusted service configuration only, never a request timestamp. */
    clock?: (() => Date) | undefined;
}, body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>): Promise<CommandOutcome<T>>;
export {};
