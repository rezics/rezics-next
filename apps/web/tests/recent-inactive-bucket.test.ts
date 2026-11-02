import { expect, test } from 'bun:test';
import { recentHistoryKey } from '../src/search/recent-history';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from '../src/search/recent-storage';

test('inactive durable removals and clear invalidate cached buckets without losing unsaved writes', () => {
  const values = new Map<string, string>();
  let unavailable = false;
  const area = {
    getItem: (key: string) => {
      if (unavailable) throw new Error('unavailable');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (unavailable) throw new Error('unavailable');
      values.set(key, value);
    },
  } as Storage;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: area });
  const key = (bucket: string) => recentHistoryKey(bucket);
  const event = (eventKey: string | null) => ({ storageArea: area, key: eventKey, newValue: null }) as StorageEvent;
  const storage = createRecentBrowserStorage();

  try {
    for (const bucket of ['account:A', 'account:B', 'account:C']) values.set(key(bucket), bucket);
    for (const bucket of ['account:A', 'account:B', 'account:C']) expect(storage.getItem(key(bucket))).toBe(bucket);
    values.delete(key('account:A'));
    expect(observeRecentHistoryStorageEvent(storage, event(key('account:A')), 'account:B')).toBe(false);
    unavailable = true;
    expect(storage.getItem(key('account:A'))).toBeNull();
    unavailable = false;

    unavailable = true;
    storage.setItem(key('account:B'), 'unsaved');
    values.clear();
    expect(observeRecentHistoryStorageEvent(storage, event(null), null)).toBe(false);
    expect(storage.getItem(key('account:C'))).toBeNull();
    expect(storage.getItem(key('account:B'))).toBe('unsaved');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
