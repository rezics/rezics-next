import type { Pool } from 'pg';
import type { ContentOutboxEvent } from '../../../../content/src/core.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface ProgressSignal {
  structure: string;
  occurrence: string;
  read: boolean;
  finished: boolean;
  occurredAt: string;
}

/** Relay reader for the Structure owner's private, transactional Content event.
 * The public projection receives no principal, position, or private response. */
export async function readProgressSignal(pool: Pool, event: ContentOutboxEvent): Promise<ProgressSignal> {
  if (event.recipe !== 'structure-progress-v1' || event.eventType !== 'structure.progress.written'
    || event.revisionId !== null) throw new Error('Unsupported Structure progress event');
  const result = await pool.query<{ structure: string; occurrence: string; first_read: boolean;
    first_finish: boolean; occurred_at: Date }>(`SELECT command.structure, command.occurrence,
      command.first_read, command.first_finish, event.created_at AS occurred_at
    FROM content.outbox event
    JOIN content.receipt receipt ON receipt.operation_id = event.operation_id
      AND receipt.data_epoch = event.data_epoch AND receipt.sequence = event.sequence
    JOIN structure.progress_command command ON command.content_operation = receipt.operation_id
      AND command.request_digest = receipt.request_digest
    WHERE event.id = $1::uuid AND event.data_epoch = $2::uuid AND event.sequence = $3::bigint
      AND event.operation_id = $4 AND event.event_type = 'structure.progress.written'
      AND event.recipe = 'structure-progress-v1' AND receipt.action = 'structure.progress'
      AND receipt.outcome = 'succeeded'`,
  [event.id, event.position.dataEpoch, event.position.sequence, event.operationId]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || !ID.test(row.structure) || !ID.test(row.occurrence)
    || event.payload?.structure !== row.structure || event.payload?.occurrence !== row.occurrence
    || event.payload?.read !== row.first_read || event.payload?.finished !== row.first_finish
    || !event.position.sequence) throw new Error('Structure progress event differs from its receipt');
  return { structure: row.structure, occurrence: row.occurrence,
    read: row.first_read, finished: row.first_finish, occurredAt: row.occurred_at.toISOString() };
}
