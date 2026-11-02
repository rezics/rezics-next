import { expect, test } from 'bun:test';
import { readRecentDocument, readRecentHistory, writeRecentDocument, type RecentEntry, type RecentStorage } from '../src/search/recent-history';
import { createRecentPageProgress, RECENT_HISTORY_READ_PAGE_LIMIT } from '../src/search/recent-page-progress';
import {
  createRecentSearchSyncAdapter,
  type RecentSearchTransport,
} from '../src/search/recent-sync';
import type { RecentItem } from '../src/search/recent';

const identityRows = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${start + index}` }));

test('accepts the 20+12 history within two pages and rejects malformed continuation progress', () => {
  expect(RECENT_HISTORY_READ_PAGE_LIMIT).toBe(2);
  const healthy = createRecentPageProgress<{ id: string }>();
  expect(healthy.accept({ recentSearches: identityRows(0, 20), next: 'second' })).toBe(true);
  expect(healthy.accept({ recentSearches: identityRows(20, 12), next: null })).toBe(true);
  expect(healthy.rows).toHaveLength(32);

  const repeated = createRecentPageProgress<{ id: string }>();
  repeated.accept({ recentSearches: identityRows(0, 20), next: 'same' });
  expect(repeated.accept({ recentSearches: identityRows(20, 20), next: 'same' })).toBe(false);
  const duplicate = createRecentPageProgress<{ id: string }>();
  duplicate.accept({ recentSearches: identityRows(0, 20), next: 'next' });
  expect(duplicate.accept({ recentSearches: identityRows(19, 12), next: null })).toBe(false);
  expect(createRecentPageProgress<{ id: string }>().accept({ recentSearches: [], next: 'stalled' })).toBe(false);
});

const accountId = '019f0000-0000-7000-8000-734100000001';
const bucket = `account:${accountId}`;
function memory(): RecentStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}
const signal = () => new AbortController().signal;
function nativeRows(revision: number): RecentItem[] {
  return Array.from({ length: 32 }, (_, index) => ({
    id: crypto.randomUUID(),
    revision,
    lastUsed: new Date(Date.now() - index * 1000).toISOString(),
    entry: { kind: 'query', text: `Native ${index}` },
    display: null,
  }));
}

test('keeps accepted history and pending removal on a malformed page, then retries from page one', async () => {
  const storage = memory(), reads: (string | undefined)[] = [], writes: Parameters<RecentSearchTransport['write']>[0][] = [];
  let revision = 4, rows = nativeRows(revision), failNext = false;
  const transport: RecentSearchTransport = {
    async read(cursor) {
      reads.push(cursor);
      if (failNext) {
        failNext = false;
        return { accountId, page: { revision, next: 'stalled', recentSearches: [] } };
      }
      return {
        accountId,
        page: {
          revision,
          next: cursor ? null : rows.length > 20 ? 'page-two' : null,
          recentSearches: cursor ? rows.slice(20) : rows.slice(0, 20),
        },
      };
    },
    async write(input) {
      writes.push(structuredClone(input));
      if (input.pending.change.kind !== 'remove') throw new Error('Expected a removal');
      rows = rows.filter((row) => row.id !== input.pending.change.id);
      revision++;
      return { ok: true, value: { id: null, revision, lastUsed: new Date().toISOString() } };
    },
  };
  let visible: readonly RecentEntry[] = [];
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => bucket,
    storage,
    onRemote: (entries) => (visible = entries),
    transport,
  });
  await adapter.sync([], signal());
  expect(visible).toHaveLength(32);
  const accepted = readRecentHistory(storage, bucket), removedId = accepted[0]!.id;
  const document = readRecentDocument(storage, bucket);
  writeRecentDocument(storage, bucket, {
    ...document,
    entries: document.entries.filter((entry) => entry.id !== removedId),
    removed: [removedId],
  });
  const localBeforeFailure = readRecentHistory(storage, bucket);
  failNext = true;
  await expect(adapter.refresh(visible, signal())).rejects.toHaveProperty('code', 'unavailable');
  expect(readRecentHistory(storage, bucket)).toEqual(localBeforeFailure);
  const pending = (readRecentDocument(storage, bucket).native as { pending: { key: string }[] }).pending;
  expect(pending).toHaveLength(1);

  await adapter.retry(visible, signal());
  expect(writes[0]!.pending.key).toBe(pending[0]!.key);
  expect(writes[0]!.expectedRevision).toBe(4);
  expect(visible).toHaveLength(31);
  expect(visible.map((entry) => entry.id)).not.toContain(removedId);
  expect(reads).toEqual([undefined, 'page-two', undefined, undefined, 'page-two', undefined, 'page-two']);
  adapter.dispose();
});
