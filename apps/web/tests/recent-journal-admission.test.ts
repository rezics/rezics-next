import { expect, test } from 'bun:test';
import {
  readRecentHistory,
  recentBucket,
  recentHistoryKey,
  rememberRecent,
  type RecentStorage,
} from '../src/search/recent-history';
import { createRecentSearchSyncAdapter, RecentSyncError, type RecentSearchTransport } from '../src/search/recent-sync';

const accountId = '019f0000-0000-7000-8000-734100000001';
const bucket = recentBucket('signed-in', accountId)!;
function memory(): RecentStorage & { value(key: string, value: string): void } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key, value) => values.set(key, value),
  };
}

test('malformed persisted journals stay unavailable without dispatch or loss of local history and attempted receipts', async () => {
  type Fixture = {
    revision: number;
    observed: Record<string, unknown>;
    rows: Record<string, { id: string; visitedAt: number; entry?: unknown } | null>;
    pending: Array<{
      key: string;
      change: unknown;
      queuedAt: string;
      localId?: string;
      visitedAt?: number;
      expectedRevision?: number;
    }>;
  };
  const entry = rememberRecent([], 'Recoverable query')[0]!,
    native = { kind: 'query', text: entry.query },
    receipt = {
      key: 'uncertain-receipt',
      change: { kind: 'use', entry: native },
      queuedAt: new Date().toISOString(),
      localId: entry.id,
      visitedAt: entry.visitedAt,
      expectedRevision: 4,
    },
    valid: Fixture = {
      revision: 4,
      observed: { [entry.id]: entry.visitedAt },
      rows: {
        [entry.id]: {
          id: '019f0000-0000-7000-8000-734100000002',
          visitedAt: entry.visitedAt,
          entry: native,
        },
      },
      pending: [receipt],
    };
  const missingReference = structuredClone(valid);
  missingReference.pending.push({
    key: 'remove-receipt',
    change: { kind: 'remove', id: 'pending:missing-receipt' },
    queuedAt: new Date().toISOString(),
    localId: entry.id,
  });
  const invalidRemove = structuredClone(valid);
  invalidRemove.pending.push({
    key: 'remove-receipt',
    change: { kind: 'remove', id: 'not-a-native-id' },
    queuedAt: new Date().toISOString(),
    localId: entry.id,
  });
  const badRowId = structuredClone(valid);
  badRowId.rows[entry.id] = { id: 'not-a-uuid', visitedAt: entry.visitedAt, entry: native };
  const badRowValue = structuredClone(valid);
  badRowValue.rows[entry.id] = null;
  const badObserved = structuredClone(valid);
  badObserved.observed[entry.id] = 'later';
  const badChange = structuredClone(valid);
  badChange.pending[0]!.change = { kind: 'rename' };
  const badExpectedRevision = structuredClone(valid);
  badExpectedRevision.pending[0]!.expectedRevision = 2147483647;

  const malformed: unknown[] = [
    null,
    false,
    0,
    [],
    { ...valid, observed: [] },
    badObserved,
    { ...valid, observed: { arbitrary: entry.visitedAt } },
    { ...valid, rows: [] },
    badRowId,
    badRowValue,
    { ...valid, revision: 2147483647 },
    badExpectedRevision,
    badChange,
    missingReference,
    invalidRemove,
    { ...valid, pending: [{ ...receipt, queuedAt: 'not a date' }] },
  ];

  for (const nativeJournal of malformed) {
    const storage = memory(),
      key = recentHistoryKey(bucket);
    const serialized = JSON.stringify({ entries: [entry], removed: [], native: nativeJournal });
    storage.value(key, serialized);
    let reads = 0,
      writes = 0,
      updates = 0;
    const transport: RecentSearchTransport = {
      read: async () => {
        reads++;
        return { accountId, page: { revision: 4, next: null, recentSearches: [] } };
      },
      write: async () => {
        writes++;
        return { ok: false, code: 'unexpected' };
      },
    };
    const adapter = createRecentSearchSyncAdapter({
      accountId,
      bucket,
      currentBucket: () => bucket,
      storage,
      transport,
      onRemote: () => updates++,
    });

    await expect(adapter.sync([entry], new AbortController().signal)).rejects.toBeInstanceOf(RecentSyncError);
    expect([reads, writes, updates]).toEqual([0, 0, 0]);
    expect(storage.getItem(key)).toBe(serialized);
    expect(readRecentHistory(storage, bucket)).toEqual([entry]);
    adapter.dispose();
  }
});
