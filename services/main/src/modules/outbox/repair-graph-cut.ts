import type { Pool } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { OutboxIncomplete, readNextMainOutboxBatch, type CustodiedOutboxSource } from './relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from './relay-position.ts';

/** Repair uses the relay's exact source reader; stream numbering is never
 * evidence of a graph cut. Lock the retained identity until the fill commits. */
export async function repairRetainedBatchGraphCut(fuseki: FusekiClient, pool: Pool,
  dataEpoch: string, sequence: string, ownerOutbox?: CustodiedOutboxSource): Promise<string> {
  if (!dataEpoch || !/^[1-9][0-9]{0,99}$/.test(sequence)) throw new OutboxIncomplete('invalid retained batch position');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const header = (await client.query<{
      batch_id: string; routing_epoch: string; event_count: number; graph_sequence: string | null;
    }>(`SELECT batch_id, routing_epoch, event_count, graph_sequence::text
      FROM relay.delivered_batch WHERE stream_scope = $1 AND data_epoch = $2 AND sequence = $3::numeric FOR UPDATE`,
    [MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence])).rows[0];
    if (!header) throw new OutboxIncomplete('retained batch header is unavailable');
    const batch = await readNextMainOutboxBatch(fuseki, dataEpoch, (BigInt(sequence) - 1n).toString(), ownerOutbox);
    if (!batch) throw new OutboxIncomplete('retained batch source evidence is unavailable');
    if (batch.streamScope !== MAIN_RELAY_STREAM_SCOPE || batch.dataEpoch !== dataEpoch || batch.sequence !== sequence
      || batch.batchId !== header.batch_id || batch.routingEpoch !== header.routing_epoch
      || batch.eventIds.length !== header.event_count) {
      throw new OutboxIncomplete('retained batch source evidence differs from its durable header');
    }
    if (!batch.graphSequence || !/^[1-9][0-9]{0,99}$/.test(batch.graphSequence)) {
      throw new OutboxIncomplete('retained batch source graph position is unavailable');
    }
    if (header.graph_sequence !== null && header.graph_sequence !== batch.graphSequence) {
      throw new OutboxIncomplete('retained batch has a different durable graph cut');
    }
    await client.query(`UPDATE relay.delivered_batch SET graph_sequence = $4::numeric
      WHERE stream_scope = $1 AND data_epoch = $2 AND sequence = $3::numeric AND graph_sequence IS NULL`,
    [MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence, batch.graphSequence]);
    await client.query('COMMIT');
    return batch.graphSequence;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the evidence failure. */ }
    throw error;
  } finally { client.release(); }
}
