import { useEffect, useState } from 'react';
import {
  readRecentHistory,
  rememberRecent,
  writeRecentHistory,
  type RecentEntry,
  type RecentHistory,
  type RecentSyncAdapter,
} from './recent-history';

export function useRecentHistory(bucket: string | null, adapter?: RecentSyncAdapter): RecentHistory {
  const [snapshot, setSnapshot] = useState<{
    bucket: string | null;
    entries: RecentEntry[];
    persistence: 'local' | 'memory';
  }>({ bucket: null, entries: [], persistence: 'local' });
  const [sync, setSync] = useState<RecentHistory['sync']>('local-only');
  // The render guard clears the old account immediately, before this effect can read the next bucket.
  const entries = snapshot.bucket === bucket ? snapshot.entries : [];
  useEffect(() => {
    if (!bucket) {
      setSnapshot({ bucket, entries: [], persistence: 'local' });
      return;
    }
    const read = () => {
      try {
        setSnapshot({ bucket, entries: readRecentHistory(localStorage, bucket), persistence: 'local' });
      } catch {
        setSnapshot({ bucket, entries: [], persistence: 'memory' });
      }
    };
    read();
    const changed = (event: StorageEvent) => {
      if (event.storageArea === localStorage) read();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [bucket]);
  useEffect(() => {
    if (!bucket || snapshot.bucket !== bucket || !adapter) {
      setSync('local-only');
      return;
    }
    const abort = new AbortController();
    setSync('pending');
    void adapter.sync(snapshot.entries, abort.signal).then(
      () => {
        if (!abort.signal.aborted) setSync('synced');
      },
      () => {
        /* Local changes remain pending until the owner transport accepts them. */
      },
    );
    return () => abort.abort();
  }, [bucket, snapshot, adapter]);
  const update = (change: (entries: readonly RecentEntry[]) => RecentEntry[]) => {
    if (!bucket) return;
    setSnapshot((previous) => {
      const next = change(previous.bucket === bucket ? previous.entries : []);
      let persisted = false;
      try {
        persisted = writeRecentHistory(localStorage, bucket, next);
      } catch {}
      return { bucket, entries: next, persistence: persisted ? 'local' : 'memory' };
    });
  };
  return {
    entries,
    persistence: bucket ? snapshot.persistence : 'unavailable',
    sync: adapter ? sync : 'local-only',
    remember: (query, scope) => update((entries) => rememberRecent(entries, query, scope)),
    remove: (id) => update((entries) => entries.filter((entry) => entry.id !== id)),
  };
}
