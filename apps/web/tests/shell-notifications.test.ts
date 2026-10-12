import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/feed/types.ts';
import { readWindow } from '../features/shell/notifications/window.ts';
import { unreadBadge } from '../features/shell/unread.ts';

function stream(head: number) {
  const calls: { after?: string; limit: number }[] = [];
  const main = { v1: { me: { notifications: { get: async ({ query }: { query: { after?: string; limit: number } }) => {
    calls.push(query);
    const start = Number(query.after?.split(':')[1] ?? '0');
    const items = Array.from({ length: Math.min(query.limit, head - start) }, (_, index) => ({
      id: String(start + index + 1), sequence: String(start + index + 1) }));
    return { data: { generation: '3', head: String(head), reset: false, readThrough: '0', items, groups: [],
      next: start + items.length < head ? `3:${items.at(-1)!.sequence}` : null }, error: null };
  } } } } } as unknown as MainClient;
  return { main, calls };
}

describe('notification windows', () => {
  test('a bounded page is shown newest first and carries the API continuation', async () => {
    const { main, calls } = stream(130);
    const window = await readWindow(main, null);
    expect(calls).toEqual([{ limit: 50 }]);
    expect(window.ok && window.data.items.map(item => item.sequence).slice(0, 2)).toEqual(['50', '49']);
    expect(window.ok && window.data.next).toBe('3:50');
  });

  test('short and empty streams end according to Main', async () => {
    const { main, calls } = stream(30);
    const window = await readWindow(main, null);
    expect(calls).toEqual([{ limit: 50 }]);
    expect(window.ok && window.data.next).toBeNull();
    const empty = stream(0);
    expect(await readWindow(empty.main, null)).toMatchObject({ ok: true, data: { items: [], next: null } });
    expect(empty.calls).toEqual([{ limit: 50 }]);
  });

  test('the badge counts exactly through 99, as Main does', () => {
    expect(unreadBadge({ count: 7, overflow: false })).toBe('7');
    expect(unreadBadge({ count: 99, overflow: false })).toBe('99');
    expect(unreadBadge({ count: 100, overflow: true })).toBe('99+');
  });
});
