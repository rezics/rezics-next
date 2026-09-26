import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RelayCheckpointConflict, verifiedRetainedRelayRange,
  type RetainedRelayBatch } from '../outbox/relay.ts';

export class RelayGapConflict extends Error {}
export class RelayGapInvalid extends Error {}

export interface RelayGapInput {
  consumer: string;
  relayConsumer: string;
  dataEpoch: string;
  afterSequence: string;
  throughSequence: string;
}

export interface RelayGapView {
  id: string;
  kind: 'relay_gap';
  consumer: string;
  state: 'running' | 'held' | 'reconciled' | 'failed';
  disposition: 'rebuilt' | 'gap' | null;
  replayed: boolean;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const name = /^[A-Za-z0-9:_./-]{1,128}$/;
const number = /^(0|[1-9][0-9]*)$/;

async function view(client: PoolClient, id: string, replayed: boolean): Promise<RelayGapView> {
  const found = await client.query<{ id: string; scope: string;
    state: RelayGapView['state']; disposition: RelayGapView['disposition'] }>(
      `SELECT r.id, r.scope, r.state, i.disposition FROM relay.owner_reconciliation r
       LEFT JOIN relay.owner_reconciliation_item i ON i.reconciliation_id = r.id AND i.ordinal = 1
       WHERE r.id = $1 AND r.kind = 'relay_gap'`, [id]);
  const row = found.rows[0];
  if (!row) throw new RelayGapConflict('relay gap reconciliation is missing');
  return { id: row.id, kind: 'relay_gap', consumer: row.scope,
    state: row.state, disposition: row.disposition, replayed };
}

/** One Access transaction copies verified retained envelopes and advances its checkpoint. */
async function rebuildInbox(access: Pool, input: RelayGapInput,
  batches: RetainedRelayBatch[]): Promise<void> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    if (input.afterSequence === '0') {
      await client.query(`INSERT INTO access.owner_consumer_checkpoint
        (consumer, data_epoch, sequence) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
      [input.consumer, input.dataEpoch]);
    }
    const found = await client.query<{ data_epoch: string; sequence: string }>(
      `SELECT data_epoch, sequence::text FROM access.owner_consumer_checkpoint
       WHERE consumer = $1 FOR UPDATE`, [input.consumer]);
    const checkpoint = found.rows[0];
    if (!checkpoint || checkpoint.data_epoch !== input.dataEpoch
      || ![input.afterSequence, input.throughSequence].includes(checkpoint.sequence)) {
      throw new RelayGapConflict('product consumer checkpoint differs from recovery range');
    }
    for (const batch of batches) {
      for (const event of batch.events) {
        await client.query(`INSERT INTO access.owner_consumer_replay
          (consumer, data_epoch, sequence, event_id, ordinal, envelope)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [input.consumer, input.dataEpoch, batch.sequence, event.id,
          event.data.ordinal, JSON.stringify(event)]);
        const stored = await client.query<{ same: boolean }>(
          `SELECT data_epoch = $3 AND sequence = $4 AND ordinal = $5
             AND envelope = $6::jsonb AS same
           FROM access.owner_consumer_replay WHERE consumer = $1 AND event_id = $2`,
          [input.consumer, event.id, input.dataEpoch, batch.sequence,
            event.data.ordinal, JSON.stringify(event)]);
        if (stored.rows[0]?.same !== true) {
          throw new RelayGapConflict('rebuilt consumer envelope differs from retained relay');
        }
      }
    }
    if (checkpoint.sequence === input.afterSequence) {
      await client.query(`UPDATE access.owner_consumer_checkpoint
        SET sequence = $2, updated_at = clock_timestamp() WHERE consumer = $1`,
      [input.consumer, input.throughSequence]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/**
 * Rebuild at most 100 contiguous broker-lost batches from the complete retained
 * relay handoff. Cost is one O(N) coverage scan plus O(K+E) indexed range reads
 * and Access writes for K <= 100 batches and E retained events. A crash after
 * Access commit resumes against the exact immutable envelopes before settling
 * the relay reconciliation ledger.
 */
export async function reconcileRelayGap(relay: Pool, access: Pool,
  input: RelayGapInput, key: string): Promise<RelayGapView> {
  if (!name.test(input.consumer) || !name.test(input.relayConsumer) || !input.dataEpoch
    || !number.test(input.afterSequence) || !number.test(input.throughSequence)
    || BigInt(input.throughSequence) <= BigInt(input.afterSequence)
    || BigInt(input.throughSequence) - BigInt(input.afterSequence) > 100n) {
    throw new RelayGapInvalid('invalid bounded relay gap range');
  }
  const operationId = `owner:reconcile:${key}`;
  const requestDigest = sha({ family: 'owner-relay-gap-v1', ...input });
  const client = await relay.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [operationId]);
    if (acquired.rows[0]?.locked !== true) throw new RelayGapConflict('relay gap pass is running');
    locked = true;
    let row = (await client.query<{ id: string; request_digest: string; state: string }>(
      'SELECT id, request_digest, state FROM relay.owner_reconciliation WHERE operation_id = $1',
      [operationId])).rows[0];
    const replayed = Boolean(row);
    if (row && row.request_digest !== requestDigest) {
      throw new RelayGapConflict('idempotency key binds another reconciliation');
    }
    if (!row) {
      const id = randomUUID();
      try { await client.query(`INSERT INTO relay.owner_reconciliation
        (id, operation_id, request_digest, kind, scope, consumer)
        VALUES ($1,$2,$3,'relay_gap',$4,$5)`,
      [id, operationId, requestDigest, input.consumer, input.relayConsumer]); }
      catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new RelayGapConflict('consumer relay gap pass is running');
        }
        throw error;
      }
      row = { id, request_digest: requestDigest, state: 'running' };
    }
    if (row.state !== 'running') return view(client, row.id, true);
    let batches: RetainedRelayBatch[];
    try {
      const retained = await verifiedRetainedRelayRange(relay, input.relayConsumer,
        input.afterSequence, Number(BigInt(input.throughSequence) - BigInt(input.afterSequence)));
      if (retained.coverage.dataEpoch !== input.dataEpoch
        || BigInt(retained.coverage.sequence) < BigInt(input.throughSequence)) {
        throw new RelayCheckpointConflict('retained handoff is behind requested recovery cut');
      }
      batches = retained.batches;
      if (batches.length !== Number(BigInt(input.throughSequence) - BigInt(input.afterSequence))
        || batches.at(-1)?.sequence !== input.throughSequence) {
        throw new RelayCheckpointConflict('retained handoff has a gap before recovery cut');
      }
    } catch (error) {
      if (!(error instanceof RelayCheckpointConflict)) throw error;
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO relay.owner_reconciliation_item
          (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition)
          VALUES ($1,1,'relay','relay_batch',$2,'gap')`,
        [row.id, `${input.dataEpoch}:${input.afterSequence}-${input.throughSequence}`]);
        await client.query(`UPDATE relay.owner_reconciliation SET state = 'held', hold_reason = $2
          WHERE id = $1`, [row.id, error.message.slice(0, 500)]);
        await client.query('COMMIT');
      } catch (commitError) { await client.query('ROLLBACK'); throw commitError; }
      return view(client, row.id, replayed);
    }
    await rebuildInbox(access, input, batches);
    const outcome = sha(batches.map(batch => [batch.sequence, batch.batchId,
      batch.routingEpoch, batch.events.map(event => event.id)]));
    await client.query('BEGIN');
    try {
      for (const [index, batch] of batches.entries()) {
        await client.query(`INSERT INTO relay.owner_reconciliation_item
          (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
          VALUES ($1,$2,'relay','relay_batch',$3,'rebuilt',$4)`,
        [row.id, index + 1, `${input.dataEpoch}:${batch.sequence}`,
          sha([batch.batchId, batch.routingEpoch, batch.events.map(event => event.id)])]);
      }
      for (const owner of ['relay', 'access']) {
        await client.query(`INSERT INTO relay.owner_reconciliation_cut
          (reconciliation_id, owner, data_epoch, sequence, coverage_digest, status)
          VALUES ($1,$2,$3,$4,$5,'matched')`,
        [row.id, owner, input.dataEpoch, input.throughSequence, outcome]);
      }
      await client.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled',
        outcome_digest = $2, completed_at = clock_timestamp() WHERE id = $1`,
      [row.id, outcome]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    return view(client, row.id, replayed);
  } finally {
    try { if (locked) await client.query(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [operationId]); }
    finally { client.release(); }
  }
}
