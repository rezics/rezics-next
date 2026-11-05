import { expect, test } from 'bun:test';
import {
  applyRecentSearch,
  NATIVE_RECENT_QUERY_TEXT_LIMIT,
  readRecentHistory,
  recentHistoryKey,
  recentId,
  rememberRecent,
  writeRecentHistory,
  type RecentEntry,
  type RecentStorage,
} from '../src/search/recent-history';
import { createRecentSearchSyncAdapter, nativeRecentEntry } from '../src/search/recent-sync';
import type { RecentItem, Pending } from '../src/search/recent';
import { isWithinGlobalSearchQueryLimit } from '../src/search/query-text-limit';

const accountId = '019f0000-0000-7000-8000-734100000001';
const bucket = `account:${accountId}`;
const signal = () => new AbortController().signal;
function memory(): RecentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function resume(query: string, languages?: readonly string[]) {
  const params = new URLSearchParams('language=de&q=stale&cursor=old');
  applyRecentSearch(params, query, languages);
  return params;
}
function store(storage: RecentStorage, entries: readonly RecentEntry[], extra: Record<string, unknown> = {}) {
  writeRecentHistory(storage, bucket, entries);
  if (!Object.keys(extra).length) return;
  const key = recentHistoryKey(bucket);
  storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key) ?? '{}'), ...extra }));
}

test('local Recent remembers, stores and resumes exact global queries instead of the old 256-unit prefix', () => {
  const ascii257 = 'a'.repeat(257);
  const ascii512 = 'b'.repeat(512);
  const ascii513 = 'c'.repeat(513);
  const prefix = ascii257.slice(0, NATIVE_RECENT_QUERY_TEXT_LIMIT);
  const astral = `${'d'.repeat(255)}\u{1F642}`;
  const legacy = '界'.repeat(NATIVE_RECENT_QUERY_TEXT_LIMIT);
  expect(ascii257.length).toBeGreaterThan(NATIVE_RECENT_QUERY_TEXT_LIMIT);
  expect(isWithinGlobalSearchQueryLimit(ascii512)).toBe(true);
  expect(isWithinGlobalSearchQueryLimit(ascii513)).toBe(false);
  expect(astral.length).toBe(257);
  expect(isWithinGlobalSearchQueryLimit(astral)).toBe(true);
  expect(astral.slice(0, NATIVE_RECENT_QUERY_TEXT_LIMIT)).not.toBe(astral);

  const now = 1;
  let entries = rememberRecent([], prefix, undefined, now);
  entries = rememberRecent(entries, ascii257, undefined, now + 1, ['fr']);
  entries = rememberRecent(entries, ascii512, undefined, now + 2);
  entries = rememberRecent(entries, astral, undefined, now + 3);
  expect(rememberRecent(entries, ascii513, undefined, now + 4)).toEqual(entries);
  expect(entries.map((entry) => entry.query)).toEqual([astral, ascii512, ascii257, prefix]);
  expect(entries[2]?.id).toBe(recentId(ascii257, undefined, ['fr']));
  expect(entries[2]?.id).not.toBe(recentId(prefix));

  const storage = memory();
  writeRecentHistory(storage, bucket, entries);
  const stored = readRecentHistory(storage, bucket);
  expect(stored.map((entry) => entry.query)).toEqual([astral, ascii512, ascii257, prefix]);
  expect(resume(stored[0]!.query).get('q')).toBe(astral);
  expect(resume(stored[2]!.query, stored[2]!.languages).getAll('language')).toEqual(['fr']);
  expect(nativeRecentEntry(stored[2]!)).toBeUndefined();
  expect(nativeRecentEntry(stored[3]!)?.text).toBe(prefix);

  storage.setItem(recentHistoryKey(bucket), JSON.stringify([{ query: ascii513, visitedAt: 1 }]));
  expect(readRecentHistory(storage, bucket)).toEqual([]);
  storage.setItem(recentHistoryKey(bucket), JSON.stringify([{ query: legacy, visitedAt: 1 }]));
  expect(readRecentHistory(storage, bucket)[0]?.query).toBe(legacy);
});

test('a long local-only query cannot block native Recent writes, removal or clear', async () => {
  const storage = memory();
  const long = 'e'.repeat(300);
  const ordinary = 'ordinary query';
  const now = Date.now();
  const entries = rememberRecent(rememberRecent([], ordinary, undefined, now), long, undefined, now + 1);
  expect(nativeRecentEntry(entries[0]!)).toBeUndefined();
  expect(nativeRecentEntry(entries[1]!)?.text).toBe(ordinary);

  let revision = 3,
    rows: RecentItem[] = [],
    visible: readonly RecentEntry[] = [];
  const writes: Pending[] = [];
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => bucket,
    storage,
    onRemote: (next) => {
      visible = next;
    },
    transport: {
      read: async () => ({ accountId, page: { revision, next: null, recentSearches: [...rows] } }),
      write: async ({ pending }) => {
        writes.push(structuredClone(pending));
        if (pending.change.kind === 'use') {
          expect(pending.change.entry).toEqual({ kind: 'query', text: ordinary });
          const lastUsed = new Date(now).toISOString();
          const id = '019f0000-0000-7000-8000-734100000009';
          rows = [{ id, revision: ++revision, lastUsed, entry: pending.change.entry, display: null }];
          return { ok: true, value: { id, revision, lastUsed } };
        }
        if (pending.change.kind === 'remove') {
          expect(pending.change.id).toBe(rows[0]?.id);
          rows = [];
        } else rows = [];
        return { ok: true, value: { id: null, revision: ++revision, lastUsed: new Date().toISOString() } };
      },
    },
  });
  store(storage, entries);
  await adapter.sync(entries, signal());
  expect(writes).toHaveLength(1);
  expect(visible.map((entry) => entry.query)).toEqual([long, ordinary]);

  const longId = visible[0]!.id;
  store(
    storage,
    visible.filter((entry) => entry.id !== longId),
    { removed: [longId] },
  );
  await adapter.sync(readRecentHistory(storage, bucket), signal());
  expect(writes).toHaveLength(1);
  expect(readRecentHistory(storage, bucket).map((entry) => entry.query)).toEqual([ordinary]);

  store(storage, [], { clear: crypto.randomUUID() });
  await adapter.sync([], signal());
  expect(writes.at(-1)?.change.kind).toBe('clear');
  expect(readRecentHistory(storage, bucket)).toEqual([]);
  adapter.dispose();
});
