import { type AccountIdentityReversalSettlement } from '../../access/agent-verification-identity.ts';
import type { Pool } from 'pg';
import { type CommandTransaction } from '../../command/command.ts';
import { type IdentityAdmissionAuthority, type IdentityAdmissionInput, type IdentityJobRef } from './identity-epoch-contract.ts';
import type { IdentitySourceConsumerReference, IdentitySourceConsumerGeneration, IdentitySourceConsumerDisposition, IdentitySourceConsumerWork, IdentitySourceConsumerContext } from '../identity-source-consumer-custody.ts';
/** A serializable locator is custody data. Only a released verified read mints an in-process proof. */
export type IdentityReceiptBinding = Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}>;
export type IdentityAdmissionSource = Readonly<{
    input_original: string;
    source_route: number;
    source_revision: string;
    source_transaction_id: string;
    source_owner_epoch: number;
    partition_no: number;
    terminal: string;
    generation: string;
    version: string;
    observed_count: string;
    owner_epoch: number;
    ready: boolean;
    pending_job: string | null;
    /** Captured only for terminal detachment, retained with its immutable generation basis. */
    remainder_terminal?: string | null;
}>;
export type IdentityBindingData = Readonly<{
    partition: number;
    key: string;
    digest: string;
    generation: string;
    transactionId: string;
    receipt: unknown;
    job: IdentityJobRef;
    home: number;
    scope: string;
    sources: readonly IdentityAdmissionSource[];
    state: 'pending' | 'accepted' | 'not-applied';
}>;
export declare function identityBindingData(proof: IdentityReceiptBinding): IdentityBindingData;
export declare function identityReceiptPartition(receipt: IdentityAdmissionInput['receipt']): number;
export declare function identityBindingDigest(input: IdentityAdmissionInput): string;
/** Only native source reads at the released binding home can attach Accounts custody. */
export declare function assertIdentityBindingSource(binding: IdentityReceiptBinding, receipt: IdentityAdmissionInput['receipt']): void;
export type AccountAgentReceipt = Extract<IdentityAdmissionInput['receipt'], {
    kind: 'account-agent.verify' | 'account-agent.unverify';
}>;
/** Admitted mapping custody. The account home re-reads the original Access source for this exact intent and
 * releases that home before any destination work; a moved, fenced or absent source is retryable unavailability.
 */
export declare function admittedAccountMappingSource(pool: Pool, receipt: AccountAgentReceipt, intent: IdentityAdmissionInput['intent']): Promise<void>;
export declare function readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}> | null>;
/** Accepted original input lookup for the same-home technical receiver. This does
 * not authorize admission or attach Accounts source custody to the returned binding.
 */
export declare function readAcceptedAccountIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput & Readonly<{
    receipt: Extract<IdentityAdmissionInput['receipt'], {
        kind: 'account-agent.verify' | 'account-agent.unverify';
    }>;
}>): Promise<IdentityReceiptBinding | null>;
export declare function identityBindingJob(pool: Pool, data: IdentityBindingData): Promise<any>;
/** Current authorization and native T precede even the existing-key lookup. Every checkout is released. */
export declare function lookupIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}> | null>;
/** Effects-free native cap/current-capacity collection must precede this claim. No P slot is added. */
export declare function claimIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput, prepared: {
    home: number;
    epoch: bigint;
    scope: string;
    sources: readonly IdentityAdmissionSource[];
}): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}>>;
/** The first group reservation is independently durable before this immutable accepted pointer. */
export declare function acceptIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput, binding: IdentityReceiptBinding): Promise<void>;
/** Read-only original undo custody. This cannot mint a new binding or a source admission proof. */
export declare function readAccountIdentityUndo(pool: Pool, receipt: Extract<IdentityAdmissionInput['receipt'], {
    kind: 'account-agent.verify';
}>): Promise<{
    source: Readonly<{
        input: Readonly<{
            intent: import("./identity-epoch-contract.ts").IdentityIntent;
            receipt: Readonly<{
                kind: 'account-agent.verify';
                account: string;
                receipt: string;
            }> | Readonly<{
                kind: 'account-agent.unverify';
                account: string;
                receipt: string;
            }>;
        }>;
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        digest: string;
        workflowId: string;
        roles: readonly import("../erasure-producer.ts").SemanticCopyRole[];
    }>;
    job: {
        jobId: string;
        epoch: bigint;
    };
}>;
export declare function identityBindingAccountRoles(binding: IdentityReceiptBinding): readonly import("../erasure-producer.ts").SemanticCopyRole[];
/** Two released snapshots: retained Source provenance then accepted job/control. */
export declare function IDENTITY_SOURCE_BINDING_CONSUMER_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: 13;
        identityMetadataRows: 0;
        nativePoints: 13;
        witnessKeys: 0;
        statements: 10;
        bytes: number;
        emptySeeks: 2;
    }>;
}>;
/** Resolve native generations with Source's live maintenance allocation. Each
 * released snapshot prepays its failed point, control and cleanup work. The
 * directory receives planning data and charges the same frame when it dispatches.
 */
export declare function readIdentitySourceConsumerWork(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerWork | null>;
/** Only the Source owner can append a terminal row. This hook locks its original
 * binding and checks native generations; immutable undo/replay input still requires
 * genuine Accounts acceptance. No publication or directory fact proves reversal.
 */
export declare function lockIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, reversal?: AccountIdentityReversalSettlement): Promise<IdentitySourceConsumerDisposition | null>;
export declare function verifyIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, disposition: IdentitySourceConsumerDisposition, reversal?: AccountIdentityReversalSettlement): Promise<boolean>;
