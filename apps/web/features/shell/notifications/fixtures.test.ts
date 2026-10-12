import { expect, test } from 'bun:test';
import { governance, memoryInbox } from './fixtures.ts';

test('watermark fixtures reject a stale generation without changing unread count', async () => {
  const { main, calls } = memoryInbox([governance(1, 'proposal-revised', 'manual')], { generation: '2' });
  const stale = await main.v1.me['notification-read-watermarks'].inbox.put({
    profile: 'notification-read-watermark-v1', generation: '1', readThrough: '1' });
  expect(stale.error?.status).toBe(409);
  expect((await main.v1.me.notifications['unread-count'].get()).data?.count).toBe(1);
  const current = await main.v1.me['notification-read-watermarks'].inbox.put({
    profile: 'notification-read-watermark-v1', generation: '2', readThrough: '1' });
  expect(current.error).toBeNull();
  expect((await main.v1.me.notifications['unread-count'].get()).data?.count).toBe(0);
  expect(calls).toContain('read-through:2:1');
});
