import type { Pool, PoolClient } from 'pg';
import type { ContentPosition } from '../../../content/src/core.ts';
import { ContentUnavailable } from '../../../content/src/errors.ts';
import { appendContentEvent, contentEventPosition } from '../../../content/src/event-sequencer.ts';

export class ContentSequenceUnavailable extends Error {}

export interface ContentSequenceEvent {
  operationId: string;
  requestDigest: string;
  action: string;
  outcome: 'succeeded' | 'stale_head' | 'rejected';
  reason?: string;
  eventType: string;
  recipe: string;
  payload: Record<string, unknown>;
}

/** A recorded command whose event the sequencer has not numbered yet. */
export interface PendingContentPosition { owner: 'content'; operationId: string }

/** One receipt and its event in one statement, inside the caller's transaction,
 * which also holds its owner rows. It takes no shared row: the caller resolves
 * the exact position after commit with settledContentPosition. Owners without
 * projection consumers still emit an event with their own recipe; Content's
 * ordered relay acknowledges it without projecting private state. */
export async function advanceContentSequence(client: PoolClient,
  event: ContentSequenceEvent): Promise<PendingContentPosition> {
  try { await appendContentEvent(client, event); }
  catch (error) {
    if (error instanceof ContentUnavailable) throw new ContentSequenceUnavailable(error.message);
    throw error;
  }
  return { owner: 'content', operationId: event.operationId };
}

/** After the caller's commit, never inside its transaction: the exact position. */
export function settledContentPosition(pool: Pool,
  pending: PendingContentPosition | string): Promise<ContentPosition> {
  return contentEventPosition(pool, typeof pending === 'string' ? pending : pending.operationId);
}
