import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RECENT_HISTORY_CHANGED, RECENT_QUEUE_LIMIT, RecentSyncError } from './recent-contract';
import {
  readRecentDocument,
  rememberRecent,
  writeRecentDocument,
  recentBucket,
  type RecentEntry,
  type RecentHistory,
  type RecentHistoryOwner,
  type RecentSyncAdapter,
} from './recent-history';
import type { RecentSearchSyncAdapter } from './recent-sync';
import { useRecentSearchSyncAdapter } from './recent-sync-hook';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from './recent-storage';
import { useRecentSearchOperation } from './recent-host';

type Snapshot = {
  owner?: RecentHistoryOwner;
  bucket: string | null;
  entries: readonly RecentEntry[];
  version: number;
};
/** The delivered local helper owns both Recent and History. Events notify sibling hooks; they hold no store. */
export function useRecentHistory(bucket: string | null, supplied?: RecentSyncAdapter): RecentHistory {
  const { host } = useRecentSearchOperation();
  const session = useSyncExternalStore(host.observeSession, host.readSession, host.readSession);
  const currentBucket = useRef(bucket);
  currentBucket.current = bucket;
  const installedSession = session.incarnation;
  const installedOwner = useRef<RecentHistoryOwner | undefined>(undefined);
  const mounted = useRef(true);
  const owner = useMemo(() => {
    let retired = false;
    const isCurrent = () => {
      // Cache identity sees replacements before React renders, including equal-account and A/B/A changes.
      // Comparing the installed command owner also permanently retires replaced bucket/render closures.
      if (
        !mounted.current ||
        installedOwner.current !== isCurrent ||
        currentBucket.current !== bucket ||
        host.readSession().incarnation !== installedSession
      )
        retired = true;
      return !retired;
    };
    return isCurrent;
  }, [bucket, host, installedSession]);
  installedOwner.current = owner;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const origin = useRef({});
  const [persistent, setPersistent] = useState(true);
  const [storage] = useState(() => createRecentBrowserStorage(setPersistent));
  const [snapshot, setSnapshot] = useState<Snapshot>({
    bucket: null,
    entries: [],
    version: 0,
  });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [outcome, setOutcome] = useState<{
    owner?: RecentHistoryOwner;
    sync: RecentHistory['sync'];
    failure?: RecentHistory['failure'];
  }>({ sync: 'local-only' });
  const [attempt, setAttempt] = useState<{ owner?: RecentHistoryOwner; id: number; reload: boolean }>({
    id: 0,
    reload: false,
  });
  const previousAttempt = useRef(attempt);
  const publish = useCallback(
    (entries: readonly RecentEntry[], dirty = false) => {
      if (!owner()) return;
      const next = {
        owner,
        bucket,
        entries,
        version: latest.current.version + (dirty ? 1 : 0),
      };
      latest.current = next;
      setSnapshot(next);
      window.dispatchEvent(
        new CustomEvent(RECENT_HISTORY_CHANGED, {
          detail: { bucket, entries, dirty, owner, origin: origin.current },
        }),
      );
    },
    [bucket, owner],
  );
  const native = useRecentSearchSyncAdapter(bucket, publish, storage, owner);
  const adapter = native ? (supplied ?? native) : undefined;
  useEffect(() => {
    const read = () => {
      if (!owner()) return;
      const entries = bucket ? readRecentDocument(storage, bucket).entries : [];
      const next = {
        owner,
        bucket,
        entries,
        version: latest.current.version + 1,
      };
      latest.current = next;
      setSnapshot(next);
    };
    read();
    if (!owner()) return;
    setOutcome({ owner, sync: 'local-only' });
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (owner() && detail.owner() && detail.origin !== origin.current && detail.bucket === bucket) {
        const next = {
          owner,
          bucket,
          entries: detail.entries,
          version: latest.current.version + (detail.dirty ? 1 : 0),
        };
        latest.current = next;
        setSnapshot(next);
      }
    };
    const stored = (event: StorageEvent) => {
      if (owner() && observeRecentHistoryStorageEvent(storage, event, bucket)) read();
    };
    const refresh = () => {
      if (owner()) setAttempt((a) => (owner() ? { owner, id: a.id + 1, reload: false } : a));
    };
    window.addEventListener(RECENT_HISTORY_CHANGED, changed);
    const stopStorage = host.observeStorage(stored);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(RECENT_HISTORY_CHANGED, changed);
      stopStorage();
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [bucket, host, owner, storage]);
  useEffect(() => {
    if (!owner()) return;
    if (!bucket || latest.current.bucket !== bucket || !adapter) {
      setOutcome({ owner, sync: 'local-only' });
      return;
    }
    const abort = new AbortController();
    setOutcome((last) => ({
      owner,
      sync: 'pending',
      failure: last.owner === owner ? last.failure : undefined,
    }));
    const native = adapter as Partial<RecentSearchSyncAdapter>;
    const requested = attempt.owner === owner && previousAttempt.current !== attempt;
    previousAttempt.current = attempt;
    const run = requested
      ? attempt.reload && native.retry
        ? native.retry
        : (native.refresh ?? adapter.sync)
      : adapter.sync;
    void run(latest.current.entries, abort.signal).then(
      () => {
        if (!abort.signal.aborted && owner()) {
          setOutcome({ owner, sync: 'synced' });
        }
      },
      (error) => {
        if (!abort.signal.aborted && owner())
          setOutcome({
            owner,
            sync: 'pending',
            failure: error instanceof RecentSyncError ? error.code : 'unavailable',
          });
      },
    );
    return () => abort.abort();
  }, [bucket, owner, snapshot.bucket, snapshot.version, adapter, attempt]);
  const update = (change: 'clear' | string | ((entries: readonly RecentEntry[]) => RecentEntry[])) => {
    if (!bucket || !owner()) return;
    const document = readRecentDocument(storage, bucket);
    // Keep current owner hydration in memory; it is deliberately absent from durable browser history.
    const entries = latest.current.owner === owner ? latest.current.entries : document.entries;
    if (change === 'clear') {
      document.entries = [];
      document.clear = host.createId();
      document.removed = [];
    } else if (typeof change === 'string') {
      if (!entries.some((e) => e.id === change)) return;
      if (document.removed.length >= RECENT_QUEUE_LIMIT) {
        setOutcome((last) => ({ ...last, owner, failure: 'unavailable' }));
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
    entries: snapshot.owner === owner ? snapshot.entries : [],
    persistence: !bucket ? 'unavailable' : persistent ? 'local' : 'memory',
    sync: adapter && outcome.owner === owner ? outcome.sync : 'local-only',
    ...(outcome.owner === owner && outcome.failure ? { failure: outcome.failure } : {}),
    remember: (query, scope, languages) =>
      update((entries) => rememberRecent(entries, query, scope, host.now(), languages)),
    remove: (id) => update(id),
    clear: () => update('clear'),
    retry: () => {
      if (owner()) setAttempt((a) => (owner() ? { owner, id: a.id + 1, reload: true } : a));
    },
  };
}

export function useRecentSearches(): RecentHistory {
  const { host } = useRecentSearchOperation();
  const session = useSyncExternalStore(host.observeSession, host.readSession, host.readSession);
  return useRecentHistory(recentBucket(session.state, session.subject));
}
