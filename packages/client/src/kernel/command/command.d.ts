export declare const DEFAULT_REQUEST_DEADLINE_MS = 2000;
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../request/access.ts';
export { CommandUnavailableError } from '../access/unavailable.ts';
export type CommandEvent = {
    type: string;
    subject?: string;
    data: unknown;
};
export type CommandTransaction = Pick<PoolClient, 'query'>;
export type CommandCallback = (transactionId: string) => void | Promise<void>;
export type CommandResult<T> = Readonly<{
    value: T;
    events: readonly CommandEvent[];
}>;
/**
 * Return a successful command result without domain events. The body must make
 * no domain write; this result asserts that it did not. Its observed position
 * can be 0. Callers whose consumers require a positive position must not use
 * noEffect.
 */
export declare function noEffect<T>(value: T): CommandResult<T>;
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
/** Pure receipt-key validation; the anonymous marker never identifies an account. */
export declare function normalizeCommandKey(principal: CommandPrincipal, key: string): string;
export type PrincipalCommandIdentity = Readonly<{
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
export declare function principalCommandIdentity(actor: Extract<Actor, {
    kind: 'anonymous';
}>): Extract<PrincipalCommandIdentity, {
    basis: {
        clientId: null;
    };
}>;
export declare function principalCommandIdentity(actor: Extract<Actor, {
    kind: 'account';
}>): Extract<PrincipalCommandIdentity, {
    basis: {
        clientId: string;
    };
}>;
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
/** Anonymous attribution never supplies a legacy account identity. */
export type CommandAttribution = CommandBasis | {
    principal: Readonly<Extract<CommandPrincipal, {
        kind: 'anonymous';
    }>>;
    actorAccountId: null;
    clientId: null;
    requestedBy: null;
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
/** Opaque authoritative time minted for one live command attempt or one read. */
export type AuthoritativeTime = {
    readonly [authoritativeTime]: true;
};
export type CommandAttempt = Readonly<{
    partition: number;
    basis: Readonly<CommandAttribution> | null;
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
    /** Runs only after a successful body, before receipt/outbox writes. Never on replay. */
    finalize?(tx: CommandTransaction, attempt: CommandAttempt, evidence: unknown): Promise<void>;
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
/** Completion metadata only. The caller must retain the queried intent's action/resource policy. */
export declare function hasOwnCommandCompletion(tx: CommandTransaction, receipt: PrincipalCommandReceipt): Promise<boolean>;
export declare function authoritativeTimeValue(time: AuthoritativeTime): string;
/** Read-only context is unavailable before authorization or after the attempt. */
export declare function currentCommand(tx: CommandTransaction): CurrentCommand;
/** Allows existing Access checks in a mutation to reuse the same attempt time. */
export declare function commandTime(tx: CommandTransaction): AuthoritativeTime | undefined;
/** Executor internals: lend Access an attempt time without granting command authority.
 * Operational attempts never enter commands, receiptOwners or the callback registry.
 */
export declare function withOperationalAttempt<T>(tx: CommandTransaction, attempt: CommandAttempt, run: () => Promise<T>): Promise<T>;
/** Release an executor time when preparation fails before resource checkout. */
export declare function releaseOperationalTime(time: AuthoritativeTime): void;
/** Register work for the current command after its body and finalizer succeed.
 * The callback receives the executor-minted transaction id and runs before the
 * receipt and outbox are written. Registration is scoped to one live attempt.
 */
export declare function registerCommandCallback(tx: CommandTransaction, callback: CommandCallback): void;
/** True for the transaction and deadline-bound wrappers around it while the
 * executor attempt is live. The symbol capability is private to this module.
 */
export declare function hasLiveCommandTransaction(tx: CommandTransaction): boolean;
/** Mints an authoritative time for a read outside a command, with no command context. */
export declare function mintReadTime(client: CommandTransaction, clock?: () => Date): Promise<AuthoritativeTime>;
export declare class IdempotencyConflictError extends Error {
    readonly partition: number;
    constructor(partition: number);
}
export declare class TooManyEventsError extends Error {
    readonly partition: number;
    readonly count: number;
    constructor(partition: number, count: number);
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
