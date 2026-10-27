import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
export type AccountVerificationLink = {
    label: string;
    url: string;
};
export type AgentVerificationRequestInput = {
    accountId: string;
    subject: string;
    statement: string;
    links: readonly AccountVerificationLink[];
    key: string;
};
export type AgentVerificationState = 'pending' | 'approving' | 'approved' | 'rejected' | 'withdrawn' | 'failed';
export type AgentVerificationRequest = {
    id: string;
    accountId: string;
    accountKind: 'actor' | 'organization';
    requestedBy: string;
    catalogueSubjectId: string;
    statement: string;
    links: AccountVerificationLink[];
    state: AgentVerificationState;
    reason: string | null;
    problem: {
        type: string;
        detail: string;
    } | null;
    decisionReceiptId: string | null;
    decidedBy: string | null;
    createdAt: string;
    updatedAt: string;
};
export type PendingVerificationPage = {
    verificationRequests: AgentVerificationRequest[];
    next: string | null;
};
type VerificationRow = {
    id: string;
    accountId: string;
    accountKind: 'actor' | 'organization';
    requestedBy: string;
    catalogueSubjectId: string;
    statement: string;
    links: unknown;
    state: AgentVerificationState;
    reason: string | null;
    problemType: string | null;
    problemDetail: string | null;
    decisionReceiptId: string | null;
    decidedBy: string | null;
    createdAt: string;
    updatedAt: string;
};
type VerificationContext = AccessContext & {
    actor: Actor;
};
export declare class AgentVerificationDeniedError extends Error {
    constructor();
}
export declare class AgentVerificationConflictError extends Error {
    constructor();
}
export declare class AgentVerificationAccountError extends Error {
    readonly problemType = "account_verification_unavailable";
    constructor(message: string);
}
export declare class AgentVerificationPageConflictError extends Error {
    readonly problemType = "agent_verification_page_conflict";
    constructor();
}
/** One status lookup for the actor's own latest request or a managed organization. */
export declare function readLatestAgentVerificationRequest(pool: Pool, access: Access, context: VerificationContext, accountId: string): Promise<AgentVerificationRequest | null>;
/** Pending governance page; the partial index excludes every decided request. */
export declare function readPendingAgentVerificationRequests(pool: Pool, access: Access, context: VerificationContext, tokens: KeyRing, input: {
    limit?: number;
    cursor?: string;
}, at: Date): Promise<PendingVerificationPage>;
export declare function createAgentVerificationCommands(config: {
    pool: Pool;
    access: Access;
    clock: () => Date;
}): {
    request(context: VerificationContext, input: AgentVerificationRequestInput): Promise<CommandOutcome<AgentVerificationRequest>>;
    withdraw(context: VerificationContext, input: {
        accountId: string;
        key: string;
    }): Promise<CommandOutcome<AgentVerificationRequest>>;
    approve(context: VerificationContext, input: {
        requestId: string;
        key: string;
        reason?: string;
    }): Promise<CommandOutcome<AgentVerificationRequest>>;
    reject(context: VerificationContext, input: {
        requestId: string;
        key: string;
        reason?: string;
    }): Promise<CommandOutcome<AgentVerificationRequest>>;
};
export type AgentVerificationWorkflowRequest = Pick<AgentVerificationRequest, 'id' | 'accountId' | 'accountKind' | 'requestedBy' | 'catalogueSubjectId' | 'state' | 'decisionReceiptId'>;
/** Durable workflow read: one primary-key lookup in the Global Context partition. */
export declare function readAgentVerificationWorkflowRequest(pool: Pool, requestId: string): Promise<AgentVerificationWorkflowRequest | null>;
/** Step one records the approval on the account anchor before semantic platform work. */
export declare function recordPendingAgentVerification(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}, clock: () => Date): Promise<void>;
/** Idempotent semantic step. The semantic service uses the committed decision receipt as its merge receipt. */
export declare function mergeVerifiedAgent(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}): Promise<void>;
/** Persist the public-page pointer on the subject's route after Semantic has accepted the merge. */
export declare function writeAgentVerificationPage(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}): Promise<void>;
/** Completion is a second, idempotent point command after the semantic merge commits. */
export declare function completeAgentVerification(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}, clock: () => Date): Promise<void>;
/** Failure cleanup and terminal request update use independent receipts so restart resumes either half. */
export declare function clearPendingAgentVerification(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}, clock: () => Date): Promise<void>;
export declare function finishAgentVerification(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
}, clock: () => Date): Promise<void>;
export declare function failAgentVerification(pool: Pool, input: AgentVerificationWorkflowRequest & {
    receiptId: string;
    problem: {
        type: string;
        detail: string;
    };
}, clock: () => Date): Promise<void>;
export declare function loadVerificationRequestRow(pool: Pool, requestId: string): Promise<VerificationRow | null>;
export {};
