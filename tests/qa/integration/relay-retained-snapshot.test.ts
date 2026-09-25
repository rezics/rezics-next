import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { relayCoverage, RelayCheckpointConflict, relayRetainedEventAt }
  from '../../../services/main/src/modules/outbox/relay.ts';

test('SYS12/OPS03: retained relay proof crosses an ordered PostgreSQL page boundary', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const dataEpoch = randomUUID();
  const consumer = `relay-page:${randomUUID()}`;
  const source = 'https://rezics.com/services/main';
  const eventPrefix = `urn:rezics:test-event:${randomUUID()}:`;
  const batchPrefix = `urn:rezics:test-batch:${randomUUID()}:`;
  try {
    await pool.query('INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ($1, $2, 1001)',
      [consumer, dataEpoch]);
    await pool.query(`INSERT INTO relay.delivered_batch
      (data_epoch, sequence, batch_id, routing_epoch, event_count)
      SELECT $1::text, position, $2::text || position::text, '1', 1
      FROM generate_series(1, 1001) AS position`, [dataEpoch, batchPrefix]);
    await pool.query(`INSERT INTO relay.delivered_event
      (source, event_id, data_epoch, sequence, envelope)
      SELECT $1::text, $2::text || position::text, $3::text, position,
        jsonb_build_object('specversion', '1.0', 'id', $2::text || position::text,
          'source', $1::text, 'type', 'com.rezics.work.created.v1',
          'datacontenttype', 'application/json', 'data',
          jsonb_build_object('batchId', $4::text || position::text, 'ordinal', 0))
      FROM generate_series(1, 1001) AS position`,
    [source, eventPrefix, dataEpoch, batchPrefix]);
    expect((await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relay.delivered_event WHERE data_epoch = $1',
      [dataEpoch])).rows[0]?.count).toBe('1001');
    const coverage = await relayCoverage(pool, consumer);
    expect(coverage).toMatchObject({ sequence: '1001', batchCount: '1001', eventCount: '1001' });
    const retained = await relayRetainedEventAt(pool, coverage, '1001');
    expect(retained).toMatchObject({ eventId: `${eventPrefix}1001`,
      envelope: { id: `${eventPrefix}1001` },
      batch: { batchId: `${batchPrefix}1001`, routingEpoch: '1', eventCount: 1 } });

    await pool.query('UPDATE relay.delivered_batch SET batch_id = $1 WHERE data_epoch = $2 AND sequence = 1000',
      [`changed-${randomUUID()}`, dataEpoch]);
    await expect(relayRetainedEventAt(pool, coverage, '1001'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    await pool.query('UPDATE relay.delivered_batch SET batch_id = $1 WHERE data_epoch = $2 AND sequence = 1000',
      [`${batchPrefix}1000`, dataEpoch]);

    await pool.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,marker}', '"changed"'::jsonb)
      WHERE data_epoch = $1 AND sequence = 1`, [dataEpoch]);
    await expect(relayRetainedEventAt(pool, coverage, '1001'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
  } finally {
    try {
      await pool.query('DELETE FROM relay.delivered_event WHERE data_epoch = $1', [dataEpoch]);
      await pool.query('DELETE FROM relay.delivered_batch WHERE data_epoch = $1', [dataEpoch]);
      await pool.query('DELETE FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    } finally {
      await pool.end();
    }
  }
});
