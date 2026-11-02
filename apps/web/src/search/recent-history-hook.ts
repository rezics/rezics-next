import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionStateSnapshot } from '../session/browser-state';
import {
  readRecentDocument,
  rememberRecent,
  writeRecentDocument,
  type RecentEntry,
  type RecentHistory,
  type RecentSyncAdapter,
} from './recent-history';
import { RecentSyncError, type RecentSearchSyncAdapter } from './recent-sync';
import { useRecentSearchSyncAdapter } from './recent-sync-hook';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from './recent-storage';

const changedEvent = 'rezics-search-history-changed';
type Snapshot = { bucket: string | null; entries: readonly RecentEntry[]; version: number };
/** The delivered local helper owns both Recent and History. Events notify sibling hooks; they hold no store. */
export function useRecentHistory(bucket: string | null, supplied?: RecentSyncAdapter): RecentHistory {
  const currentBucket = useRef(bucket);
  currentBucket.current = bucket;
  const origin = useRef({});
  const [persistent, setPersistent] = useState(true);
  const [storage] = useState(() => createRecentBrowserStorage(setPersistent));
  const [snapshot, setSnapshot] = useState<Snapshot>({ bucket: null, entries: [], version: 0 });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [sync, setSync] = useState<RecentHistory['sync']>('local-only');
  const [failure, setFailure] = useState<RecentHistory['failure']>();
  const [attempt, setAttempt] = useState({ id: 0, reload: false });
  const previousAttempt = useRef(0);
  const publish = useCallback((entries: readonly RecentEntry[], dirty = false) => {
    const bucket = currentBucket.current;
    const next = { bucket, entries, version: latest.current.version + (dirty ? 1 : 0) };
    latest.current = next;
    setSnapshot(next);
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: { bucket, entries, dirty, origin: origin.current } }));
  }, []);
  const native = useRecentSearchSyncAdapter(bucket, publish, storage);
  const client = useQueryClient();
  const installedSession = sessionStateSnapshot(client);
  const owner = useMemo(() => {
    let retired = false;
    return () => {
      // Compare the installed observation, even if a session changed and returned before rendering.
      // Retirement is permanent; matching the account again cannot revive management feedback.
      if (currentBucket.current !== bucket || sessionStateSnapshot(client) !== installedSession) retired = true;
      return !retired;
    };
  }, [bucket, client, installedSession]);
  const adapter = native ? (supplied ?? native) : undefined;
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
      if (observeRecentHistoryStorageEvent(storage, event, bucket)) read();
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
    const requested = previousAttempt.current !== attempt.id;
    previousAttempt.current = attempt.id;
    const run = requested
      ? attempt.reload && owner.retry
        ? owner.retry
        : (owner.refresh ?? adapter.sync)
      : adapter.sync;
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
    owner,
    entries: snapshot.bucket === bucket ? snapshot.entries : [],
    persistence: !bucket ? 'unavailable' : persistent ? 'local' : 'memory',
    sync: adapter ? sync : 'local-only',
    ...(failure ? { failure } : {}),
    remember: (query, scope, languages) =>
      update((entries) => rememberRecent(entries, query, scope, Date.now(), languages)),
    remove: (id) => update(id),
    clear: () => update('clear'),
    retry: () => setAttempt((a) => ({ id: a.id + 1, reload: true })),
  };
}
