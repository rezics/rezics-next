import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session/query';
import { recentBucket, recentHistoryKey, type RecentEntry, type RecentStorage } from './recent-history';
import { createRecentSearchSyncAdapter, type RecentSearchSyncAdapter } from './recent-sync';

/** Session credentials stay in the BFF. The browser supplies only its matching account bucket. */
export function useRecentSearchSyncAdapter(
  bucket: string | null,
  onRemote?: (entries: readonly RecentEntry[]) => void,
  storage?: RecentStorage,
): RecentSearchSyncAdapter | undefined {
  const session = useSession();
  const expected = recentBucket(session.state, session.subject);
  const current = useRef({ bucket, expected, onRemote });
  current.current = { bucket, expected, onRemote };
  const previous = useRef<string | null>(null);
  const [bound, setBound] = useState<{ bucket: string; adapter: RecentSearchSyncAdapter }>();
  useEffect(() => {
    const old = previous.current;
    previous.current = expected;
    if (old?.startsWith('account:') && old !== expected) storage?.setItem(recentHistoryKey(old), '[]');
    if (session.state === 'signed-out') {
      // Logout may start a fresh document: remove only account data in the sole history namespace.
      try {
        const prefix = recentHistoryKey('account:');
        for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
      } catch {
        /* Memory-only history has no durable native cache. */
      }
    }
    if (!storage || session.state !== 'signed-in' || !session.subject || bucket !== expected) {
      setBound(undefined);
      return;
    }
    const adapter = createRecentSearchSyncAdapter({
      accountId: session.subject,
      bucket: expected!,
      storage,
      currentBucket: () => (current.current.expected === current.current.bucket ? current.current.bucket : null),
      onRemote: (entries) => current.current.onRemote?.(entries),
    });
    setBound({ bucket: expected!, adapter });
    return () => adapter.dispose();
  }, [bucket, expected, session.state, session.subject, storage]);
  return session.state === 'signed-in' && bucket === expected && bound?.bucket === bucket ? bound.adapter : undefined;
}
