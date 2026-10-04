import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { FeedTargetIndex } from '../src/modules/feed/target-index.ts';
import type { FeedCheckpoint } from '../src/modules/feed/store.ts';

test('G1043: an empty continuation seals an exactly full final target event batch', async () => {
  let position = { sequence: '20', after_event: 'last-event' };
  const writes: unknown[][] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT open FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.startsWith('SELECT sequence::text,after_event')) return { rows: [position] };
    if (sql.startsWith('UPDATE access.feed_target_checkpoint')) {
      writes.push(values);
      position = { sequence: values[1] as string, after_event: values[2] as string };
    }
    return { rows: [] };
  };
  const access = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  let seeks = 0;
  const relay = { query: async () => { seeks++; return { rows: [] }; } } as unknown as Pool;
  const worker = new FeedTargetIndex(access, relay);
  const checkpoint: FeedCheckpoint = { data_epoch: 'epoch', sequence: '20', after_id: '￿',
    revision: 'revision', rebuild_epoch: null, rebuild_after: '', review_sequence: '0' };
  const session = {} as WorkReadSession;
  expect(await worker.tick(session, checkpoint, '20')).toBe(true);
  expect(position).toEqual({ sequence: '20', after_event: '￿' });
  expect(writes).toHaveLength(1);
  expect(await worker.tick(session, checkpoint, '20')).toBe(false);
  expect(seeks).toBe(1);
});
