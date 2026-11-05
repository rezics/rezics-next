import type { Pool } from 'pg';
import { type ConversationActivitySelection } from './conversation-activity.ts';
export type SubjectThreadConversationActivity = Readonly<{
    selected: readonly ConversationActivitySelection[];
    confirm(deadline: number): Promise<readonly ConversationActivitySelection[]>;
}>;
/** Bind selected native thread identities before Subject card hydration begins. */
export declare function selectSubjectThreadConversationActivity(pool: Pool, threadIds: readonly string[], deadline: number): Promise<SubjectThreadConversationActivity>;
export declare function staleSubjectThreadActivity(selections: readonly ConversationActivitySelection[]): boolean;
