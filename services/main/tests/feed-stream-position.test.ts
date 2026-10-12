import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { FeedStore } from '../src/modules/feed/store.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import { feedReferences } from '../src/modules/feed/source.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const checkpoint = (sequence: string, dataEpoch = 'epoch') => ({ data_epoch: dataEpoch,
  sequence, after_id: '\uffff', revision: '4', rebuild_epoch: null, rebuild_after: '', review_sequence: '0' });

function storeAt(sequence: string, targetSequence: string, dataEpoch = 'epoch') {
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('AS checkpoint')) return { rows: [{ checkpoint: checkpoint(sequence, dataEpoch),
      target_sequence: targetSequence, target_complete: true, pending_reviews: false }] };
    return { rows: [] };
  }, release: () => {} } as unknown as PoolClient;
  return new FeedStore({ connect: async () => client } as unknown as Pool);
}

const coverage = (sequence: string, dataEpoch = 'epoch', streamScope = MAIN_RELAY_STREAM_SCOPE): RelayHandoffPosition =>
  ({ sequence, dataEpoch, streamScope });

test('A2: Feed is ready at Main stream 3 when the graph diagnostic has advanced to 100', async () => {
  const state = await storeAt('3', '3').readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3'));
  expect(state.status).toBe('ready');
  expect(state.sourcePosition).toEqual({ dataEpoch: 'epoch', sequence: '100' });
});

test('A2: Feed stays indexing while Main relay coverage is behind its delivered target', async () => {
  const state = await storeAt('2', '3').readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3'));
  expect(state.status).toBe('indexing');
});

test('A2: target projection stays indexing while it trails Main relay coverage', async () => {
  const state = await storeAt('3', '2').readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3'));
  expect(state.status).toBe('indexing');
  expect(state.targets.status).toBe('indexing');
});

test('A2: Feed refuses a checkpoint from another graph epoch', async () => {
  await expect(storeAt('3', '3', 'old-epoch').readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3')))
    .rejects.toThrow('Feed projection is recovering');
});

test('A2: Feed refuses Main relay coverage from another stream or epoch', async () => {
  const store = storeAt('3', '3');
  await expect(store.readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3', 'epoch', 'urn:other:stream')))
    .rejects.toThrow('Main feed stream position is unavailable');
  await expect(store.readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3', 'old-epoch')))
    .rejects.toThrow('Main feed stream position is unavailable');
});

test('A2: Feed refuses a projection checkpoint ahead of Main relay coverage', async () => {
  await expect(storeAt('4', '3').readiness({ dataEpoch: 'epoch', sequence: '100' }, coverage('3')))
    .rejects.toThrow('Feed exceeds relay');
});

function feedReferenceReader(graphByStream: ReadonlyMap<string, string>, mainByGraph: ReadonlyMap<string, string>,
  referenceRows: { id: string; sequence: string; kind: string }[]) {
  const graphQueries: string[] = [];
  const relay = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT batch.graph_sequence')) {
      const streamSequence = String(values[2]);
      const graphSequence = graphByStream.get(streamSequence);
      return { rows: graphSequence ? [{ graph_sequence: graphSequence, actual_count: '1',
        event_count: 1, ordinal_count: '1', envelopes_match: true }] : [] };
    }
    if (sql.includes("AS graph_sequence")) {
      const sequences = values[2] as string[];
      return { rows: sequences.flatMap(graphSequence => {
        const streamSequence = mainByGraph.get(graphSequence);
        return streamSequence ? [{ graph_sequence: graphSequence, stream_sequence: streamSequence,
          dataset_id: 'product', graph_epoch: 'epoch', relay_scope: MAIN_RELAY_STREAM_SCOPE,
          relay_epoch: 'epoch', envelope_stream_sequence: streamSequence }] : [];
      }) };
    }
    throw new Error(`Unexpected relay query: ${sql}`);
  } } as unknown as Pick<Pool, 'query'>;
  const session = { position: { dataEpoch: 'epoch', sequence: '200' }, query: async (sql: string) => {
    graphQueries.push(sql);
    if (sql.includes('SELECT DISTINCT ?sequence')) {
      return [{ sequence: { value: '100' } }];
    }
    return referenceRows.map(row => ({ id: { value: row.id }, sequence: { value: row.sequence }, kind: { value: row.kind } }));
  } } as unknown as WorkReadSession;
  return { relay, session, graphQueries };
}

test('A2: feed reference cuts translate Main stream 3 to graph sequence 100 and keep item sequence in Main', async () => {
  const { relay, session, graphQueries } = feedReferenceReader(new Map([['3', '100']]), new Map([['100', '3']]),
    [{ id: 'https://rezics.com/id/ref-100', sequence: '100', kind: 'work' }]);
  const rows = await feedReferences(session, relay, { after: coverage('0'), through: coverage('3'), afterId: '' });
  expect(rows).toEqual([{ id: 'https://rezics.com/id/ref-100', sequence: '3', kind: 'work' }]);
  expect(graphQueries[0]).toContain('FILTER(?sequence <= 100)');
  expect(graphQueries[0]).not.toContain('FILTER(?sequence <= 3)');
});

test('A2: a partial feed reference cursor resumes in graph sequence while checkpoint remains Main sequence', async () => {
  const { relay, session, graphQueries } = feedReferenceReader(new Map([['3', '100'], ['4', '101']]),
    new Map([['101', '4']]), [{ id: 'https://rezics.com/id/ref-101', sequence: '101', kind: 'work' }]);
  const rows = await feedReferences(session, relay, { after: coverage('3'), through: coverage('4'),
    afterId: 'https://rezics.com/id/ref-100' });
  expect(rows).toEqual([{ id: 'https://rezics.com/id/ref-101', sequence: '4', kind: 'work' }]);
  expect(graphQueries[1]).toContain('FILTER(?sequence <= 101)');
  expect(graphQueries[1]).toContain('FILTER(?sequence > 100');
});

test('A2: feed reference cuts reject foreign Main streams and graph refs without a relay binding', async () => {
  const source = feedReferenceReader(new Map([['3', '100']]), new Map(),
    [{ id: 'https://rezics.com/id/ref-100', sequence: '100', kind: 'work' }]);
  await expect(feedReferences(source.session, source.relay, { after: coverage('0'),
    through: coverage('3', 'epoch', 'urn:other:stream'), afterId: '' })).rejects.toThrow('Main feed stream position is unavailable');
  const missing = feedReferenceReader(new Map([['3', '100']]), new Map(),
    [{ id: 'https://rezics.com/id/ref-100', sequence: '100', kind: 'work' }]);
  await expect(feedReferences(missing.session, missing.relay, { after: coverage('0'), through: coverage('3'), afterId: '' }))
    .rejects.toThrow('Feed reference relay position is unavailable');
});
