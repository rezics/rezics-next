import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../../feed/types.ts';
import { readLatest, readWindow, type NotificationSelection, type StreamItem } from './window.ts';

type Query = { after?: string; limit: number; view?: 'saved' | 'done'; reason?: string };

function sparseStream(selection: NotificationSelection, count = 123) {
  const matches = Array.from({ length: count }, (_, index) => ({
    id: `notice-${index}`, sequence: String((index + 1) * 137),
    saved: selection.view === 'saved', done: selection.view === 'done', reason: selection.reason,
  } as StreamItem));
  const calls: Query[] = [];
  const main = { v1: { me: { notifications: {
    hint: { get: async () => ({ data: { generation: '7', head: '20000' }, error: null }) },
    get: async ({ query }: { query: Query }) => {
      calls.push(query);
      const after = BigInt(query.after?.split(':')[1] ?? '0');
      const remaining = matches.filter(item => BigInt(item.sequence) > after
        && (query.view === 'saved' ? item.saved : query.view === 'done' ? item.done : !item.done)
        && (!query.reason || item.reason === query.reason));
      const items = remaining.slice(0, query.limit);
      return { error: null, data: { profile: 'notification-stream-page-v1', generation: '7', head: '20000',
        reset: false, readThrough: '0', items, groups: [],
        next: remaining.length > query.limit ? `7:${items.at(-1)!.sequence}` : null } };
    },
  } } } } as unknown as MainClient;
  return { main, matches, calls };
}

describe('filtered notification continuation', () => {
  for (const selection of [
    { view: 'saved', reason: null }, { view: 'done', reason: null },
    { view: 'inbox', reason: 'reviewer' }, { view: 'saved', reason: 'manual' },
  ] as const) {
    test(`${selection.view}/${selection.reason ?? 'all'} shows sparse matches exactly once`, async () => {
      const { main, matches, calls } = sparseStream(selection);
      let result = await readLatest(main, selection);
      const seen: string[] = [];
      for (let pages = 0; pages < 4; pages++) {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Expected a notification page');
        seen.push(...result.data.items.map(item => item.id));
        if (result.data.next === null) break;
        // The server cursor advances over matches, even across thousands of unrelated sequences.
        result = await readWindow(main, result.data.next, selection);
      }
      expect(seen).toHaveLength(matches.length);
      expect(new Set(seen).size).toBe(matches.length);
      expect([...seen].sort()).toEqual(matches.map(item => item.id).sort());
      const filters = { ...(selection.view === 'inbox' ? {} : { view: selection.view }),
        ...(selection.reason ? { reason: selection.reason } : {}) };
      expect(calls).toEqual([
        { limit: 50, ...filters }, { after: '7:6850', limit: 50, ...filters },
        { after: '7:13700', limit: 50, ...filters },
      ]);
    });
  }

  test('an empty filtered view ends from the API response, regardless of stream head', async () => {
    const selection = { view: 'saved', reason: null } as const;
    const { main, calls } = sparseStream(selection, 0);
    expect(await readLatest(main, selection)).toMatchObject({ ok: true, data: { items: [], next: null } });
    expect(calls).toEqual([{ limit: 50, view: 'saved' }]);
  });
});
