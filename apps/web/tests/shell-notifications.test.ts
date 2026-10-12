import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/feed/types.ts';
import { readWindow } from '../features/shell/notifications/window.ts';
import { unreadBadge } from '../features/shell/unread.ts';

function stream(head: number) {
  const calls: { before?: string; limit: number }[] = [];
  const cursors = new Map<string, number>();
  const main = { v1: { me: { notifications: { get: async ({ query }: { query: { before?: string; limit: number } }) => {
    calls.push(query);
    const before = query.before && query.before !== 'latest' ? cursors.get(query.before)! : head + 1;
    const items = Array.from({ length: Math.min(query.limit, before - 1) }, (_, index) => ({
      id: String(before - index - 1), sequence: String(before - index - 1) }));
    const next = before - items.length > 1 ? `opaque-page-${items.at(-1)!.sequence}` : null;
    if (next) cursors.set(next, Number(items.at(-1)!.sequence));
    return { data: { generation: '3', head: String(head), reset: false, readThrough: '0', items, groups: [],
      next }, error: null };
  } } } } } as unknown as MainClient;
  return { main, calls };
}

describe('notification windows', () => {
  test('a bounded page is shown newest first and carries the API continuation', async () => {
    const { main, calls } = stream(130);
    const window = await readWindow(main, null);
    expect(calls).toEqual([{ before: 'latest', limit: 50 }]);
    expect(window.ok && window.data.items.map(item => item.sequence).slice(0, 2)).toEqual(['130', '129']);
    expect(window.ok && window.data.next).toBe('opaque-page-81');
    if (!window.ok) throw new Error('Expected newest page');
    const older = await readWindow(main, window.data.next);
    expect(older.ok && older.data.items[0]?.sequence).toBe('80');
    if (!older.ok) throw new Error('Expected older page');
    const last = await readWindow(main, older.data.next);
    expect(last).toMatchObject({ ok: true, data: { next: null } });
    if (!last.ok) throw new Error('Expected final page');
    expect(last.data.items).toHaveLength(30);
    expect([...window.data.items, ...older.data.items, ...last.data.items].map(item => item.sequence))
      .toEqual(Array.from({ length: 130 }, (_, index) => String(130 - index)));
  });

  test('short and empty streams end according to Main', async () => {
    const { main, calls } = stream(30);
    const window = await readWindow(main, null);
    expect(calls).toEqual([{ before: 'latest', limit: 50 }]);
    expect(window.ok && window.data.next).toBeNull();
    const empty = stream(0);
    expect(await readWindow(empty.main, null)).toMatchObject({ ok: true, data: { items: [], next: null } });
    expect(empty.calls).toEqual([{ before: 'latest', limit: 50 }]);
  });

  test('the badge counts exactly through 99, as Main does', () => {
    expect(unreadBadge({ count: 7, overflow: false })).toBe('7');
    expect(unreadBadge({ count: 99, overflow: false })).toBe('99');
    expect(unreadBadge({ count: 100, overflow: true })).toBe('99+');
  });
});
