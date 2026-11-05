import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { Access, ActionCatalogue } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type LifecycleReceipt } from './lifecycle-20261025094010-command.ts';
/** Distinct from workflow approvals. A sealed reference authorizes one allowlisted
 * cleanup step and never a caller's result or a later permission. */
export declare const COMMITTED_CONTINUATION_PURPOSE = "access.committed-continuation.v1";
export declare const COMMITTED_CONTINUATION_TTL_MS: number;
/** The protected native workflow port gives each resumed step ten seconds. */
export declare const COMMITTED_CONTINUATION_RESUME_BUDGET_MS = 10000;
/** Route-bearing continuation ids. Independent of the lifecycle fence namespace. */
export declare const CONTINUATION_NAMESPACE = "b7c3d1e2-4f50-4a61-8c70-0d1e2f304152";
export declare const COMMITTED_CONTINUATION_ACTIONS: ActionCatalogue;
export declare class ContinuationDeniedError extends Error {
    readonly status = 403;
    constructor();
}
export type ContinuationEntry = {
    step: string;
    target: string;
    key: string;
    digest: string;
};
export type ContinuationBinding = {
    operationKey: string;
    operationDigest: string;
    commandKeyPrefix: string;
    approvalExpiresAt?: string;
};
export type ContinuationSnapshot = {
    route: number;
    continuationId: string;
    accountId: string;
    operationKey: string;
    operationDigest: string;
    commandKeyPrefix: string;
    barrierReceiptId: string;
    barrierTransactionId: string;
    minimumAuthnEpoch: string;
    priorHandle: string | null;
    priorOperatorAccountId: string | null;
    priorReservationId: string | null;
    allowlist: ContinuationEntry[];
    createdAt: string;
    committedExpiresAt: string;
};
export type ContinuationView = {
    reference: string;
    operationKey: string;
    operationDigest: string;
    commandKeyPrefix: string;
    barrierReceiptId: string;
    expiresAt: string;
    allowlist: ContinuationEntry[];
};
export declare function canonicalInstant(value: unknown): string;
export declare function continuationEntryDigest(entry: Pick<ContinuationEntry, 'step' | 'target' | 'key'>): string;
export declare function committedContinuationDigest(snapshot: ContinuationSnapshot): string;
export declare function deletionAllowlist(input: {
    accountId: string;
    commandKeyPrefix: string;
    handle: string | null;
    operatorAccountId: string | null;
    reservationId: string | null;
}): ContinuationEntry[] | null;
export declare function validateContinuationBinding(binding: ContinuationBinding): void;
/** Approval lifetime is admission metadata, not part of the replayed business command. */
export declare function continuationCommandBinding(binding: ContinuationBinding | undefined): {
    operationKey: string;
    operationDigest: string;
    commandKeyPrefix: string;
} | null;
/** The row commits in the tombstone transaction. Its sealed reference is derived
 * later from the immutable digest; renewal changes only the live expiry. */
export declare function insertDeletionContinuation(tx: CommandTransaction, input: {
    accountId: string;
    handle: string | null;
    operatorAccountId: string | null;
    reservationId: string | null;
    binding: ContinuationBinding;
    barrierReceiptId: string;
    minimumAuthnEpoch: string;
    transactionId: string;
    allowlist?: ContinuationEntry[];
}): Promise<void>;
export declare function isFenceContinuation(root: ContinuationSnapshot): boolean;
export declare function isDeletionContinuation(root: ContinuationSnapshot): boolean;
/** Every effect checks an exact root entry and the stored expiry at its command's T.
 * The completion and the business receipt commit together; receipt replay writes neither twice. */
export declare function recordCompletion(tx: CommandTransaction, located: {
    route: number;
    continuationId: string;
    digest: string;
}, presented: ContinuationEntry, receiptId: string, receipt: LifecycleReceipt): Promise<{
    continuationId: string;
    receiptId: string;
}>;
/** Native local consumer, deliberately not an Auth completion or an erasure ACK.
 * Its input is an exact discovered root id. Nothing here copies the root into
 * DBOS, renews an approval, or infers consumption from authorization records.
 * Existing business commands execute under their ORIGINAL committed keys.
 */
export declare function continueErasureDeletion(pool: Pool, continuationId: string, clock?: () => Date): Promise<void>;
export type CommittedContinuations = {
    /** Trusted kernel recovery port. Each iteration commits one bounded page. */
    continueCommitted(reference: string): Promise<void>;
    continueCommittedPage(reference: string, cursor?: string, previous?: string): Promise<{
        next: string | null;
        pageKey: string;
    }>;
    read(operationKey: string, accountId: string): Promise<ContinuationView | null>;
    authorizeStep(reference: string, entry: ContinuationEntry): Promise<{
        continuationId: string;
        receiptId: string;
    }>;
    renew(token: string, continuationId: string): Promise<{
        continuationId: string;
        expiresAt: string;
        receiptId: string;
    }>;
};
/** Trusted server port. Callers pass a sealed reference, never request JSON. */
export declare function createCommittedContinuations(config: {
    pool: Pool;
    access: Access;
    referenceKeys: KeyRing;
    clock?: () => Date;
    pageSize?: number;
}): CommittedContinuations;
