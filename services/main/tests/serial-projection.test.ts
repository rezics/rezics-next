import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

test('serial projection reads numeric batch 9 before 10 and advances its checkpoint', async () => {
  let advanced = '';
  const relay = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('max(sequence)')) {
      expect(sql).toContain('stream_scope = $1');
      expect(sql).toContain('data_epoch = $2');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '10' }] };
    }
    if (sql.includes('FROM relay.delivered_batch')) {
      expect(sql).toContain('batch.stream_scope = $1');
      expect(sql).toContain('batch.data_epoch = $2');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch', '8']);
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '9', event_count: 0 }] };
    }
    if (sql.includes('FROM relay.delivered_event')) {
      expect(sql).toContain('stream_scope = $1');
      expect(sql).toContain('data_epoch = $3');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'https://rezics.com/services/main', 'epoch', '9']);
      return { rows: [] };
    }
    throw new Error(`unexpected relay query: ${sql}`);
  } } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.serial_stats_checkpoint')) return { rows: [{
      generation: 'generation', graph_epoch: 'epoch', sequence: '8' }] };
    if (sql.includes('SET sequence =')) advanced = String(args?.[0]);
    return { rows: [] };
  }, release: () => {} };
  const access = { query: async () => ({ rows: [{ generation: 'generation', graph_epoch: 'epoch', sequence: '8' }] }),
    connect: async () => client } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch' } } as WorkActivationEnvironment;
  const projection = new SerialStatisticsProjection(access, relay, {} as Pool, env);
  expect(await projection.tick()).toBe(1);
  expect(advanced).toBe('9');
});

test('serial projection restarts at batch 1 after a data epoch change', async () => {
  let reset = false, advanced = '';
  const relay = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('max(sequence)')) {
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'new-epoch']);
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'new-epoch', sequence: '2' }] };
    }
    if (sql.includes('FROM relay.delivered_batch')) {
      expect(sql).toContain('batch.stream_scope = $1');
      expect(sql).toContain('batch.data_epoch = $2');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'new-epoch', '0']);
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'new-epoch', sequence: '1', event_count: 0 }] };
    }
    if (sql.includes('FROM relay.delivered_event')) {
      expect(sql).toContain('stream_scope = $1');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'https://rezics.com/services/main', 'new-epoch', '1']);
      return { rows: [] };
    }
    throw new Error(`unexpected relay query: ${sql}`);
  } } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.serial_stats_checkpoint')) return { rows: [{
      generation: 'old-generation', graph_epoch: 'old-epoch', sequence: '800' }] };
    if (sql.includes('INSERT INTO access.serial_stats_checkpoint')) reset = true;
    if (sql.includes('SET sequence =')) advanced = String(args?.[0]);
    return { rows: [] };
  }, release: () => {} };
  const access = { query: async () => ({ rows: [{ generation: 'old-generation',
    graph_epoch: 'old-epoch', sequence: '800' }] }), connect: async () => client } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'new-epoch' } } as WorkActivationEnvironment;
  expect(await new SerialStatisticsProjection(access, relay, {} as Pool, env).tick()).toBe(1);
  expect(reset).toBe(true);
  expect(advanced).toBe('1');
});
