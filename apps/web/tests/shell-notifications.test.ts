import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/feed/types.ts';
import { readWindow } from '../features/shell/notifications/window.ts';
import { unreadBadge } from '../features/shell/unread.ts';

function stream(head: number) {
  const calls: { after: string; limit: number }[] = [];
  const main = { v1: { me: { notifications: { get: async ({ query }: { query: { after: string; limit: number } }) => {
    calls.push(query);
    const start = Number(query.after.split(':')[1]);
    const items = Array.from({ length: Math.min(query.limit, head - start) }, (_, index) => ({
      id: String(start + index + 1), sequence: String(start + index + 1) }));
    return { data: { generation: '3', readThrough: '0', items, groups: [] }, error: null };
  } } } } } as unknown as MainClient;
  return { main, calls };
}

describe('notification windows', () => {
  test('the newest window ends at the head and is shown newest first', async () => {
    const { main, calls } = stream(130);
    const window = await readWindow(main, '3', '130');
    expect(calls).toEqual([{ after: '3:80', limit: 50 }]);
    expect(window.ok && window.data.items.map(item => item.sequence).slice(0, 2)).toEqual(['130', '129']);
    expect(window.ok && window.data.from).toBe('80');
  });

  test('the oldest window starts at the beginning, and an empty stream reads nothing', async () => {
    const { main, calls } = stream(30);
    const window = await readWindow(main, '3', '30');
    expect(calls).toEqual([{ after: '3:0', limit: 30 }]);
    expect(window.ok && window.data.from).toBe('0');
    const empty = stream(0);
    expect(await readWindow(empty.main, '3', '0')).toMatchObject({ ok: true, data: { items: [], from: '0' } });
    expect(empty.calls).toEqual([]);
  });

  test('the badge counts exactly through 99, as Main does', () => {
    expect(unreadBadge({ count: 7, overflow: false })).toBe('7');
    expect(unreadBadge({ count: 99, overflow: false })).toBe('99');
    expect(unreadBadge({ count: 100, overflow: true })).toBe('99+');
  });
});
