import { expect, test } from 'bun:test';
import {
  readRecentDocument,
  rememberRecent,
  writeRecentDocument,
  recentBucket,
  type RecentStorage,
} from '../src/search/recent-history';
import {
  createRecentSearchSyncAdapter,
  RecentSyncError,
  type RecentSearchTransport,
} from '../src/search/recent-sync';
import {
  admitRecentRetryHeaders,
  recentRetryDeadlineBlocks,
} from '../src/search/recent-retry-admission';

const accountId = '019f0000-0000-7000-8000-734100000001';
const bucket = recentBucket('signed-in', accountId)!;
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

test('Native Recent Retry-After prevents early reads and writes through sync, refresh and retry while exact pending commands remain recoverable', async () => {
  const now = 1_700_000_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    expect(admitRecentRetryHeaders({ 'retry-after': '5' }, now)).toBe(now + 5_000);
    expect(admitRecentRetryHeaders({ 'Retry-After': 'Thu, 01 Jan 1970 00:00:03 GMT' }, 1000)).toBe(3_000);
    expect(admitRecentRetryHeaders({ 'retry-after': 'invalid' }, now)).toBeUndefined();
    expect(admitRecentRetryHeaders({ 'retry-after': '0' }, now)).toBe(now);
    expect(recentRetryDeadlineBlocks(now + 1, now)).toBe(true);
    expect(recentRetryDeadlineBlocks(now, now)).toBe(false);

    const storage = memory();
    const writes: Parameters<RecentSearchTransport['write']>[0][] = [];
    let reads = 0,
      writeCalls = 0,
      failWrite = true;
    const adapter = createRecentSearchSyncAdapter({
      accountId,
      bucket,
      currentBucket: () => bucket,
      storage,
      transport: {
        read: async () => {
          reads++;
          return { accountId, page: { revision: 4, next: null, recentSearches: [] } };
        },
        write: async (input) => {
          writeCalls++;
          writes.push(structuredClone(input));
          if (failWrite) return { ok: false, code: 'unavailable', retryAt: now + 5_000 };
          return {
            ok: true,
            value: {
              id: '019f0000-0000-7000-8000-734100000003',
              revision: input.expectedRevision + 1,
              lastUsed: new Date(now).toISOString(),
            },
          };
        },
      },
    });
    await adapter.sync([], signal());
    const entries = rememberRecent([], 'queued visit');
    writeRecentDocument(storage, bucket, { ...readRecentDocument(storage, bucket), entries });
    await expect(adapter.sync(entries, signal())).rejects.toBeInstanceOf(RecentSyncError);
    const attempted = writes[0]!;
    expect(attempted.expectedRevision).toBe(4);
    expect(attempted.pending.change).toEqual({ kind: 'use', entry: { kind: 'query', text: 'queued visit' } });
    const blocked = { reads, writeCalls };
    writeRecentDocument(storage, bucket, {
      ...readRecentDocument(storage, bucket),
      entries: rememberRecent(entries, 'local only'),
    });
    for (const method of ['sync', 'refresh', 'retry'] as const)
      await expect(adapter[method](entries, signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(reads).toBe(blocked.reads);
    expect(writeCalls).toBe(blocked.writeCalls);
    expect(readRecentDocument(storage, bucket).entries.map((e) => e.query)).toEqual(['local only', 'queued visit']);
    const pending = (readRecentDocument(storage, bucket).native as { pending: typeof attempted.pending[] }).pending[0];
    expect(pending).toMatchObject({
      key: attempted.pending.key,
      expectedRevision: 4,
      change: attempted.pending.change,
    });
    Date.now = () => now + 5_000;
    expect(reads).toBe(blocked.reads);
    failWrite = false;
    await adapter.retry(entries, signal());
    expect(writes[1]!.pending.key).toBe(attempted.pending.key);
    expect(writes[1]!.expectedRevision).toBe(4);
    expect(writes[1]!.pending.change).toEqual(attempted.pending.change);
    adapter.dispose();
  } finally {
    Date.now = originalNow;
  }
});

test('malformed and expired Recent Retry-After hints do not block; disposal retires a live deadline', async () => {
  const now = 1_700_000_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const storage = memory();
    let reads = 0;
    const failing = (retryAt?: number): RecentSearchTransport => ({
      read: async () => {
        reads++;
        return { accountId, page: null, code: 'unavailable', ...(retryAt === undefined ? {} : { retryAt }) };
      },
      write: async () => ({ ok: false, code: 'unavailable' }),
    });
    const make = (transport: RecentSearchTransport) =>
      createRecentSearchSyncAdapter({ accountId, bucket, currentBucket: () => bucket, storage, transport });
    for (const retryAt of [undefined, now, admitRecentRetryHeaders({ 'retry-after': 'tomorrow' }, now)]) {
      const adapter = make(failing(retryAt));
      await expect(adapter.sync([], signal())).rejects.toBeInstanceOf(RecentSyncError);
      const before = reads;
      await expect(adapter.refresh([], signal())).rejects.toBeInstanceOf(RecentSyncError);
      expect(reads).toBe(before + 1);
      adapter.dispose();
    }
    const limited = make(failing(now + 8_000));
    await expect(limited.sync([], signal())).rejects.toBeInstanceOf(RecentSyncError);
    const frozen = reads;
    await expect(limited.retry([], signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(reads).toBe(frozen);
    limited.dispose();
    const next = make(failing(undefined));
    await expect(next.sync([], signal())).rejects.toBeInstanceOf(RecentSyncError);
    expect(reads).toBe(frozen + 1);
    next.dispose();
  } finally {
    Date.now = originalNow;
  }
});
