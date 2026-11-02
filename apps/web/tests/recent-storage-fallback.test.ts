import { expect, test } from 'bun:test';
import { recentHistoryKey } from '../src/search/recent-history';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from '../src/search/recent-storage';

function installStorage() {
  const values = new Map<string, string>();
  let unavailable = false;
  const area = {
    getItem(key: string) {
      if (unavailable) throw new Error('storage unavailable');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (unavailable) throw new Error('storage unavailable');
      values.set(key, value);
    },
  } as Storage;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: area });
  return {
    area,
    values,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    restore() {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

const event = (storageArea: Storage, key: string | null, newValue: string | null = null) =>
  ({ storageArea, key, newValue }) as StorageEvent;

test('observed removals and localStorage.clear cannot resurrect cached durable history', () => {
  const local = installStorage();
  try {
    const bucket = 'anonymous';
    const key = recentHistoryKey(bucket);
    for (const clear of [false, true]) {
      const storage = createRecentBrowserStorage();
      local.values.set(key, 'durable history');
      expect(storage.getItem(key)).toBe('durable history');
      expect(observeRecentHistoryStorageEvent(storage, event(local.area, key, 'other'), 'account:other')).toBe(false);
      expect(observeRecentHistoryStorageEvent(storage, event({} as Storage, null), bucket)).toBe(false);
      if (clear) local.values.clear();
      else local.values.delete(key);
      expect(observeRecentHistoryStorageEvent(storage, event(local.area, clear ? null : key), bucket)).toBe(true);
      local.setUnavailable(true);
      expect(storage.getItem(key)).toBeNull();
      local.setUnavailable(false);
    }
  } finally {
    local.restore();
  }
});

test('failed writes survive empty reads and clears while persistence reports memory use', () => {
  const local = installStorage();
  try {
    const key = recentHistoryKey('anonymous');
    let persistent = true;
    const storage = createRecentBrowserStorage((value) => (persistent = value));
    local.setUnavailable(true);
    storage.setItem(key, 'unsaved edit');
    expect(persistent).toBe(false);
    local.setUnavailable(false);
    expect(storage.getItem(key)).toBe('unsaved edit');
    expect(observeRecentHistoryStorageEvent(storage, event(local.area, null), 'anonymous')).toBe(true);
    expect(storage.getItem(key)).toBe('unsaved edit');
    local.setUnavailable(true);
    expect(storage.getItem(key)).toBe('unsaved edit');
    local.setUnavailable(false);
    storage.setItem(key, 'unsaved edit');
    expect(persistent).toBe(true);
  } finally {
    local.restore();
  }
});
