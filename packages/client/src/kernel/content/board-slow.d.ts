import type { Pool } from 'pg';
import { type AuthoritativeTime, type CommandOutcome, type CommandTransaction } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import type { ContentCommandDependencies } from './commands.ts';
import type { ContentCommandValue, RequestContext } from './model.ts';
export declare const BOARD_SLOW_RECOVERY_PAGE_SIZE = 25;
export declare const BOARD_SLOW_RETENTION_MS: number;
export declare class BoardSlowModeError extends Error {
    readonly retryAt: string;
    readonly intervalSeconds: number;
    constructor(retryAt: string, intervalSeconds: number);
}
export declare class BoardSlowAdmissionUnavailableError extends Error {
    readonly retryAfterSeconds = 1;
    constructor();
}
export declare class BoardSlowModeInputError extends Error {
}
export type BoardSlowReceiptReference = Readonly<{
    kind: string;
    key: string;
    digest: Uint8Array;
}>;
/**
 * The admission checkout and target ticket checkout both finish before runCommand
 * opens the thread-home transaction. The local ticket is the commit witness used
 * to recover uncertain delivery and close a permit after a process restart.
 */
export declare function boardSlowAdmission(deps: ContentCommandDependencies, actor: Actor, context: RequestContext, threadRoute: number, receipt: BoardSlowReceiptReference): {
    prepare(boardId: string, time: AuthoritativeTime): Promise<void>;
    claim(tx: CommandTransaction, time: AuthoritativeTime, details: Readonly<{
        targetPostId: string;
        revisionId: string;
        transactionId: string;
        postedAt: string;
    }>): Promise<void>;
    finish(outcome: CommandOutcome<ContentCommandValue>): Promise<void>;
    recoverLatest(): Promise<void>;
    assertAllowed(time: AuthoritativeTime): void;
};
export declare function setBoardSlowMode(deps: ContentCommandDependencies, actor: Actor, boardId: string, intervalSeconds: number, context: RequestContext): Promise<CommandOutcome<{
    intervalSeconds: number;
    retryAt: null;
    nextEligibleAt: null;
    canChange: boolean;
    exempt: boolean;
    admissionState: 'ready';
    retryAfterSeconds: number;
}>>;
export type BoardSlowModeRead = Readonly<{
    intervalSeconds: number;
    retryAt: string | null;
    /** Additive alias for the delivered Web slow-mode contract. */
    nextEligibleAt: string | null;
    canChange: boolean;
    exempt: boolean;
    admissionState: 'ready' | 'interval' | 'pending';
    retryAfterSeconds: number;
}>;
/** Caller must disclose the current board both before and after this bounded read. */
export declare function readBoardSlowMode(deps: ContentCommandDependencies, actor: Actor, boardId: string, deadline: number): Promise<BoardSlowModeRead>;
/** One bounded recovery page; board and thread checkouts never overlap. */
export declare function recoverBoardSlowModePage(pool: Pool, pageSize?: number, now?: Date, deadline?: number): Promise<number>;
/** Erase one bounded pseudonymous actor page after fencing in-flight commands. */
export declare function eraseBoardSlowModeAccountPage(pool: Pool, routeKey: Uint8Array, accountId: string, pageSize?: number, deadline?: number): Promise<Readonly<{
    removed: number;
    more: boolean;
    pending: boolean;
}>>;
/** Delete one bounded page of expired command history and its thread-home witnesses. */
export declare function pruneBoardSlowModeHistoryPage(pool: Pool, pageSize?: number, cutoff?: string, deadline?: number): Promise<number>;
