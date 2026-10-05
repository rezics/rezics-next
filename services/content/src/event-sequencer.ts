import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentPosition } from './core.ts';
import { ContentPositionPending, ContentUnavailable } from './errors.ts';

/** One Content receipt and its ordered event. Every owner in the Content database
 * records commands this way; positions come only from the sequencer. */
export interface ContentEvent {
  operationId: string;
  requestDigest: string;
  action: string;
  outcome: 'succeeded' | 'stale_head' | 'rejected';
  reason?: string | null;
  variantId?: string | null;
  revisionId?: string | null;
  eventType: string;
  recipe: string;
  payload: Record<string, unknown>;
}

const SEQUENCER_BATCH = 500;
/** A sequencer run is one indexed statement; writers poll it this long after commit. */
export const CONTENT_POSITION_WAIT_MS = 5_000;

/** Append without a position, in the caller's transaction. Takes no row shared
 * with unrelated writes; one statement, so the receipt never lacks its event. */
export async function appendContentEvent(client: PoolClient, event: ContentEvent): Promise<void> {
  const result = await client.query(`WITH terminal AS (
      INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, reason, variant_id, revision_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7::uuid) RETURNING operation_id)
    INSERT INTO content.outbox (id, operation_id, event_type, recipe, revision_id, payload)
    SELECT $8::uuid, operation_id, $9, $10, $7::uuid, $11::jsonb FROM terminal`,
  [event.operationId, event.requestDigest, event.action, event.outcome, event.reason ?? null,
    event.variantId ?? null, event.revisionId ?? null, randomUUID(), event.eventType, event.recipe,
    JSON.stringify(event.payload)]);
  if (result.rowCount !== 1) throw new ContentUnavailable('Content event was not recorded');
}

const busy = (error: unknown) => !!error && typeof error === 'object' && 'code' in error
  && ['55P03', '40P01'].includes(String(error.code));

/** Number every committed, unsequenced event. Returns how many it numbered; 0
 * when none are pending or another run holds the owner position row. Consumers
 * call it before reading, so an event whose writer stopped after commit is
 * numbered without that writer. Never call it inside an open transaction. */
export async function sequenceContentEvents(pool: Pool): Promise<number> {
  let total = 0;
  for (;;) {
    let assigned: number | null;
    try {
      assigned = (await pool.query<{ assigned: number | null }>(
        'SELECT content.sequence_events($1) AS assigned', [SEQUENCER_BATCH])).rows[0]?.assigned ?? null;
    } catch (error) {
      if (busy(error)) return total;
      throw error;
    }
    total += assigned ?? 0;
    if (assigned !== SEQUENCER_BATCH) return total;
  }
}

/** The committed operation's position, numbering pending events when no other
 * run holds the position row. Polls briefly while one does; a write is
 * acknowledged only with its exact position, and a retry of the same operation
 * resolves it later when the bound passes. Never call it inside an open transaction. */
export async function contentEventPosition(pool: Pool, operationId: string,
  waitMs = CONTENT_POSITION_WAIT_MS): Promise<ContentPosition> {
  const deadline = performance.now() + waitMs;
  for (let pause = 1; ; pause = Math.min(pause * 2, 50)) {
    try {
      const row = (await pool.query<{ data_epoch: string | null; sequence: string | null }>(
        'SELECT data_epoch, sequence::text AS sequence FROM content.event_position($1)', [operationId])).rows[0];
      if (row?.data_epoch && row.sequence) {
        return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'P0002') {
        throw new ContentUnavailable('Content receipt is absent');
      }
      if (!busy(error)) throw error;
    }
    if (performance.now() + pause > deadline) {
      throw new ContentPositionPending('Content event position is pending');
    }
    await new Promise(resolve => setTimeout(resolve, pause));
  }
}
