import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';

test('notification producer reads relay checkpoint through a read-only pool and writes cursor through a writable pool', async () => {
  const statements: string[] = [];
  const readOnly = { query: async (sql: string) => {
    statements.push(`read:${sql}`);
    return { rows: [{ data_epoch: 'epoch', sequence: '0' }] };
  }, connect: async () => { throw new Error('read-only pool cannot open a writer'); } } as unknown as Pool;
  const client = { query: async (sql: string) => {
    statements.push(`write:${sql}`);
    if (sql.includes('FROM relay.notification_producer_cursor')) return { rows: [{ data_epoch: 'epoch', sequence: '0' }] };
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool,
    {} as never, {} as never, 'main-graph-v1', readOnly);
  expect(await producer.runRelayOnce()).toBe(0);
  expect(statements.some(sql => sql.startsWith('read:') && sql.includes('FROM relay.checkpoint'))).toBe(true);
  expect(statements.some(sql => sql.startsWith('write:') && sql.includes('INSERT INTO relay.notification_producer_cursor'))).toBe(true);
});

test('notification producer advances numerically from relay batch 9 to 10', async () => {
  let advanced = '';
  const readOnly = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '10' }] }) } as unknown as Pool;
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM relay.notification_producer_cursor')) return { rows: [{ data_epoch: 'epoch', sequence: '8' }] };
    if (sql.includes('FROM relay.delivered_batch')) return { rows: [{ sequence:
      sql.includes('ORDER BY batch.sequence') ? '9' : '10', event_count: 0 }] };
    if (sql.includes('FROM relay.delivered_event')) return { rows: [] };
    if (sql.includes('SET sequence =')) advanced = String(args?.[1]);
    return { rows: [] };
  }, release: () => {} };
  const writable = { connect: async () => client } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, writable, {} as Pool,
    {} as never, {} as never, 'main-graph-v1', readOnly);
  expect(await producer.runRelayOnce()).toBe(0);
  expect(advanced).toBe('9');
});

test('notification producer emits a submission decision to its represented recipient', async () => {
  const recipient = '00000000-0000-4000-8000-000000000001';
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const reviewer = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const emitted: unknown[] = [];
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM access.notification_producer_cursor')) return { rows: [{ position: '0' }] };
    if (sql.includes('FROM access.notification_producer_event')) return { rows: [{
      position: '1', kind: 'submission_decision', event_id: 'decision' }] };
    return { rows: [] };
  }, release: () => {} };
  const access = { connect: async () => client, query: async (sql: string) => {
    if (sql.includes('FROM access.realm_submission_revision')) return { rows: [{
      id: 'submission', realm: agent, work: agent, submitting_agent: agent,
      reviewer, state: 'accepted', actor: recipient }] };
    if (sql.includes('FROM access.representation')) return { rows: [{ id: recipient }] };
    throw new Error(`unexpected Access query: ${sql}`);
  } } as unknown as Pool;
  const producer = new NotificationProducer(access, null, {} as Pool, {} as never,
    { enqueue: async (event: NotificationEvent) => { emitted.push(event); return []; } } as never, null);
  expect(await producer.runAccessOnce()).toBe(1);
  expect(emitted).toMatchObject([{ topic: 'submission-decision', recipients: [recipient] }]);
});
