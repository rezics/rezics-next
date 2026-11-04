import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { AnchoredPosition } from './model.ts';
export declare const CONVERSATION_ACTIVITY_SOURCE_LIMIT = 32;
export declare const CONVERSATION_ACTIVITY_BATCH_LIMIT = 100;
export declare const CONVERSATION_ACTIVITY_REPLY_COUNT_CAP = 10000;
/** Internal candidates only. Neither a timestamp nor a length is a disclosed figure. */
export type ConversationContributionSource = Readonly<{
    postId: string;
    opening: boolean;
    contributedAt: string;
}>;
export type ConversationActivitySource = Readonly<{
    threadId: string;
    coverage: 'unproven';
    contributions: readonly ConversationContributionSource[];
    /** A full prefix may have more rows; this is not an exact count. */
    more: boolean;
    anchor: AnchoredPosition;
}>;
export type ConversationActivityReplyCount = Readonly<{
    kind: 'exact';
    value: number;
} | {
    kind: 'lower-bound';
    value: number;
}>;
export type ConversationActivityWitness = Readonly<{
    threadId: string;
    boardId: string;
    threadSecurityRevision: string;
    boardSecurityRevision: string;
    realmId: string | null;
    boardGeneration: string;
    generation: string;
    /** eventSeq 1000 marks a repair cut after every event at this partition position. */
    sourceHead: Readonly<{
        epoch: number;
        position: bigint;
        eventSeq: number;
    }>;
    source: AnchoredPosition;
}>;
export type ConversationActivityCurrent = Readonly<{
    threadId: string;
    status: 'current';
    cohort: 'public';
    replyCount: ConversationActivityReplyCount;
    lastContributionAt: string | null;
    witness: ConversationActivityWitness;
}>;
export type ConversationActivityWithheld = Readonly<{
    threadId: string;
    status: 'withheld';
    reason: 'missing' | 'coverage' | 'unsupported-cohort' | 'stale';
}>;
export type ConversationActivitySelection = ConversationActivityCurrent | ConversationActivityWithheld;
export type ConversationActivityBatch = Readonly<{
    /** Selects by raw keys, before consumer hydration. It never returns a protected cohort. */
    select(threadIds: readonly string[], deadline: number): Promise<readonly ConversationActivitySelection[]>;
    /** Reopens current native thread, place and cohort state after hydration. */
    confirm(selected: readonly ConversationActivitySelection[], deadline: number): Promise<readonly ConversationActivitySelection[]>;
}>;
export { CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE, repairConversationActivityPage, } from './conversation-activity-repair.ts';
export declare function toConversationActivityReplyCount(count: bigint | string): ConversationActivityReplyCount;
/** Factory bound at the consumer's selected native key set, before labels/actions are hydrated. */
export declare function createConversationActivityBatch(pool: Pool): ConversationActivityBatch;
/** Registered alongside board ranking, using its native source snapshot and
 * lifecycle. This is source maintenance, never an Access or disclosure engine. */
export declare function createConversationActivityEffect(pool: Pool): Effect;
/** Trusted native producer seam. Group by represented home and release each
 * snapshot before any caller starts independent current-disclosure hydration. */
export declare function readConversationActivitySources(pool: Pool, threadIds: readonly string[], deadline: number): Promise<readonly ConversationActivitySource[]>;
