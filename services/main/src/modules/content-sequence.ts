import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ContentPosition } from '../../../content/src/core.ts';

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

/** One singleton update and two inserts: constant rows and one SQL round trip.
 * The caller's transaction includes its owner rows. The single statement also
 * prevents an event/receipt constraint failure from leaving an advanced position.
 * Owners without projection consumers still emit an event with their own recipe;
 * Content's ordered relay acknowledges it without projecting private state. */
export async function advanceContentSequence(client: PoolClient,
  event: ContentSequenceEvent): Promise<ContentPosition> {
  const result = await client.query<{ data_epoch: string; sequence: string }>(`
    WITH position AS (
      UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
      RETURNING data_epoch, sequence
    ), terminal AS (
      INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, reason, data_epoch, sequence)
      SELECT $1, $2, $3, $4, $5, data_epoch, sequence FROM position
      RETURNING operation_id, data_epoch, sequence
    )
    INSERT INTO content.outbox
      (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
    SELECT $6::uuid, data_epoch, sequence, operation_id, $7, $8, $9::jsonb FROM terminal
    RETURNING data_epoch, sequence::text`,
  [event.operationId, event.requestDigest, event.action, event.outcome, event.reason ?? null,
    randomUUID(), event.eventType, event.recipe, JSON.stringify(event.payload)]);
  const row = result.rows[0];
  if (!row) throw new ContentSequenceUnavailable('Content owner position is unavailable');
  return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
}
