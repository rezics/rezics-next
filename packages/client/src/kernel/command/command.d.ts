import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../request/access.ts';
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
export declare const MAX_COMMAND_EVENTS = 1000;
/** Principal kind marker only; never an account ID. */
export declare const ANONYMOUS_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";
export type CommandPrincipal = {
    kind: 'account';
    id: string;
} | {
    kind: 'anonymous';
    id: typeof ANONYMOUS_PRINCIPAL_ID;
};
type PrincipalCommandIdentity = Readonly<{
    principal: Readonly<Extract<CommandPrincipal, {
        kind: 'account';
    }>>;
    basis: Readonly<{
        clientId: string;
        requestedBy: string | null;
    }>;
}> | Readonly<{
    principal: Readonly<Extract<CommandPrincipal, {
        kind: 'anonymous';
    }>>;
    basis: Readonly<{
        clientId: null;
        requestedBy: null;
    }>;
}>;
/** Trusted verified Actor context only, never request JSON or proof of authorization. */
export declare function principalCommandIdentity(actor: Actor): PrincipalCommandIdentity;
export type PrincipalCommandReceipt = {
    kind: string;
    key: string;
    digest: Uint8Array;
};
export type PrincipalCommandOptions = PrincipalCommandIdentity & {
    partition: number;
    deadline?: number;
    receipt?: PrincipalCommandReceipt;
    authorization?: CommandAuthorization | undefined;
    /** Trusted service configuration only, never a request timestamp. */
    clock?: (() => Date) | undefined;
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
export declare class TooManyEventsError extends Error {
    readonly partition: number;
    readonly count: number;
    constructor(partition: number, count: number);
}
export declare class CommandUnavailableError extends Error {
    readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded' | 'anonymous-receipts';
    readonly partition: number;
    readonly movedTo: string | null;
    constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo?: string | null);
}
type LegacyCommandOptions = {
    partition: number;
    deadline?: number;
    basis?: CommandBasis;
    receipt?: CommandReceipt;
    authorization?: CommandAuthorization | undefined;
    /** Trusted service configuration only, never a request timestamp. */
    clock?: (() => Date) | undefined;
};
export declare function runCommand<T>(pool: Pool, options: LegacyCommandOptions, body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>): Promise<CommandOutcome<T>>;
export declare function runCommand<T>(pool: Pool, options: PrincipalCommandOptions, body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>): Promise<CommandOutcome<T>>;
export {};
