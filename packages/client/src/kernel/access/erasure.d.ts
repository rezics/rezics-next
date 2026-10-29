import type { WorkModule } from '../work/registry.ts';
import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
/** Append versions; never change a list used by a recorded erasure. */
export declare const ERASURE_PARTICIPANTS: Readonly<{
    1: readonly ["access", "auth", "library", "commerce", "content", "community", "semantic", "search", "imports", "shared-history", "delivery"];
}>;
export declare const ERASURE_PARTICIPANT_VERSION = 1;
/** Owners register every effect that writes cross-partition erasure locators here. */
export declare const ERASURE_LOCATOR_EFFECTS: ReadonlySet<string>;
export type ErasureOutcome = 'erased' | 'none';
export type RetentionException = {
    store: string;
    fields: readonly string[];
    purpose: string;
    expiresAt: Date;
};
type StoredException = Omit<RetentionException, 'expiresAt'> & {
    expiresAt: string;
};
export type ErasureStatus = {
    state: 'pending' | 'retention-outstanding' | 'complete';
    version: number;
    at: string;
    participants: Record<string, {
        outcome: ErasureOutcome | 'pending';
        retained: (StoredException & {
            resolvedAt: string | null;
            overdue: boolean;
        })[];
    }>;
    outstanding: {
        lateItems: boolean;
        effectsFrontier: boolean;
    };
    completedAt: string | null;
};
/** Internal platform work, called only after the owner's final purge transaction commits.
 * The acknowledgement itself is the permanent idempotency record, independent of receipts and DBOS history.
 */
export declare function acknowledgeErasure(deps: {
    pool: Pool;
    clock?: () => Date;
}, input: {
    accountId: string;
    participant: string;
    outcome: ErasureOutcome;
    retained?: readonly RetentionException[];
}): Promise<import("../command/command.ts").CommandOutcome<{
    accountId: string;
    participant: string;
    outcome: ErasureOutcome;
}>>;
/** The owner calls this in a separate platform command after its expiry purge commits. */
export declare function resolveRetention(deps: {
    pool: Pool;
    clock?: () => Date;
}, input: {
    accountId: string;
    participant: string;
    store: string;
}): Promise<import("../command/command.ts").CommandOutcome<{
    accountId: string;
    participant: string;
    store: string;
}>>;
/** Internal/test read. One snapshot covers both the record and its bounded acknowledgement range. */
export declare function readErasureStatus(client: AccessClient, accountId: string): Promise<ErasureStatus | null>;
type LateErasureItem = {
    accountId: string;
    participant: string;
    locator: string;
};
/** Call with the live home command holding the participant's locator fence. Ids only, never personal payload. */
export declare function recordLateErasureItem(tx: CommandTransaction, input: LateErasureItem): Promise<void>;
/** Internal platform command, only after the copy's minimization or purge commits. */
export declare function resolveLateErasureItem(deps: {
    pool: Pool;
    clock?: () => Date;
}, input: LateErasureItem): Promise<import("../command/command.ts").CommandOutcome<LateErasureItem>>;
/** One durable terminal-work step; requests never drive completion. */
export declare function advanceErasureCompletion(deps: {
    pool: Pool;
    clock?: () => Date;
}, accountId: string): Promise<import("../command/command.ts").CommandOutcome<boolean>>;
/** The terminal workflow survives retries and completion is independent of retained DBOS history. */
export declare const erasureWorkModule: WorkModule;
export {};
