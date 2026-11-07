import type { Pool } from 'pg';
import { type IdentityVoteKey } from './identity-work-frame.ts';
import type { RatingRepairReceipt } from './identity-repair.ts';
export type IdentityRepairCountedVote = Readonly<{
    questionId: string;
    targetId: string;
    countedTargetId: string | null;
    units: number | null;
    revision: number;
    countedRevision: number;
    changedAt: string;
    transactionId: string;
}>;
export type IdentityRepairVoteChangeEffect = Readonly<{
    voterId: string;
    questionId: string;
    targetId: string;
    aggregateTargetId?: string;
    previous: number | null;
    units: number | null;
    revision: number;
    populations: readonly string[];
}>;
export type IdentityRepairPageEffect = Readonly<{
    voterId: string;
    workId: string;
    generation: string;
    pageId: string;
    digest: string;
    terminal: boolean;
    mode: 'repair' | 'withdrawal';
}>;
export type IdentityRepairWorkEffect = Readonly<{
    voterId: string;
    workId: string;
    generation: string;
    action: 'admit' | 'select' | 'cancel' | 'invalidate';
}>;
export type IdentityRepairOutboxEffect = Readonly<{
    position: string;
    eventSeq: string;
    id: string;
    type: string;
    subject: string;
    time: string;
    data: IdentityRepairVoteChangeEffect | IdentityRepairPageEffect | IdentityRepairWorkEffect | Record<string, unknown>;
}>;
export type IdentityRepairCheckpoint = Readonly<{
    generation: string;
    workId: string;
    state: 'active' | 'complete' | 'cancelled';
    mode: 'repair' | 'withdrawal';
    cursor: IdentityVoteKey | null;
    through: IdentityVoteKey | null;
    selectedPageId: string | null;
}>;
export type IdentityRepairObligationRecord = Readonly<{
    obligationId: string;
    workId: string;
    generation: string;
    pageId: string;
    pageDigest: string;
    mappingDigest: string;
    mappings: readonly Readonly<{
        originalId: string;
        terminalId: string;
        epoch: string;
    }>[];
    originals: readonly string[];
    throughQuestionId: string | null;
    throughTargetId: string | null;
    state: 'preparing' | 'held' | 'bound';
    laterChange: boolean;
    laterVote: boolean;
    receiptTransactionId: string | null;
    drainReceiptId: string | null;
}>;
export type IdentityRepairRead = Readonly<{
    countedVotes(voterId: string): Promise<readonly IdentityRepairCountedVote[]>;
    orderedEffects(voterId: string): Promise<readonly IdentityRepairOutboxEffect[]>;
    voteEffects(voterId: string): Promise<readonly IdentityRepairVoteChangeEffect[]>;
    pageEffects(voterId: string): Promise<readonly IdentityRepairPageEffect[]>;
    receipts(voterId: string): Promise<readonly RatingRepairReceipt[]>;
    receipt(voterId: string, pageId: string): Promise<RatingRepairReceipt | null>;
    checkpoint(voterId: string): Promise<IdentityRepairCheckpoint | null>;
    obligations(voterId: string): Promise<readonly IdentityRepairObligationRecord[]>;
    boundObligation(voterId: string, pageId: string): Promise<IdentityRepairObligationRecord | null>;
}>;
/** Released Pool observations of Rating identity-repair pages. They never hold mappings. */
export declare function createIdentityRepairRead(pool: Pool): IdentityRepairRead;
