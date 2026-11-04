import type { Pool } from 'pg';
export declare const CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE = 100;
export type ConversationActivityRepairPage = Readonly<{
    partition: number;
    kind: 'source' | 'board' | 'thread' | 'idle';
    scannedThreads: number;
    repairedPosts: number;
    completedThreads: number;
    /** Source enumeration and visible convergence are intentionally separate. */
    sourceComplete: boolean;
    more: boolean;
}>;
/**
 * Advances exactly one resumable native prefix: the raw thread census, one
 * board invalidation page, or one thread's ordered post page. Each transaction
 * commits its frontier with the data it covers so a retry replays safely.
 */
export declare function repairConversationActivityPage(pool: Pool, partitionNo: number, deadline: number): Promise<ConversationActivityRepairPage>;
