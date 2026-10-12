import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { selectedSerialFixture } from './serial-selected-fixture.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const env = { lineage: { dataEpoch: 'epoch' } } as WorkActivationEnvironment;

test('serial coverage rejects the legacy sequence-only relay fixture before reading statistics', async () => {
  let accessed = false;
  const access = { query: async () => { accessed = true; return { rows: [] }; } } as unknown as Pool;
  const relay = { query: async () => ({ rows: [{ sequence: '0' }] }) } as unknown as Pool;
  const projection = new SerialStatisticsProjection(access, relay, {} as Pool, env);
  await expect(projection.batch([work])).rejects.toThrow('Main relay coverage has a foreign stream position');
  expect(accessed).toBe(false);
});

function retainedProjection(options: { missingEvent?: boolean; missingBatch?: boolean } = {}) {
  const headers = [
    { stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '1',
      graph_sequence: '41', event_count: 1, batch_id: 'event-batch', routing_epoch: 'routing' },
    { stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '2',
      graph_sequence: '77', event_count: 0, batch_id: 'empty-batch', routing_epoch: 'routing' },
  ];
  const event = { envelope: {
    type: 'com.rezics.work.activated.v1',
    data: { batchId: 'event-batch', routingEpoch: 'routing', ordinal: 0,
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '41' },
      relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '1' } },
  } };
  let sequence = '0', commits = 0;
  const checkpoint = () => ({ generation: 'generation', graph_epoch: 'epoch', sequence });
  const relay = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('max(sequence)')) {
      expect(sql).toContain('FROM relay.delivered_batch');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return { rows: [headers[1]] };
    }
    if (sql.includes('SELECT graph_sequence::text')) {
      return { rows: headers.filter(header => header.sequence === args?.[2]) };
    }
    if (sql.includes('FROM relay.delivered_batch')) {
      expect(sql).toContain('ORDER BY batch.sequence LIMIT 1');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch', sequence]);
      return { rows: headers.filter(header => BigInt(header.sequence) > BigInt(sequence)
        && (!options.missingBatch || header.sequence !== '1')).slice(0, 1) };
    }
    if (sql.includes('FROM relay.delivered_event')) {
      expect(args?.slice(0, 3)).toEqual([MAIN_RELAY_STREAM_SCOPE, 'https://rezics.com/services/main', 'epoch']);
      return { rows: args?.[3] === '1' && !options.missingEvent ? [event] : [] };
    }
    throw new Error(`Unexpected relay query: ${sql}`);
  } } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.serial_stats_checkpoint')) return { rows: [checkpoint()] };
    if (sql.includes('SET sequence =')) sequence = String(args?.[0]);
    if (sql === 'COMMIT') commits++;
    return { rows: [] };
  }, release: () => {} };
  const f = selectedSerialFixture();
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.serial_chapter')) return f.access.query(sql);
    if (!sql.includes('LEFT JOIN access.serial_summary')) return { rows: [checkpoint()] };
    f.state.projected = sequence !== '0'; f.state.checkpoint = sequence;
    return f.access.query(sql);
  }, connect: async () => client } as unknown as Pool;
  return { projection: new SerialStatisticsProjection(access, relay, {} as Pool, f.env),
    sequence: () => sequence, commits: () => commits };
}

test('serial coverage advances through an empty header after an event batch with independent graph cuts', async () => {
  const fixture = retainedProjection();
  expect((await fixture.projection.batch([work], '77')).size).toBe(0);
  expect(await fixture.projection.tick()).toBe(1);
  expect(fixture.sequence()).toBe('1');
  expect((await fixture.projection.batch([work], '77')).get(work)).toEqual({
    chapterCount: 2, wordCount: 480, lastUpdatedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(await fixture.projection.tick()).toBe(1);
  expect(fixture.sequence()).toBe('2');
  expect((await fixture.projection.batch([work], '77')).get(work)).toEqual({
    chapterCount: 2, wordCount: 480, lastUpdatedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(await fixture.projection.tick()).toBe(0);
});

test('serial coverage refuses an incomplete event batch without advancing the checkpoint', async () => {
  const fixture = retainedProjection({ missingEvent: true });
  await expect(fixture.projection.tick()).rejects.toThrow('Graph relay batch is incomplete');
  expect(fixture.sequence()).toBe('0');
  expect(fixture.commits()).toBe(0);
});

test('serial coverage refuses a missing event batch before the empty header', async () => {
  const fixture = retainedProjection({ missingBatch: true });
  await expect(fixture.projection.tick()).rejects.toThrow('Graph relay has a source gap');
  expect(fixture.sequence()).toBe('0');
  expect(fixture.commits()).toBe(0);
});
