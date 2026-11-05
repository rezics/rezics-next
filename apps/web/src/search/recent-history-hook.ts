import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionStateSnapshot } from '../session/browser-state';
import {
  readRecentDocument,
  rememberRecent,
  writeRecentDocument,
  type RecentEntry,
  type RecentHistory,
  type RecentHistoryOwner,
  type RecentSyncAdapter,
} from './recent-history';
import { RecentSyncError, type RecentSearchSyncAdapter } from './recent-sync';
import { useRecentSearchSyncAdapter } from './recent-sync-hook';
import { createRecentBrowserStorage, observeRecentHistoryStorageEvent } from './recent-storage';

const changedEvent = 'rezics-search-history-changed';
type Snapshot = {
  owner?: RecentHistoryOwner;
  bucket: string | null;
  entries: readonly RecentEntry[];
  version: number;
};
/** The delivered local helper owns both Recent and History. Events notify sibling hooks; they hold no store. */
export function useRecentHistory(bucket: string | null, supplied?: RecentSyncAdapter): RecentHistory {
  const currentBucket = useRef(bucket);
  currentBucket.current = bucket;
  const client = useQueryClient();
  const installedSession = sessionStateSnapshot(client);
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
        sessionStateSnapshot(client) !== installedSession
      )
        retired = true;
      return !retired;
    };
    return isCurrent;
  }, [bucket, client, installedSession]);
  installedOwner.current = owner;
  useEffect(() => {
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
  const [attempt, setAttempt] = useState({ id: 0, reload: false });
  const previousAttempt = useRef(0);
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
        new CustomEvent(changedEvent, {
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
      if (owner()) setAttempt((a) => (owner() ? { id: a.id + 1, reload: false } : a));
    };
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
  }, [bucket, owner, storage]);
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
    const requested = previousAttempt.current !== attempt.id;
    previousAttempt.current = attempt.id;
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
      document.clear = crypto.randomUUID();
      document.removed = [];
    } else if (typeof change === 'string') {
      if (!entries.some((e) => e.id === change)) return;
      if (document.removed.length >= 100) {
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
      update((entries) => rememberRecent(entries, query, scope, Date.now(), languages)),
    remove: (id) => update(id),
    clear: () => update('clear'),
    retry: () => {
      if (owner()) setAttempt((a) => (owner() ? { id: a.id + 1, reload: true } : a));
    },
  };
}
