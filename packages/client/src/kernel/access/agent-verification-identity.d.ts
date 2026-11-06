import type { IdentitySourceConsumerReference } from '../semantic/identity-source-consumer-custody.ts';
import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { IdentityNativeReceipt, IdentityIntent, IdentityJobRef, IdentityReceipt } from '../semantic/identity-epoch-contract.ts';
import { IdentityEpochStoreError } from '../semantic/identity-adapters/index.ts';
import { type AgentIdentitySourceKey } from '../history/contract/index.ts';
type AccountReceipt = Exclude<IdentityReceipt, {
    kind: 'subject.merge';
}>;
type Source = {
    account: string;
    accountKind: 'actor' | 'organization';
    catalogue: string;
    receipt: AccountReceipt;
    intent: IdentityIntent;
    requestedBy: string;
    decidedBy: string | null;
    requestId: string | null;
    pendingReceipt: string;
    commandReceipt?: {
        kind: string;
        key: string;
    };
    undo?: Awaited<ReturnType<typeof publishedAccountIdentityUndo>>;
    decision?: Awaited<ReturnType<typeof readOriginalAgentIdentityDecision>>;
    verificationReceipt?: string;
    disposition?: 'released' | 'revoked';
    reason?: string | null;
};
export type AccountIdentitySource = Readonly<{
    input: Readonly<{
        intent: IdentityIntent;
        receipt: AccountReceipt;
    }>;
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    digest: string;
    workflowId: string;
    roles: readonly import('../semantic/erasure-producer.ts').SemanticCopyRole[];
}>;
type OriginalIdentity = Readonly<{
    /** Identifies the actual serializer whose finite cut History owns. */
    writerKind: 'original' | 'recovery';
    key: AgentIdentitySourceKey;
    digest: string;
    partition: number;
    epoch: number;
    position: bigint;
    transactionId: string;
    workflowId: string;
    deliveryKey: string;
    handoff: Readonly<{
        partition: number;
        epoch: number;
        position: string;
        transactionId: string;
        eventType: string;
    }> | null;
    accounts: readonly import('../history/contract/locator.ts').AccountReference[];
}>;
/** History's data-only declaration verifier. Only this original writer issues the binding;
 * a historical source read, source UUID or a copied query method cannot issue it. */
export declare function originalAccountIdentitySource(tx: CommandTransaction, key: AgentIdentitySourceKey, digest: string): OriginalIdentity;
export declare function accountIdentityUnavailable(detail: string): IdentityEpochStoreError;
/** Record the immutable source and its SDK handoff in the ORIGINAL eventful account-home command. */
export declare function recordAccountIdentitySource(tx: CommandTransaction, source: Source): Promise<void>;
/** Current native T and account terminal fence precede the immutable receipt lookup and any disclosure. */
export declare function readAccountIdentitySource(tx: CommandTransaction, receipt: AccountReceipt, intent?: IdentityIntent, undoOnly?: boolean): Promise<AccountIdentitySource>;
/** In-command undo-only original source: account SHARE, intent, technical fallback.
 * Command controls are composed by the caller. Released History wrapping is a separate term. */
export declare function ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: 7;
        identityMetadataRows: 0;
        nativePoints: 7;
        witnessKeys: 0;
        statements: 3;
        bytes: number;
        emptySeeks: 3;
    }>;
}>;
/** Opaque source custody from a released native read; JSON or a raw CommandAuthorization cannot mint it. */
export declare function assertAccountIdentitySource(source: AccountIdentitySource, receipt: AccountReceipt, intent?: IdentityIntent): void;
export declare function loadAccountIdentitySource(pool: Pool, receipt: AccountReceipt): Promise<AccountIdentitySource>;
/** One bounded delivery/probe invocation. The original DBOS workflow owns durable sleeps/redrive. */
export declare function deliverAccountIdentity(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef>;
/** Reversal may name only the actual prior published verification job, after released source verification. */
export declare function publishedAccountIdentityUndo(pool: Pool, account: string, verificationReceipt: string): Promise<{
    job: IdentityJobRef;
    source: AccountIdentitySource;
}>;
/** Actual Global decision locator, resolved before the account home is acquired. */
export declare function readOriginalAgentIdentityDecision(pool: Pool, requestId: string, receiptId: string): Promise<Readonly<{
    request_id: string;
    account_id: string;
    account_kind: 'actor' | 'organization';
    catalogue_subject_id: string;
    requested_by: string;
    decided_by: string;
    epoch: number;
    position: string;
    transaction_id: string;
    native_receipt_key: string;
    request_digest: string;
    custody_id: string | null;
}>>;
export type OriginalAgentIdentityDecision = Awaited<ReturnType<typeof readOriginalAgentIdentityDecision>>;
export declare function assertOriginalAgentIdentityDecision(decision: OriginalAgentIdentityDecision): void;
/** Effects-free publication probe; retained history and unrelated jobs are never scanned. */
export declare function probeAccountIdentityPublication(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef>;
/** Same-home accepted technical custody; never admission, erasure completion or permission. */
export declare function acceptAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference): Promise<IdentityNativeReceipt | null>;
/** Re-lock the durable receiver in the enclosing source-home command. */
export declare function verifyAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference, receiving: IdentityNativeReceipt): Promise<boolean>;
export { readAccountIdentityReversalSettlement, verifyAccountIdentityReversalSettlement, type AccountIdentityReversalSettlement, } from './agent-verification-identity-reversal.ts';
