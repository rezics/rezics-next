import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { relayCoverage, RelayCheckpointConflict, RelayHandoffIncomplete,
  verifiedRetainedRelayRange } from '../src/modules/outbox/relay.ts';

function fixture() {
  const state = { acknowledged: '1', headers: ['1', '2'], events: ['1'] };
  const envelope = (sequence: string) => ({ specversion: '1.0', id: `event-${sequence}`,
    source: 'https://rezics.com/services/main', type: 'com.rezics.work.created.v1',
    data: { batchId: `batch-${sequence}`, routingEpoch: 'routing', ordinal: 0,
      sourcePosition: { dataEpoch: 'epoch', sequence },
      relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence } } });
  const queries: string[] = [];
  let snapshot: typeof state;
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (sql.startsWith('BEGIN')) { snapshot = structuredClone(state); return { rows: [] }; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: 'epoch', sequence: snapshot.acknowledged }] };
    if (sql.includes('SELECT 1 FROM relay.delivered_event')) {
      const tail = [...snapshot.headers, ...snapshot.events].some(sequence => BigInt(sequence) > BigInt(String(values[1])));
      return { rows: tail ? [{}] : [], rowCount: tail ? 1 : 0 };
    }
    if (sql.includes('AS actual_count')) {
      return { rows: snapshot.headers.filter(sequence => BigInt(sequence) > BigInt(String(values[1]))
        && BigInt(sequence) <= BigInt(String(values[2]))).map(sequence => ({ sequence,
        batch_id: `batch-${sequence}`, routing_epoch: 'routing', event_count: 1,
        actual_count: snapshot.events.includes(sequence) ? '1' : '0' })) };
    }
    if (sql.includes('event.envelope::text AS body')) {
      return { rows: snapshot.events.filter(sequence => BigInt(sequence) <= BigInt(String(values[1])))
        .map(sequence => ({ sequence, source: 'https://rezics.com/services/main',
          event_id: `event-${sequence}`, body: JSON.stringify(envelope(sequence)) })) };
    }
    if (sql.includes('FROM relay.delivered_batch AS batch')) {
      expect(sql).toContain('batch.sequence <= $3');
      expect(values[0]).toBe('epoch');
      expect(values.slice(2)).toEqual([snapshot.acknowledged, 100]);
      return { rows: snapshot.headers.filter(sequence => BigInt(sequence) > BigInt(String(values[1]))
        && BigInt(sequence) <= BigInt(snapshot.acknowledged))
        .map(sequence => ({ sequence, batch_id: `batch-${sequence}`, routing_epoch: 'routing', event_count: 1 })) };
    }
    if (sql.includes('SELECT envelope FROM relay.delivered_event')) {
      return { rows: snapshot.events.filter(sequence => sequence === values[1]).map(sequence => ({ envelope: envelope(sequence) })) };
    }
    throw new Error(`unexpected live range query: ${sql}`);
  };
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { pool, state, queries };
}

test('live recovery verifies only the acknowledged prefix while offline capture refuses a delivery tail', async () => {
  const f = fixture();
  f.state.headers.push('3');
  f.state.events.push('3');
  const page = await verifiedRetainedRelayRange(f.pool, 'relay', '0');
  expect(page.coverage.sequence).toBe('1');
  expect(page.coverage.batchCount).toBe('1');
  expect(page.coverage.eventCount).toBe('1');
  expect(page.batches.map(batch => batch.sequence)).toEqual(['1']);
  await expect(relayCoverage(f.pool, 'relay')).rejects.toBeInstanceOf(RelayCheckpointConflict);
});

test('missing acknowledged headers and events return a typed incomplete handoff', async () => {
  for (const missing of ['header', 'event']) {
    const f = fixture();
    f.state.acknowledged = '2';
    if (missing === 'header') f.state.headers = ['1'];
    await expect(verifiedRetainedRelayRange(f.pool, 'relay', '0'))
      .rejects.toMatchObject({ name: 'RelayHandoffIncomplete', dataEpoch: 'epoch', sequence: '2' });
    expect(f.queries.at(-1)).toBe('ROLLBACK');
  }
});

test('a restored downstream cursor ahead of delivery waits for the relay acknowledgement', async () => {
  const f = fixture();
  await expect(verifiedRetainedRelayRange(f.pool, 'relay', '2'))
    .rejects.toMatchObject({ name: 'RelayHandoffIncomplete', dataEpoch: 'epoch', sequence: '2' });
  expect(f.queries.at(-1)).toBe('ROLLBACK');
  f.state.acknowledged = '2';
  f.state.events.push('2');
  const caughtUp = await verifiedRetainedRelayRange(f.pool, 'relay', '2');
  expect(caughtUp.coverage.sequence).toBe('2');
  expect(caughtUp.batches).toEqual([]);
});

test('the live Content loop counts incomplete restored coverage as deferred and resumes without a worker fault', async () => {
  const f = fixture();
  f.state.acknowledged = '2';
  const completed = Promise.withResolvers<void>();
  const faults: unknown[] = [], lines: string[] = [];
  const warn = spyOn(console, 'warn').mockImplementation(line => { lines.push(String(line)); });
  let polls = 0;
  const worker = new ContentProjectionWorker(async () => {
    if (++polls === 3) f.state.events.push('2');
    const page = await verifiedRetainedRelayRange(f.pool, 'relay', '0');
    expect(page.batches.map(batch => batch.sequence)).toEqual(['1', '2']);
    completed.resolve();
    return null;
  }, 100, error => { faults.push(error); });
  const timer = setTimeout(() => completed.reject(new Error('Content retry did not resume')), 2000);
  try {
    worker.start();
    await completed.promise;
    await worker.stop();
    expect(polls).toBe(3);
    expect(faults).toEqual([]);
    expect(lines.map(line => JSON.parse(line))).toEqual([1, 2].map(() => expect.objectContaining({
      event: 'worker_run_deferred', 'error.code': 'main_relay_handoff_incomplete',
      'rezics.relay.requested_sequence': '2', 'rezics.projection.retry_ms': 100,
    })));
  } finally { clearTimeout(timer); await worker.stop(); warn.mockRestore(); }
  expect(new RelayHandoffIncomplete('epoch', '2')).not.toBeInstanceOf(RelayCheckpointConflict);
});
