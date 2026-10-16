import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { publishedSerialStructure, selectedSerialFixture, serialId, serialWork } from './serial-selected-fixture.ts';

test('a private draft head cannot drop selected publication statistics or change their displayed date', async () => {
  const f = selectedSerialFixture();
  const before = (await f.projection.batch([serialWork])).get(serialWork);
  expect(before).toEqual({ chapterCount: 2, wordCount: 480, lastUpdatedAt: '2026-10-01T00:00:00.000Z' });
  f.state.draftHead = serialId(99);
  expect((await f.projection.batch([serialWork])).get(serialWork)).toEqual(before);
});

test('serial projection reads numeric batch 9 before 10 and advances its checkpoint', async () => {
  let advanced = '';
  const relay = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('max(sequence)')) {
      expect(sql).toMatch(/WHERE stream_scope\s*=\s*\$1 AND data_epoch\s*=\s*\$2/u);
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

test('selected publication materializes immutable chapters and its date, ignoring a terminal private draft command', async () => {
  const selected = await publishedSerialStructure(3);
  const { structure, head, main, publication, env } = selected;
  const state = { revision: head, writes: [] as Array<{ sql: string; args?: unknown[] }> };
  const checkpoint = { generation: 'generation', graph_epoch: 'epoch', sequence: '3' };
  const relay = { query: async (sql: string) => ({ rows: sql.includes('max(sequence)')
    ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '4' }]
    : sql.includes('FROM relay.delivered_batch') ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: 'epoch', sequence: '4', event_count: 1 }]
    : [{ envelope: { type: 'com.rezics.structure.command.v1', data: { receipt: {
      action: 'structure.command', outcome: 'succeeded', structure, revision: state.revision,
      admissionId: '00000000-0000-4000-8000-000000000001' } } } }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    state.writes.push({ sql, args });
    return { rows: sql.includes('FROM access.serial_stats_checkpoint') ? [checkpoint] : [] };
  }, release: () => {} };
  const at = new Date('2026-10-01T00:00:00Z');
  const access = { query: async (sql: string) => ({ rows: sql.includes('SELECT sealed_at') ? [{ sealed_at: at }] : [checkpoint] }),
    connect: async () => client } as unknown as Pool;
  const projection = new SerialStatisticsProjection(access, relay, {} as Pool, env);
  expect(await projection.tick()).toBe(1);
  const summary = state.writes.find(write => write.sql.includes('INSERT INTO access.serial_summary'));
  expect(summary?.args).toEqual(['generation', serialWork, structure, 3, at, main, head, publication]);
  expect(state.writes.filter(write => write.sql.includes('INSERT INTO access.serial_chapter'))).toHaveLength(3);
  const advance = state.writes.findIndex(write => write.sql.includes('SET sequence ='));
  expect(advance).toBeGreaterThan(state.writes.findIndex(write => write === summary));
  state.writes.length = 0; state.revision = serialId(99); selected.state.liveHead = state.revision;
  expect(await projection.tick()).toBe(1);
  expect(state.writes.some(write => write.sql.includes('INSERT INTO access.serial_summary'))).toBe(false);
});

test('a retained checkpoint that advances after the sampled relay head does not reset the projection generation', async () => {
  const checkpoint = { generation: 'generation', graph_epoch: 'epoch', sequence: '4' };
  const queries: string[] = [];
  const relay = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('max(sequence)')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '3' }] };
    if (sql.includes('SELECT sequence::text')) {
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch', '4']);
      return { rows: [{ sequence: '4' }] };
    }
    expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch', '4']);
    return { rows: [] };
  } } as unknown as Pool;
  const client = { query: async (sql: string) => {
    queries.push(sql); return { rows: sql.includes('FROM access.serial_stats_checkpoint') ? [checkpoint] : [] };
  }, release: () => {} };
  const access = { query: async () => ({ rows: [checkpoint] }), connect: async () => client } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch' } } as WorkActivationEnvironment;
  expect(await new SerialStatisticsProjection(access, relay, {} as Pool, env).tick()).toBe(0);
  expect(queries.some(sql => sql.includes('INSERT INTO access.serial_stats_checkpoint'))).toBe(false);
});
