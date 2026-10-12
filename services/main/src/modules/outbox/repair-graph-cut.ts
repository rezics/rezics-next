import type { Pool } from 'pg';
import { fusekiReadBudget, type FusekiClient } from '../../infrastructure/fuseki.ts';
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
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; SET LOCAL transaction_timeout = '30s'");
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

export interface GraphCutRepairPage {
  repaired: number;
  refused: { sequence: string; reason: string }[];
  next: string | null;
}

/** At most limit+1 indexed headers and limit serial repairs. Admit work for 60 s;
 * each repair has 102 source reads (header, members, up to 100 event checks),
 * 8 MiB and a 20 s source deadline. SQL statements take at most 5 s, locks 2 s,
 * transactions 30 s, and the bounded pool's checkout 5 s: draining the last
 * repair can extend the page by at most 35 s. No background repair outlives it.
 * Refusals advance the cursor but retain NULL, so starting over retries them. */
export async function repairRetainedBatchGraphCuts(fuseki: FusekiClient, pool: Pool,
  dataEpoch: string, after = '0', limit = 200,
  ownerOutbox?: CustodiedOutboxSource): Promise<GraphCutRepairPage> {
  if (!dataEpoch || !/^(0|[1-9][0-9]{0,99})$/.test(after)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new OutboxIncomplete('invalid retained batch repair page');
  }
  const deadline = performance.now() + 60_000;
  const client = await pool.connect();
  let rows: { sequence: string }[];
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; SET LOCAL transaction_timeout = '30s'");
    rows = (await client.query<{ sequence: string }>(`SELECT batch.sequence::text FROM relay.delivered_batch AS batch
      WHERE stream_scope = $1 AND data_epoch = $2 AND sequence > $3::numeric AND graph_sequence IS NULL
      ORDER BY batch.sequence LIMIT $4`, [MAIN_RELAY_STREAM_SCOPE, dataEpoch, after, limit + 1])).rows;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the page failure. */ }
    throw error;
  } finally { client.release(); }
  const result: GraphCutRepairPage = { repaired: 0, refused: [], next: null };
  let processed = 0;
  let cursor = after;
  for (const row of rows.slice(0, limit)) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    try {
      await fusekiReadBudget.run({ callsLeft: 102, bytesLeft: 8 * 1024 * 1024,
        signal: AbortSignal.timeout(Math.min(20_000, remaining)) }, () =>
        repairRetainedBatchGraphCut(fuseki, pool, dataEpoch, row.sequence, ownerOutbox));
      result.repaired++;
    } catch (error) {
      result.refused.push({ sequence: row.sequence, reason: error instanceof Error ? error.message : String(error) });
    }
    processed++;
    cursor = row.sequence;
  }
  if (processed < rows.length) result.next = cursor;
  return result;
}
