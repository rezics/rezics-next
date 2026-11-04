import type { Pool } from 'pg';
import { createConversationActivityBatch, type ConversationActivitySelection } from './conversation-activity.ts';

export type SubjectThreadConversationActivity = Readonly<{
  selected: readonly ConversationActivitySelection[];
  confirm(deadline: number): Promise<readonly ConversationActivitySelection[]>;
}>;

/** Bind selected native thread identities before Subject card hydration begins. */
export async function selectSubjectThreadConversationActivity(
  pool: Pool,
  threadIds: readonly string[],
  deadline: number,
): Promise<SubjectThreadConversationActivity> {
  const batch = createConversationActivityBatch(pool);
  const selected = await batch.select([...new Set(threadIds)], deadline);
  return Object.freeze({ selected, confirm: (currentDeadline) => batch.confirm(selected, currentDeadline) });
}

export function staleSubjectThreadActivity(selections: readonly ConversationActivitySelection[]): boolean {
  return selections.some((selection) => selection.status === 'withheld' && selection.reason === 'stale');
}
