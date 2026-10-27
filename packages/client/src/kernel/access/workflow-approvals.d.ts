import type { CredentialFloorBinding as CredentialEffectBinding } from '@rezics/auth-contract';
import type { AccountOperation as ContractAccountOperation, WorkflowResponsibility } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, ActionCatalogue } from '../request/access.ts';
import { type KeyRing } from '../tokens/seal.ts';
import type { LifecycleRequest } from './lifecycle.ts';
import credentialRead from './auth-credential-capability-workflow-read.sql';
export declare const MAX_WORKFLOW_APPROVAL_LIFETIME_MS = 300000;
/** Host composition registers these workflow actions without a kernel HTTP route. */
export declare const WORKFLOW_APPROVAL_ACTIONS: ActionCatalogue;
/** Nonsecret integrity-bound locator only; no actor, credentials or authority. */
export type WorkflowApproval = {
    reference: string;
    expiresAt: string;
};
export type WorkflowApprovalConfig = {
    pool: Pool;
    access: Access;
    actions: ActionCatalogue;
    referenceKeys: KeyRing;
};
export type CredentialOperation = Pick<CredentialEffectBinding, 'subjectAccountId' | 'purpose' | 'operationKey' | 'effectReference' | 'effectDigest'> & {
    kind: 'credential';
    subjectEpoch: number;
    authorization: string;
};
type TransferOperation = Extract<ContractAccountOperation, {
    kind: 'transfer';
}> & {
    acceptance?: string;
};
/** The contract's revoke carries no approval reference; this adapter binds one and denies a request without. */
type RevokeOperation = {
    kind: 'revoke';
    accountId: string;
    authorization?: string;
};
type TransferAcceptanceOperation = {
    kind: 'transfer-acceptance';
    previous: WorkflowResponsibility;
    expectedVersion: string;
    operatorAccountId: string;
    sourceOperationKey: string;
    authorization: string;
};
type AccountOperation = (Exclude<ContractAccountOperation, {
    kind: 'transfer' | 'revoke';
}> | RevokeOperation | TransferOperation | TransferAcceptanceOperation) & {
    operationKey?: string;
};
export type WorkflowApprovalRequest = {
    operationKey: string;
    operation: AccountOperation;
};
export type WorkflowApprovalBinding = Readonly<{
    operationKey: string;
    digest: string;
    expiresAt: string;
    /** Stable across fresh approvals and DBOS attempts. Append a fixed native step
     * name, and keep the native command's complete input digest on every retry. */
    commandKeyPrefix: string;
}>;
/** Return only durable binding metadata; never serialize the resolved context. */
export declare function workflowApprovalBinding(request: LifecycleRequest): WorkflowApprovalBinding | undefined;
export declare class WorkflowApprovalUnavailableError extends Error {
    readonly status = 503;
    constructor();
}
export declare class WorkflowApprovalDeniedError extends Error {
    readonly status = 403;
    constructor();
}
type CredentialWorkflowPorts = {
    approveCredentialForActor(actor: AccountActor, binding: CredentialEffectBinding, context: AccessContext): Promise<WorkflowApproval>;
    readConsumedCredential(reference: string, context: AccessContext): ReturnType<typeof credentialRead.run>;
    approveCredential(token: string, binding: CredentialEffectBinding, context: AccessContext): Promise<WorkflowApproval>;
    consumeCredential(reference: string, binding: CredentialEffectBinding, caller: AccountActor, context: AccessContext): Promise<{
        receiptId: string;
        expiresAt: string;
        subjectEpoch: number;
    }>;
};
/** Trusted credential capability only. Generic workflow/session APIs stay closed. */
export declare function credentialWorkflowApprovals(api: ReturnType<typeof createWorkflowApprovals>): CredentialWorkflowPorts;
/** Native durable approval storage only. Resolve once in each step that takes a
 * new effect for the person, before that effect: every resolution prepares its
 * own evidence at its own T and nothing is written before it passes. A step that
 * only completes an effect already committed runs under that effect's record and
 * is not resolved again; the actor is never re-authorized against state the
 * operation itself changed. The actual command still authorizes at its own T.
 * Auth consent reductions invalidate these original scopes through the shared
 * Access epoch floor. No Auth database, introspection or runtime is consulted.
 */
export declare function createWorkflowApprovals<Config extends WorkflowApprovalConfig>(config: Config): {
    approve: (token: string, input: WorkflowApprovalRequest, context: AccessContext) => Promise<WorkflowApproval>;
    /** Trusted server workflow port, never an unauthenticated HTTP endpoint. */
    resolve(reference: string, operation: AccountOperation, context: AccessContext): Promise<LifecycleRequest>;
    resolveForCaller(token: string, reference: string, operation: AccountOperation, context: AccessContext): Promise<LifecycleRequest>;
};
/** Internal scheduling port; one route/partition and at most 1000 exact expiry
 * keys per command. Expiry correctness never depends on this cleanup running. */
export declare function sweepWorkflowApprovals(pool: Pool, route: number, limit: number): Promise<number>;
export {};
