import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../../feed/types.ts';
import { browserMainApi } from '../../api/browser.ts';
import { mergeNotificationTriage, readLatest, readWindow, type NotificationSelection, type StreamItem } from './window.ts';

type Query = { before?: string; limit: number; view?: 'saved' | 'done'; reason?: string };

test('triage merges monotonically by owner revision, preserving the row fields', () => {
  const current = { id: 'notice', saved: true, done: false, triageRevision: '4', sequence: '100' } as StreamItem;
  expect(mergeNotificationTriage(current, { saved: false, done: true, triageRevision: '3' })).toBe(current);
  expect(mergeNotificationTriage(current, { saved: false, done: false, triageRevision: null })).toBe(current);
  expect(mergeNotificationTriage(current, { saved: false, done: true, triageRevision: '5' }))
    .toMatchObject({ id: 'notice', sequence: '100', saved: false, done: true, triageRevision: '5' });
  const stalePage = { ...current, saved: false, triageRevision: null };
  expect(mergeNotificationTriage(stalePage, current)).toMatchObject({ saved: true, triageRevision: '4' });
});

function sparseStream(selection: NotificationSelection, count = 123) {
  const matches = Array.from({ length: count }, (_, index) => ({
    id: `notice-${index}`, sequence: String((index + 1) * 137),
    saved: selection.view === 'saved', done: selection.view === 'done', reason: selection.reason,
  } as StreamItem));
  const calls: Query[] = [];
  const cursors = new Map<string, bigint>();
  const main = { v1: { me: { notifications: {
    hint: { get: async () => ({ data: { generation: '7', head: '20000' }, error: null }) },
    get: async ({ query }: { query: Query }) => {
      calls.push(query);
      const before = query.before && query.before !== 'latest' ? cursors.get(query.before)! : 20001n;
      const remaining = [...matches].reverse().filter(item => BigInt(item.sequence) < before
        && (query.view === 'saved' ? item.saved : query.view === 'done' ? item.done : !item.done)
        && (!query.reason || item.reason === query.reason));
      const items = remaining.slice(0, query.limit);
      const next = remaining.length > query.limit ? `page-before-${items.at(-1)!.id}` : null;
      if (next) cursors.set(next, BigInt(items.at(-1)!.sequence));
      return { error: null, data: { profile: 'notification-stream-page-v1', generation: '7', head: '20000',
        reset: false, readThrough: '0', items, groups: [],
        next } };
    },
  } } } } as unknown as MainClient;
  return { main, matches, calls };
}

describe('filtered notification continuation', () => {
  for (const selection of [
    { view: 'saved', reason: null }, { view: 'done', reason: null },
    { view: 'inbox', reason: 'reviewer' }, { view: 'saved', reason: 'manual' },
  ] as const) {
    test(`${selection.view}/${selection.reason ?? 'all'} opens newest and pages every older sparse match exactly once`, async () => {
      const { main, matches, calls } = sparseStream(selection);
      let result = await readLatest(main, selection);
      const seen: string[] = [];
      const pageSizes: number[] = [];
      const newestFirst = [...matches].reverse();
      for (let pages = 0; pages < 4; pages++) {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Expected a notification page');
        expect(result.data.items.map(item => item.id)).toEqual(
          newestFirst.slice(pages * 50, (pages + 1) * 50).map(item => item.id));
        pageSizes.push(result.data.items.length);
        seen.push(...result.data.items.map(item => item.id));
        if (result.data.next === null) break;
        // The server cursor advances over matches, even across thousands of unrelated sequences.
        result = await readWindow(main, result.data.next, selection);
      }
      expect(seen).toHaveLength(matches.length);
      expect(new Set(seen).size).toBe(matches.length);
      expect(seen).toEqual(newestFirst.map(item => item.id));
      expect(pageSizes).toEqual([50, 50, 23]);
      expect(result.ok && result.data.next).toBeNull();
      expect(seen.at(-1)).toBe(matches[0]!.id);
      const filters = { ...(selection.view === 'inbox' ? {} : { view: selection.view }),
        ...(selection.reason ? { reason: selection.reason } : {}) };
      expect(calls).toEqual([
        { before: 'latest', limit: 50, ...filters }, { before: 'page-before-notice-73', limit: 50, ...filters },
        { before: 'page-before-notice-23', limit: 50, ...filters },
      ]);
    });
  }

  test('an empty filtered view ends from the API response, regardless of stream head', async () => {
    const selection = { view: 'saved', reason: null } as const;
    const { main, calls } = sparseStream(selection, 0);
    expect(await readLatest(main, selection)).toMatchObject({ ok: true, data: { items: [], next: null } });
    expect(calls).toEqual([{ before: 'latest', limit: 50, view: 'saved' }]);
  });
});

test('latest keeps the authoritative count and its overflow, even for an empty selected page', async () => {
  const main = browserMainApi('https://contract.invalid', { fetcher: (async input => {
    const url = new URL(String(input));
    return Response.json(url.pathname.endsWith('/unread-count')
      ? { profile: 'notification-unread-count-v1', generation: '7', count: 99, overflow: true }
      : { profile: 'notification-stream-page-v1', generation: '7', head: '20000', reset: false,
        readThrough: '0', items: [], groups: [], next: null });
  }) as typeof fetch });
  expect(await readLatest(main, { view: 'saved', reason: null })).toMatchObject({ ok: true, data: {
    items: [], unreadCount: { ok: true, data: { generation: '7', count: 99, overflow: true } } } });
});

test('an expired count refuses the page rather than presenting an earlier personal read', async () => {
  const main = browserMainApi('https://contract.invalid', { fetcher: (async input => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/unread-count')
      ? Response.json({ code: 'account_assertion_denied' }, { status: 401 })
      : Response.json({ profile: 'notification-stream-page-v1', generation: '7', head: '1', reset: false,
        readThrough: '0', items: [], groups: [], next: null });
  }) as typeof fetch });
  expect(await readLatest(main)).toEqual({ ok: false, failure: 'sign-in', status: 401, problem: { code: 'account_assertion_denied' } });
});
