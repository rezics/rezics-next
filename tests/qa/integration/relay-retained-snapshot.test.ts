import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { relayCoverage, RelayCheckpointConflict, relayRetainedEventAt }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';

test('SYS12/OPS03: retained relay proof crosses an ordered PostgreSQL page boundary', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const dataEpoch = randomUUID();
  const consumer = `relay-page:${randomUUID()}`;
  const crossStreamScope = `urn:rezics:test-stream:${randomUUID()}`;
  const source = 'https://rezics.com/services/main';
  const eventPrefix = `urn:rezics:test-event:${randomUUID()}:`;
  const batchPrefix = `urn:rezics:test-batch:${randomUUID()}:`;
  const crossEventId = `urn:rezics:test-event:${randomUUID()}`;
  const crossBatchId = `urn:rezics:test-batch:${randomUUID()}`;
  try {
    await pool.query(`INSERT INTO relay.checkpoint
      (consumer, stream_scope, data_epoch, sequence) VALUES ($1, $2, $3, 1001)`,
    [consumer, MAIN_RELAY_STREAM_SCOPE, dataEpoch]);
    await pool.query(`INSERT INTO relay.delivered_batch
      (stream_scope, data_epoch, sequence, batch_id, routing_epoch, event_count)
      SELECT $3::text, $1::text, position, $2::text || position::text, '1', 1
      FROM generate_series(1, 1001) AS position`, [dataEpoch, batchPrefix, MAIN_RELAY_STREAM_SCOPE]);
    await pool.query(`INSERT INTO relay.delivered_event
      (stream_scope, source, event_id, data_epoch, sequence, envelope)
      SELECT $5::text, $1::text, $2::text || position::text, $3::text, position,
        jsonb_build_object('specversion', '1.0', 'id', $2::text || position::text,
          'source', $1::text, 'type', 'com.rezics.work.created.v1',
          'datacontenttype', 'application/json', 'data',
          jsonb_build_object('batchId', $4::text || position::text, 'ordinal', 0,
            'sourcePosition', jsonb_build_object('datasetId', 'product',
              'dataEpoch', $3::text, 'sequence', position::text), 'routingEpoch', '1'))
      FROM generate_series(1, 1001) AS position`,
    [source, eventPrefix, dataEpoch, batchPrefix, MAIN_RELAY_STREAM_SCOPE]);
    expect((await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relay.delivered_event WHERE stream_scope = $1 AND data_epoch = $2',
      [MAIN_RELAY_STREAM_SCOPE, dataEpoch])).rows[0]?.count).toBe('1001');
    const coverage = await relayCoverage(pool, consumer);
    expect(coverage).toMatchObject({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      sequence: '1001', batchCount: '1001', eventCount: '1001' });
    const retained = await relayRetainedEventAt(pool, coverage, '1001');
    expect(retained).toMatchObject({ eventId: `${eventPrefix}1001`,
      envelope: { id: `${eventPrefix}1001` },
      batch: { batchId: `${batchPrefix}1001`, routingEpoch: '1', eventCount: 1 } });
    expect(retained.envelope.data.relayPosition).toEqual({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch, sequence: '1001' });

    await pool.query(`UPDATE relay.delivered_batch SET batch_id = $1
      WHERE stream_scope = $3 AND data_epoch = $2 AND sequence = 1000`,
    [`changed-${randomUUID()}`, dataEpoch, MAIN_RELAY_STREAM_SCOPE]);
    await expect(relayRetainedEventAt(pool, coverage, '1001'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    await pool.query(`UPDATE relay.delivered_batch SET batch_id = $1
      WHERE stream_scope = $3 AND data_epoch = $2 AND sequence = 1000`,
    [`${batchPrefix}1000`, dataEpoch, MAIN_RELAY_STREAM_SCOPE]);

    await pool.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,marker}', '"changed"'::jsonb)
      WHERE stream_scope = $2 AND data_epoch = $1 AND sequence = 1`, [dataEpoch, MAIN_RELAY_STREAM_SCOPE]);
    await expect(relayRetainedEventAt(pool, coverage, '1001'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    await pool.query(`UPDATE relay.delivered_event SET envelope = envelope #- '{data,marker}'
      WHERE stream_scope = $2 AND data_epoch = $1 AND sequence = 1`, [dataEpoch, MAIN_RELAY_STREAM_SCOPE]);

    await pool.query(`INSERT INTO relay.delivered_batch
      (stream_scope, data_epoch, sequence, batch_id, routing_epoch, event_count)
      VALUES ($1, $2, 1001, $3, '1', 1)`, [crossStreamScope, dataEpoch, crossBatchId]);
    await pool.query(`INSERT INTO relay.delivered_event
      (stream_scope, source, event_id, data_epoch, sequence, envelope)
      VALUES ($1, $2, $3, $4, 1001,
        jsonb_build_object('specversion', '1.0', 'id', $3::text, 'source', $2::text,
          'type', 'com.rezics.work.created.v1', 'datacontenttype', 'application/json', 'data',
          jsonb_build_object('batchId', $5::text, 'ordinal', 0,
            'sourcePosition', jsonb_build_object('datasetId', 'product',
              'dataEpoch', $4::text, 'sequence', '1001'), 'routingEpoch', '1')))`,
    [crossStreamScope, source, crossEventId, dataEpoch, crossBatchId]);
    expect(await relayCoverage(pool, consumer)).toEqual(coverage);
    expect((await relayRetainedEventAt(pool, coverage, '1001')).eventId).toBe(`${eventPrefix}1001`);

    await pool.query(`DELETE FROM relay.delivered_batch
      WHERE stream_scope = $1 AND data_epoch = $2 AND sequence = 1001`,
    [MAIN_RELAY_STREAM_SCOPE, dataEpoch]);
    await expect(relayCoverage(pool, consumer)).rejects.toBeInstanceOf(RelayCheckpointConflict);
  } finally {
    try {
      await pool.query('DELETE FROM relay.delivered_event WHERE stream_scope IN ($1, $2) AND data_epoch = $3',
        [MAIN_RELAY_STREAM_SCOPE, crossStreamScope, dataEpoch]);
      await pool.query('DELETE FROM relay.delivered_batch WHERE stream_scope IN ($1, $2) AND data_epoch = $3',
        [MAIN_RELAY_STREAM_SCOPE, crossStreamScope, dataEpoch]);
      await pool.query('DELETE FROM relay.checkpoint WHERE consumer = $1 AND stream_scope = $2',
        [consumer, MAIN_RELAY_STREAM_SCOPE]);
    } finally {
      await pool.end();
    }
  }
});
