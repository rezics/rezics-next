import { expect, test } from 'bun:test';
import { recentHistoryKey } from '../src/search/recent-history';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from '../src/search/recent-storage';

function installStorage() {
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
  return {
    area,
    values,
    setUnavailable: (value: boolean) => (unavailable = value),
    restore: () =>
      previous
        ? Object.defineProperty(globalThis, 'localStorage', previous)
        : Reflect.deleteProperty(globalThis, 'localStorage'),
  };
}

const event = (storageArea: Storage, key: string | null, newValue: string | null = null) =>
  ({ storageArea, key, newValue }) as StorageEvent;

test('storage removals and clear stay deleted while failed local writes survive in memory', () => {
  const local = installStorage();
  const bucket = 'anonymous';
  const key = recentHistoryKey(bucket);
  try {
    for (const clear of [false, true]) {
      const storage = createRecentBrowserStorage();
      const direct = createRecentBrowserStorage();
      local.values.set(key, 'durable');
      expect(storage.getItem(key)).toBe('durable');
      expect(direct.getItem(key)).toBe('durable');
      expect(observeRecentHistoryStorageEvent(storage, event(local.area, key, 'other'), 'account:other')).toBe(false);
      expect(observeRecentHistoryStorageEvent(storage, event({} as Storage, null), bucket)).toBe(false);
      if (clear) local.values.clear();
      else local.values.delete(key);
      expect(direct.getItem(key)).toBeNull();
      expect(observeRecentHistoryStorageEvent(storage, event(local.area, clear ? null : key), bucket)).toBe(true);
      local.setUnavailable(true);
      expect(storage.getItem(key)).toBeNull();
      expect(direct.getItem(key)).toBeNull();
      local.setUnavailable(false);
    }

    let persistent = true;
    const memory = createRecentBrowserStorage((value) => (persistent = value));
    local.setUnavailable(true);
    memory.setItem(key, 'unsaved');
    expect(persistent).toBe(false);
    local.setUnavailable(false);
    expect(memory.getItem(key)).toBe('unsaved');
    expect(observeRecentHistoryStorageEvent(memory, event(local.area, null), bucket)).toBe(true);
    expect(memory.getItem(key)).toBe('unsaved');
    local.setUnavailable(true);
    expect(memory.getItem(key)).toBe('unsaved');
    local.setUnavailable(false);
    memory.setItem(key, 'unsaved');
    expect(persistent).toBe(true);
  } finally {
    local.restore();
  }
});
