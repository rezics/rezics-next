import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { FeedStore } from '../src/modules/feed/store.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';

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
