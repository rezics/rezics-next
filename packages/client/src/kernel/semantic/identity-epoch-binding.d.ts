import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { IdentityAdmissionAuthority, IdentityAdmissionInput, IdentityJobRef } from './identity-epoch-contract.ts';
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
export declare function readIdentityBinding(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<Readonly<{
    partition: number;
    generation: string;
    transactionId: string;
    jobHome: number;
    job: IdentityJobRef;
}> | null>;
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
        roles: readonly import("./erasure-producer.ts").SemanticCopyRole[];
    }>;
    job: {
        jobId: string;
        epoch: bigint;
    };
}>;
export declare function identityBindingAccountRoles(binding: IdentityReceiptBinding): readonly import("./erasure-producer.ts").SemanticCopyRole[];
