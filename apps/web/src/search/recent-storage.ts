import { recentHistoryKey, type RecentStorage } from './recent-history';

type CachedValue = { value: string; unsaved: boolean };
export type RecentBrowserStorage = RecentStorage & { observe(event: StorageEvent): void };

export function createRecentBrowserStorage(onPersistenceChange?: (persistent: boolean) => void): RecentBrowserStorage {
  const cache = new Map<string, CachedValue>();
  const report = (available: boolean) =>
    onPersistenceChange?.(available && ![...cache.values()].some(({ unsaved }) => unsaved));
  return {
    getItem(key) {
      try {
        const value = localStorage.getItem(key);
        const cached = cache.get(key);
        if (cached?.unsaved) {
          if (value === cached.value) cached.unsaved = false;
          report(true);
          return cached.value;
        }
        if (value === null) cache.delete(key);
        else cache.set(key, { value, unsaved: false });
        report(true);
        return value;
      } catch {
        report(false);
        return cache.get(key)?.value ?? null;
      }
    },
    setItem(key, value) {
      const cached = { value, unsaved: true };
      cache.set(key, cached);
      try {
        localStorage.setItem(key, value);
        cached.unsaved = false;
        report(true);
      } catch {
        report(false);
      }
    },
    observe(event) {
      if (event.key === null) {
        for (const [key, cached] of cache) if (!cached.unsaved) cache.delete(key);
      } else if (!cache.get(event.key)?.unsaved) {
        if (event.newValue === null) cache.delete(event.key);
        else cache.set(event.key, { value: event.newValue, unsaved: false });
      }
    },
  };
}

export function observeRecentHistoryStorageEvent(
  storage: RecentBrowserStorage,
  event: StorageEvent,
  bucket: string | null,
): boolean {
  if (!isLocalStorageEvent(event)) return false;
  if (event.key !== null && !event.key.startsWith(recentHistoryKey(''))) return false;
  storage.observe(event);
  return bucket !== null && (event.key === null || event.key === recentHistoryKey(bucket));
}

function isLocalStorageEvent(event: StorageEvent): boolean {
  if (event.storageArea === null) return true;
  try {
    return event.storageArea === localStorage;
  } catch {
    return false;
  }
}
