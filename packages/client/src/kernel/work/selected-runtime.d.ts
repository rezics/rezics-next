import type { Pool, QueryResult } from 'pg';
import { type OperationalOptions, type OperationalTransaction } from '../command/operational.ts';
import { type ExecutionTransaction, type SelectedExecutionPhase, type WorkExecutionOriginal, type WorkExecutionPort } from '../command/execution-contract.ts';
import { type WorkClient, type WorkIntent } from './client.ts';
import { type SelectedCost } from './selected-runtime-cost.ts';
import type { SelectedEpisode, SelectedLocator, SelectedOutcome } from '../history/contract/index.ts';
import { SelectedRuntimeUnavailable } from './application/index.ts';
import type { WorkSelectedIdentity } from './contract/index.ts';
export { SelectedRuntimeUnavailable };
export type SelectedIdentity = WorkSelectedIdentity;
export type SelectedNativeDeclaration = Readonly<{
    sql: string;
    limit: number;
    cost: SelectedCost;
}>;
export type SelectedChildren = Readonly<{
    native: readonly SelectedNativeDeclaration[];
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
    registerMembersStep<R>(body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>, children?: SelectedChildren): (locator: SelectedLocator) => Promise<R>;
}>;
export type SelectedOperationalPhase = SelectedExecutionPhase;
export declare class WorkExecutionUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
/** Work creates this opaque original once; retries retain its pool, client and absolute deadline. */
export declare function openWorkExecutionOriginal(pool: Pool, deadline: number, client: WorkClient): WorkExecutionOriginal;
/** Executor entry claims the exact original before authorization, checkout or BEGIN. */
export declare function claimWorkExecutionOriginal(original: WorkExecutionOriginal, pool: Pool, client: WorkClient, deadline: number): WorkExecutionOriginal;
export declare function debitWorkExecutionAttempt(original: WorkExecutionOriginal): void;
/** Work owner check used by History's native transfer adapter. */
export declare function assertWorkExecutionOriginal(tx: ExecutionTransaction, original: WorkExecutionOriginal): void;
export declare function selectedOperationalEnqueue(tx: OperationalTransaction, intent: WorkIntent): ((created: boolean) => void) | undefined;
export declare function assertSelectedOperationalTransaction(tx: OperationalTransaction, expected: SelectedIdentity): void;
export declare function selectedLocalQuery(tx: OperationalTransaction, expected: SelectedIdentity, sql: string, values?: unknown[]): Promise<QueryResult>;
export declare function assertSelectedContinuation(tx: OperationalTransaction, expected: SelectedIdentity, workflow: string): void;
export declare function openSelectedOperationalPhase(pool: Pool, options: OperationalOptions): import("./contract/ports.ts").WorkSelectedPhase;
export declare function composeSelectedRuntime(pool: Pool, work: WorkClient): SelectedRuntime;
/** Work-owned adapter installed on each native WorkClient by the Kernel composition roots. */
export declare function workExecutionPort(): WorkExecutionPort;
export type { SelectedEpisode, SelectedLocator, SelectedOutcome };
