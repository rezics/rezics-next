import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

test('A4: a foreign stream checkpoint at the same sequence cannot advance Main notifications', async () => {
  let advanced: string | undefined;
  const readOnly = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '3', stream_scope: 'content' }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM relay.notification_producer_cursor'))
      return { rows: [{ data_epoch: 'epoch', sequence: '2' }] };
    if (sql.includes('FROM relay.delivered_batch')) {
      return sql.includes('stream_scope') ? { rows: [] }
        : { rows: [{ sequence: '3', event_count: 0, stream_scope: 'content' }] };
    }
    if (sql.includes('SET sequence =')) advanced = String(args?.[1]);
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool, {} as never, {} as never,
    'main-graph-v1', readOnly);
  const outcome = await producer.runRelayOnce().catch(() => -1);
  expect([-1, 0]).toContain(outcome);
  expect(advanced).toBeUndefined();
});

test('A4: a foreign batch at the Main sequence cannot advance its notification cursor', async () => {
  let advanced: string | undefined;
  let batchSql = '';
  const readOnly = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '3',
    stream_scope: MAIN_RELAY_STREAM_SCOPE }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM relay.notification_producer_cursor'))
      return { rows: [{ data_epoch: 'epoch', sequence: '2' }] };
    if (sql.includes('FROM relay.delivered_batch')) {
      batchSql = sql;
      return sql.includes('stream_scope') ? { rows: [] }
        : { rows: [{ sequence: '3', event_count: 0, stream_scope: 'content' }] };
    }
    if (sql.includes('SET sequence =')) advanced = String(args?.[1]);
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool, {} as never, {} as never,
    'main-graph-v1', readOnly);
  await expect(producer.runRelayOnce()).rejects.toThrow('notification Main relay batch range is incomplete');
  expect(batchSql).toContain('stream_scope');
  expect(advanced).toBeUndefined();
});

test('A4: a foreign event cannot satisfy the Main batch at the same sequence', async () => {
  let advanced: string | undefined;
  let eventSql = '';
  const readOnly = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '3',
    stream_scope: MAIN_RELAY_STREAM_SCOPE }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM relay.notification_producer_cursor'))
      return { rows: [{ data_epoch: 'epoch', sequence: '2' }] };
    if (sql.includes('FROM relay.delivered_batch')) return { rows: [{ sequence: '3', event_count: 1 }] };
    if (sql.includes('FROM relay.delivered_event')) {
      eventSql = sql;
      return sql.includes('stream_scope') ? { rows: [] } : { rows: [{ envelope: {
        id: 'foreign-event', type: 'unrecognized-v1', data: {} } }] };
    }
    if (sql.includes('SET sequence =')) advanced = String(args?.[1]);
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool, {} as never, {} as never,
    'main-graph-v1', readOnly);
  await expect(producer.runRelayOnce()).rejects.toThrow('relay batch is incomplete');
  expect(eventSql).toContain('stream_scope');
  expect(advanced).toBeUndefined();
});

test('A4: a missing Main batch still refuses cursor advancement across a relay gap', async () => {
  let advanced: string | undefined;
  const readOnly = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '4',
    stream_scope: MAIN_RELAY_STREAM_SCOPE }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM relay.notification_producer_cursor'))
      return { rows: [{ data_epoch: 'epoch', sequence: '2' }] };
    if (sql.includes('FROM relay.delivered_batch')) return { rows: [{ sequence: '4', event_count: 0 }] };
    if (sql.includes('SET sequence =')) advanced = String(args?.[1]);
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool, {} as never, {} as never,
    'main-graph-v1', readOnly);
  await expect(producer.runRelayOnce()).rejects.toThrow('notification Main relay batch range has a gap');
  expect(advanced).toBeUndefined();
});
