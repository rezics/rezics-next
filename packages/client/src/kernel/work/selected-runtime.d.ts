import type { Pool, PoolClient } from 'pg';
import { type OperationalOptions, type OperationalTransaction } from '../command/operational.ts';
import { type WorkClient, type WorkIntent } from './client.ts';
import { type SelectedCost } from './selected-runtime-cost.ts';
import { type SelectedEpisode, type SelectedLocator, type SelectedOutcome } from '../history/operational-work-selected.ts';
export type SelectedIdentity = Readonly<{
    workflowID: string;
    functionID: number;
    stepName: string;
    attemptGeneration: string;
    restoreGeneration: string;
    workflowName: string;
    queueName: string | null;
    creatorXid: string | null;
    serialization: string | null;
    inputs: string;
    stepArguments: string;
    deadline: number;
    schema: string;
}>;
export declare class SelectedRuntimeUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
/** Reviewed literal native statements, each with its complete child declaration and multiplicity.
 * This is a dispatch description, never a Source or user authorization capability. */
export type SelectedNativeDeclaration = Readonly<{
    sql: string;
    limit: number;
    cost: SelectedCost;
}>;
export type SelectedChildren = Readonly<{
    native: readonly SelectedNativeDeclaration[];
    /** Complete released Source invocation, including reached failure and its cleanup. */
    source?: SelectedCost;
}>;
export type SelectedInvocation = Readonly<{
    deadline: number;
    select(locator: SelectedLocator): Promise<SelectedEpisode>;
    source<T>(body: (deadline: number) => Promise<T>): Promise<T>;
    apply(episode: SelectedEpisode, body: (tx: OperationalTransaction) => Promise<SelectedOutcome>): Promise<SelectedOutcome>;
    failure(episode: SelectedEpisode, body: (tx: OperationalTransaction) => Promise<SelectedOutcome>): Promise<SelectedOutcome>;
}>;
export type SelectedRuntime = Readonly<{
    /** Trusted Work registration. One invocation is ONE episode; cleanup has separate authority. */
    registerMembersStep<R>(body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>, children?: SelectedChildren): (locator: SelectedLocator) => Promise<R>;
}>;
declare const phase: unique symbol;
export type SelectedOperationalPhase = {
    readonly [phase]: true;
};
/** Same executor enqueue, exactly once; SDK costs are paid independently of foreign native SQL. */
export declare function selectedOperationalEnqueue(tx: OperationalTransaction, intent: WorkIntent): ((created: boolean) => void) | undefined;
/** History can dispatch owned SQL only with the exact private identity of this live transaction. */
export declare function assertSelectedOperationalTransaction(tx: OperationalTransaction, expected: SelectedIdentity): void;
export declare function selectedLocalQuery(tx: OperationalTransaction, expected: SelectedIdentity, sql: string, values?: unknown[]): Promise<import("pg").QueryResult<any>>;
export declare function assertSelectedContinuation(tx: OperationalTransaction, expected: SelectedIdentity, workflow: string): void;
/** Executor-only optional lifecycle. Native transaction construction and live maps stay in operational.ts. */
export declare function openSelectedOperationalPhase(pool: Pool, options: OperationalOptions): {
    deadline: number;
    assertLive(): void;
    query(sql: unknown): void;
    hold(tx: OperationalTransaction, raw: PoolClient): Promise<void>;
    guardBody(): void;
    finish(): void;
};
/** Trusted composition only. The genuine client binding is installed solely by createWorkClient. */
export declare function composeSelectedRuntime(pool: Pool, work: WorkClient): SelectedRuntime;
export {};
