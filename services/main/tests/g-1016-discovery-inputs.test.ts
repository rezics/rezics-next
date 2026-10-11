import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { DiscoveryRefreshInputs, discoveryAppendOnly } from '../src/modules/discovery/source.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const position = { dataEpoch: 'epoch', sequence: '12' };
const streamCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '12' };
const afterGraph = { dataEpoch: 'epoch', sequence: '10' };
const event = (sequence: number, action = 'work.create') => ({
  stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: String(sequence),
  batch_id: `batch-${sequence}`, routing_epoch: 'routing', event_count: 1, event_id: `event-${sequence}`, envelope: {
    specversion: '1.0', id: `event-${sequence}`, source: 'https://rezics.com/services/main',
    data: { batchId: `batch-${sequence}`, routingEpoch: 'routing', ordinal: 0,
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: String(sequence) },
      receipt: { action, work, outcome: 'succeeded' } },
  } });
function reader(rows: ReturnType<typeof event>[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    const requestedCoverage = String(values[3]);
    if (requestedCoverage !== streamCoverage.sequence) return { rows: [] };
    const afterGraphSequence = String(values[4]);
    const afterSequence = BigInt(afterGraphSequence) < BigInt(requestedCoverage)
      ? afterGraphSequence
      : requestedCoverage;
    const coverage = {
      after_sequence: afterSequence,
      coverage_stream_scope: MAIN_RELAY_STREAM_SCOPE,
      coverage_data_epoch: 'epoch',
      coverage_sequence: requestedCoverage,
    };
    const interval = rows.filter(row => BigInt(row.sequence) > BigInt(afterSequence) &&
      BigInt(row.sequence) <= BigInt(requestedCoverage));
    return { rows: interval.length
      ? interval.map(row => ({ ...coverage, ...row }))
      : [{ ...coverage, stream_scope: null, data_epoch: null, sequence: null, batch_id: null,
        routing_epoch: null, event_count: null, event_id: null, envelope: null }] };
  } } as unknown as Pool;
  return { inputs: new DiscoveryRefreshInputs(pool, 'consumer'), queries };
}

test('G1016: retained Discovery inputs read only the bounded new interval and verify complete coverage', async () => {
  const f = reader([event(11), event(12, 'publication.select')]);
  expect(await f.inputs.read(streamCoverage, afterGraph)).toEqual({ works: [work], created: [work] });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]!.values).toEqual(['consumer', MAIN_RELAY_STREAM_SCOPE, 'epoch', '12', '10', 2001]);
  expect(f.queries[0]!.sql).toContain('b.sequence > coverage.after_sequence::numeric');
  expect(f.queries[0]!.sql).toContain('c.sequence >= $4::numeric');
  expect(await f.inputs.read(streamCoverage, position)).toEqual({ works: [], created: [] });
  expect(await f.inputs.read({ ...streamCoverage, sequence: '1011' }, afterGraph)).toBeNull();
  expect(await f.inputs.read(streamCoverage, { ...afterGraph, sequence: '13' })).toEqual({ works: [], created: [] });
  expect(f.queries).toHaveLength(4);
});

test('G1016: a missing, malformed, duplicate or unknown retained event cannot admit checkpoint reuse', async () => {
  for (const rows of [[event(11)], [event(11), event(12, 'future.unclassified')],
    [event(11), event(12), event(12)]]) expect(await reader(rows).inputs.read(streamCoverage, afterGraph)).toBeNull();
  const bad = event(12);
  bad.envelope.data.ordinal = 1;
  expect(await reader([event(11), bad]).inputs.read(streamCoverage, afterGraph)).toBeNull();
  const wrongEpoch = event(12);
  wrongEpoch.envelope.data.sourcePosition.dataEpoch = 'other';
  expect(await reader([event(11), wrongEpoch]).inputs.read(streamCoverage, afterGraph)).toBeNull();
  const dense = Array.from({ length: 2001 }, () => event(11));
  expect(await reader(dense).inputs.read(streamCoverage, afterGraph)).toBeNull();
  const cancelled = event(11);
  cancelled.envelope.data.receipt.outcome = 'cancelled';
  expect(await reader([cancelled, event(12, 'work.edit')]).inputs.read(streamCoverage, afterGraph))
    .toEqual({ works: [work], created: [] });
});

test('G1016: an appended Work may change across later validation intervals, but an original Work may not', async () => {
  const queries: string[] = [];
  let bornAfter = true;
  const session = { position, query: async (sql: string) => {
    queries.push(sql);
    return bornAfter ? [{ work: { value: work } }] : [];
  } } as unknown as WorkReadSession;
  expect(await discoveryAppendOnly(session, { works: [work], created: [work] }, '10')).toBe(true);
  expect(queries).toHaveLength(0);
  expect(await discoveryAppendOnly(session, { works: [work], created: [] }, '10')).toBe(true);
  expect(queries[0]).toContain('FILTER(?born > 10)');
  expect(queries[0]).toContain('FILTER NOT EXISTS { ?birth rv:predecessor ?previous }');
  bornAfter = false;
  expect(await discoveryAppendOnly(session, { works: [work], created: [] }, '10')).toBe(false);
});
