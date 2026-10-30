import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readRecentDocument,
  rememberRecent,
  writeRecentDocument,
  recentHistoryKey,
  type RecentEntry,
  type RecentHistory,
  type RecentStorage,
  type RecentSyncAdapter,
} from './recent-history';
import { RecentSyncError, type RecentSearchSyncAdapter } from './recent-sync';
import { useRecentSearchSyncAdapter } from './recent-sync-hook';

const changedEvent = 'rezics-search-history-changed';
type Snapshot = { bucket: string | null; entries: readonly RecentEntry[]; version: number };
/** The delivered local helper owns both Recent and History. Events notify sibling hooks; they hold no store. */
export function useRecentHistory(bucket: string | null, supplied?: RecentSyncAdapter): RecentHistory {
  const currentBucket = useRef(bucket);
  currentBucket.current = bucket;
  const origin = useRef({});
  const persistent = useRef(true);
  const [storage] = useState<RecentStorage>(() => {
    const memory: Record<string, string> = {};
    return {
      getItem(key) {
        try {
          const value = localStorage.getItem(key);
          if (value !== null) memory[key] = value;
          return value;
        } catch {
          persistent.current = false;
          return memory[key] ?? null;
        }
      },
      setItem(key, value) {
        memory[key] = value;
        try {
          localStorage.setItem(key, value);
        } catch {
          persistent.current = false;
        }
      },
    };
  });
  const [snapshot, setSnapshot] = useState<Snapshot>({ bucket: null, entries: [], version: 0 });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [sync, setSync] = useState<RecentHistory['sync']>('local-only');
  const [failure, setFailure] = useState<RecentHistory['failure']>();
  const [attempt, setAttempt] = useState({ id: 0, reload: false });
  const publish = useCallback((entries: readonly RecentEntry[], dirty = false) => {
    const bucket = currentBucket.current;
    const next = { bucket, entries, version: latest.current.version + (dirty ? 1 : 0) };
    latest.current = next;
    setSnapshot(next);
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: { bucket, entries, dirty, origin: origin.current } }));
  }, []);
  const native = useRecentSearchSyncAdapter(bucket, publish, storage);
  const adapter = bucket?.startsWith('account:') ? (supplied ?? native) : undefined;
  useEffect(() => {
    const read = () => {
      if (currentBucket.current !== bucket) return;
      const entries = bucket ? readRecentDocument(storage, bucket).entries : [];
      const next = { bucket, entries, version: latest.current.version + 1 };
      latest.current = next;
      setSnapshot(next);
    };
    read();
    setFailure(undefined);
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.origin !== origin.current && detail.bucket === bucket) {
        const next = { bucket, entries: detail.entries, version: latest.current.version + (detail.dirty ? 1 : 0) };
        latest.current = next;
        setSnapshot(next);
      }
    };
    const stored = (event: StorageEvent) => {
      if (bucket && event.key === recentHistoryKey(bucket)) read();
    };
    const refresh = () => setAttempt((a) => ({ id: a.id + 1, reload: false }));
    window.addEventListener(changedEvent, changed);
    window.addEventListener('storage', stored);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(changedEvent, changed);
      window.removeEventListener('storage', stored);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [bucket, storage]);
  useEffect(() => {
    if (!bucket || latest.current.bucket !== bucket || !adapter) {
      setSync('local-only');
      return;
    }
    const abort = new AbortController();
    setSync('pending');
    const owner = adapter as Partial<RecentSearchSyncAdapter>;
    const run = attempt.reload && owner.retry ? owner.retry : (owner.refresh ?? adapter.sync);
    void run(latest.current.entries, abort.signal).then(
      () => {
        if (!abort.signal.aborted && currentBucket.current === bucket) {
          setFailure(undefined);
          setSync('synced');
        }
      },
      (error) => {
        if (!abort.signal.aborted && currentBucket.current === bucket)
          setFailure(error instanceof RecentSyncError ? error.code : 'unavailable');
      },
    );
    return () => abort.abort();
  }, [bucket, snapshot.bucket, snapshot.version, adapter, attempt]);
  const update = (change: 'clear' | string | ((entries: readonly RecentEntry[]) => RecentEntry[])) => {
    if (!bucket || currentBucket.current !== bucket) return;
    const document = readRecentDocument(storage, bucket);
    // Keep current owner hydration in memory; it is deliberately absent from durable browser history.
    const entries = latest.current.bucket === bucket ? latest.current.entries : document.entries;
    if (change === 'clear') {
      document.entries = [];
      document.clear = crypto.randomUUID();
      document.removed = [];
    } else if (typeof change === 'string') {
      if (!entries.some((e) => e.id === change)) return;
      if (document.removed.length >= 100) {
        setFailure('unavailable');
        return;
      }
      document.entries = entries.filter((e) => e.id !== change);
      document.removed.push(change);
    } else document.entries = change(entries);
    if (!bucket.startsWith('account:')) {
      document.removed = [];
      delete document.clear;
    }
    writeRecentDocument(storage, bucket, document);
    publish(document.entries, true);
  };
  return {
    entries: snapshot.bucket === bucket ? snapshot.entries : [],
    persistence: !bucket ? 'unavailable' : persistent.current ? 'local' : 'memory',
    sync: adapter ? sync : 'local-only',
    ...(failure ? { failure } : {}),
    remember: (query, scope) => update((entries) => rememberRecent(entries, query, scope)),
    remove: (id) => update(id),
    clear: () => update('clear'),
    retry: () => setAttempt((a) => ({ id: a.id + 1, reload: true })),
  };
}
