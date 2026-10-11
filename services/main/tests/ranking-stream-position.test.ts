import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { RecommendationStale } from '../src/modules/recommendation/derived-generation.ts';
import { RankingGenerations } from '../src/modules/recommendation/ranking.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

test('A7: a foreign stream batch at Main sequence 1 does not advance a ranking generation', async () => {
  let batchQuery = '';
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('UPDATE access.derived_generation_input'))
      return { rows: [{ complete: false }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release: () => {} } as unknown as PoolClient;
  const access = { query: async () => ({ rows: [{ population: 'public', partition_count: 1,
    data_epoch: 'epoch', checkpoint: '0', target: '2', zero_snapshot: null }] }),
    connect: async () => client } as unknown as Pool;
  const relay = { query: async (sql: string) => {
    if (sql.includes('FROM relay.delivered_batch')) {
      batchQuery = sql;
      return sql.includes('stream_scope') ? { rows: [] }
        : { rows: [{ sequence: '1', event_count: 0, stream_scope: 'content' }] };
    }
    if (sql.includes('FROM relay.delivered_event')) return { rows: [] };
    return { rows: [] };
  } } as unknown as Pool;
  const rankings = new RankingGenerations({ access, relay, dataEpoch: 'epoch', cursorKey: new Uint8Array(32),
    canReadWork: async () => true });
  const result = await rankings.runBatch('generation', '1');
  expect(result).toMatchObject({ relayBatches: 0, checkpoint: '0', snapshotComplete: false });
  expect(batchQuery).toContain('stream_scope');
});

test('A7: ranking inputs refuse a foreign stream or source epoch', async () => {
  for (const input of [
    { data_epoch: 'epoch', manifest_data_epoch: 'epoch', stream_scope: 'urn:rezics:stream:content' },
    { data_epoch: 'other-epoch', manifest_data_epoch: 'other-epoch', stream_scope: MAIN_RELAY_STREAM_SCOPE },
    { data_epoch: 'epoch', manifest_data_epoch: 'other-epoch', stream_scope: MAIN_RELAY_STREAM_SCOPE },
  ]) {
    const access = { query: async () => ({ rows: [{ population: 'public', partition_count: 1,
      checkpoint: '0', target: '1', zero_snapshot: null, ...input }] }) } as unknown as Pool;
    const relay = { query: async () => { throw new Error('foreign input must be rejected before relay access'); } } as unknown as Pool;
    const rankings = new RankingGenerations({ access, relay, dataEpoch: 'epoch', cursorKey: new Uint8Array(32),
      canReadWork: async () => true });
    await expect(rankings.runBatch('generation', '1')).rejects.toBeInstanceOf(RecommendationStale);
  }
});

test('A7: a missing Main stream batch remains a source gap', async () => {
  const failures: string[] = [];
  const client = { query: async () => ({ rows: [], rowCount: 1 }), release: () => {} } as unknown as PoolClient;
  const access = { query: async () => ({ rows: [{ population: 'public', partition_count: 1,
    data_epoch: 'epoch', checkpoint: '0', target: '2', zero_snapshot: null, stream_scope: MAIN_RELAY_STREAM_SCOPE }] }),
    connect: async () => client } as unknown as Pool;
  const relay = { query: async (sql: string) => sql.includes('max(sequence)')
    ? { rows: [{ sequence: '2' }] } : sql.includes('FROM relay.delivered_batch')
      ? { rows: [{ sequence: '2', event_count: 0 }] } : { rows: [] } } as unknown as Pool;
  const rankings = new RankingGenerations({ access, relay, dataEpoch: 'epoch', cursorKey: new Uint8Array(32),
    canReadWork: async () => true });
  rankings.fail = async (_generation, _lease, reason) => { failures.push(reason); };
  expect(await rankings.runBatch('generation', '1')).toMatchObject({ failed: 'source-gap', checkpoint: '0' });
  expect(failures).toEqual(['source-gap at 1']);
});

test('A7: public ranking health reports the graph snapshot without comparing relay sequence numbers', async () => {
  const client = { query: async (sql: string) => sql.includes('recovery_fence')
    ? { rows: [{ open: true }] } : { rows: [{ generation: 'generation', data_epoch: 'epoch', checkpoint: '90',
      stream_scope: MAIN_RELAY_STREAM_SCOPE, zero_snapshot: '2', erasure_epoch: '0' }] }, release: () => {} };
  const access = { connect: async () => client } as unknown as Pool;
  const relay = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const rankings = new RankingGenerations({ access, relay, dataEpoch: 'epoch', cursorKey: new Uint8Array(32),
    canReadWork: async () => true });
  await expect(rankings.publicRankingStatus()).resolves.toMatchObject({ dataEpoch: 'epoch', sequence: '2' });
});
