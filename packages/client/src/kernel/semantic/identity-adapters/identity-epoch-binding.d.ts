import type { AccountIdentityReversalSettlement, AccountIdentitySource } from '../../access/agent-verification-identity.ts';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../../command/command.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import { type IdentityAdmissionAuthority, type IdentityAdmissionInput, type IdentityIntent, type IdentityJobRef, type IdentityReceipt } from './identity-epoch-contract.ts';
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
export declare function identityBindingAccountRoles(binding: IdentityReceiptBinding): readonly import("../erasure-producer.ts").SemanticCopyRole[];
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
export type AccountAgentReceipt = Extract<IdentityAdmissionInput['receipt'], {
    kind: 'account-agent.verify' | 'account-agent.unverify';
}>;
export type IdentityBindingOperations = Readonly<{
    authorizeIdentityAdmission(tx: CommandTransaction, receipt: IdentityReceipt, binding?: IdentityReceiptBinding, intent?: IdentityIntent): Promise<AccountIdentitySource | undefined>;
    recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void;
    assertIdentityBindingSource(binding: IdentityReceiptBinding, receipt: IdentityAdmissionInput['receipt']): void;
    admittedAccountMappingSource(pool: Pool, receipt: AccountAgentReceipt, intent: IdentityAdmissionInput['intent']): Promise<void>;
    readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<IdentityReceiptBinding | null>;
    readAcceptedAccountIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput & Readonly<{
        receipt: Extract<IdentityAdmissionInput['receipt'], {
            kind: 'account-agent.verify' | 'account-agent.unverify';
        }>;
    }>): Promise<IdentityReceiptBinding | null>;
    identityBindingJob(pool: Pool, data: IdentityBindingData): Promise<{
        state: string;
    } | null>;
    lookupIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput): Promise<IdentityReceiptBinding | null>;
    claimIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput, prepared: {
        home: number;
        epoch: bigint;
        scope: string;
        sources: readonly IdentityAdmissionSource[];
    }): Promise<IdentityReceiptBinding>;
    acceptIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput, binding: IdentityReceiptBinding): Promise<void>;
    readAccountIdentityUndo(pool: Pool, receipt: Extract<IdentityAdmissionInput['receipt'], {
        kind: 'account-agent.verify';
    }>): Promise<Readonly<{
        source: AccountIdentitySource;
        job: IdentityJobRef;
    }>>;
    readIdentitySourceConsumerWork(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerWork | null>;
    lockIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, reversal?: AccountIdentityReversalSettlement): Promise<IdentitySourceConsumerDisposition | null>;
    verifyIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, disposition: IdentitySourceConsumerDisposition, reversal?: AccountIdentityReversalSettlement): Promise<boolean>;
}>;
/** Binding, Accounts source and native commit operations closed over one capability set. */
export declare function createIdentityBindingOperations(capabilities: NativeIdentityCapabilities): IdentityBindingOperations;
export declare function authorizeIdentityAdmission(tx: CommandTransaction, receipt: IdentityReceipt, binding?: IdentityReceiptBinding, intent?: IdentityIntent): Promise<Readonly<{
    input: Readonly<{
        intent: IdentityIntent;
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
}> | undefined>;
export { recordIdentityEpochNativeCommit } from './native-commit.ts';
export declare function assertIdentityBindingSource(binding: IdentityReceiptBinding, receipt: IdentityAdmissionInput['receipt']): void;
export declare function admittedAccountMappingSource(pool: Pool, receipt: AccountAgentReceipt, intent: IdentityAdmissionInput['intent']): Promise<void>;
export declare function readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}> | null>;
export declare function readAcceptedAccountIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput & Readonly<{
    receipt: Extract<IdentityAdmissionInput['receipt'], {
        kind: 'account-agent.verify' | 'account-agent.unverify';
    }>;
}>): Promise<IdentityReceiptBinding | null>;
export declare function identityBindingJob(pool: Pool, data: IdentityBindingData): Promise<{
    state: string;
} | null>;
export declare function lookupIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}> | null>;
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
export declare function acceptIdentityBinding(pool: Pool, authority: IdentityAdmissionAuthority, input: IdentityAdmissionInput, binding: IdentityReceiptBinding): Promise<void>;
export declare function readAccountIdentityUndo(pool: Pool, receipt: Extract<IdentityAdmissionInput['receipt'], {
    kind: 'account-agent.verify';
}>): Promise<Readonly<{
    source: AccountIdentitySource;
    job: IdentityJobRef;
}>>;
export declare function readIdentitySourceConsumerWork(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerWork | null>;
export declare function lockIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, reversal?: AccountIdentityReversalSettlement): Promise<IdentitySourceConsumerDisposition | null>;
export declare function verifyIdentitySourceConsumerCut(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected: IdentitySourceConsumerGeneration, disposition: IdentitySourceConsumerDisposition, reversal?: AccountIdentityReversalSettlement): Promise<boolean>;
