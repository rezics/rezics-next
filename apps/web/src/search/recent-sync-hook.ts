import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnonymousSessionContext, useSession } from '../session/query';
import { recentBucket, recentHistoryKey, type RecentEntry, type RecentStorage } from './recent-history';
import { createRecentSearchSyncAdapter, type RecentSearchSyncAdapter } from './recent-sync';
import {
  currentHeaderSearchSession,
  headerSearchSessionKey,
  observeHeaderSearchSession,
} from './header-search/session-key';

/** Session credentials stay in the BFF. The browser supplies only its matching account bucket. */
export function useRecentSearchSyncAdapter(
  bucket: string | null,
  onRemote?: (entries: readonly RecentEntry[]) => void,
  storage?: RecentStorage,
): RecentSearchSyncAdapter | undefined {
  const session = useSession();
  const client = useContext(QueryClientContext);
  const anonymous = useContext(AnonymousSessionContext);
  const expected = recentBucket(session.state, session.subject);
  const sessionKey = headerSearchSessionKey(session);
  const current = useRef({ bucket, expected, sessionKey, onRemote, storage, client, anonymous });
  current.current = { bucket, expected, sessionKey, onRemote, storage, client, anonymous };
  const previous = useRef<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [bound, setBound] = useState<{
    bucket: string;
    sessionKey: string;
    epoch: number;
    storage: RecentStorage;
    client: typeof client;
    anonymous: boolean;
    adapter: RecentSearchSyncAdapter;
  }>();
  useEffect(() => {
    const old = previous.current;
    previous.current = expected;
    if (old?.startsWith('account:') && old !== expected) storage?.setItem(recentHistoryKey(old), '[]');
    if (session.state === 'signed-out' || session.state === 'signed-in') {
      // Retire the removed native store without migrating it. Logout also clears account history across documents.
      try {
        const prefix = recentHistoryKey('account:');
        for (const key of Object.keys(localStorage))
          if ((session.state === 'signed-out' && key.startsWith(prefix)) || key.startsWith('rezics:recent:v1:'))
            localStorage.removeItem(key);
      } catch {
        /* Memory-only history has no durable native cache. */
      }
    }
  }, [bucket, expected, session.state, session.subject, storage]);

  useLayoutEffect(() => {
    if (
      anonymous ||
      !client ||
      !storage ||
      session.state !== 'signed-in' ||
      !session.subject ||
      sessionKey === null ||
      bucket !== expected
    ) {
      setBound(undefined);
      return;
    }
    const observationIsCurrent = () =>
      !anonymous &&
      current.current.client === client &&
      current.current.storage === storage &&
      current.current.bucket === bucket &&
      current.current.expected === expected &&
      current.current.sessionKey === sessionKey &&
      headerSearchSessionKey(currentHeaderSearchSession(client)) === sessionKey;
    let retired = false;
    const adapter = createRecentSearchSyncAdapter({
      accountId: session.subject,
      bucket: expected,
      storage,
      currentBucket: () => (!retired && observationIsCurrent() ? expected : null),
      onRemote: (entries) => {
        if (!retired && observationIsCurrent()) current.current.onRemote?.(entries);
      },
    });
    const retire = () => {
      if (retired) return;
      retired = true;
      adapter.dispose();
      setBound((value) => (value?.adapter === adapter ? undefined : value));
      setEpoch((value) => value + 1);
    };
    const unsubscribe = observeHeaderSearchSession(client, retire);
    if (!observationIsCurrent()) retire();
    else setBound({ bucket, sessionKey, epoch, storage, client, anonymous, adapter });
    return () => {
      unsubscribe();
      if (!retired) {
        retired = true;
        adapter.dispose();
      }
    };
  }, [anonymous, bucket, client, epoch, expected, session.state, session.subject, sessionKey, storage]);

  return session.state === 'signed-in' &&
    !anonymous &&
    client &&
    bucket === expected &&
    sessionKey !== null &&
    headerSearchSessionKey(currentHeaderSearchSession(client)) === sessionKey &&
    bound?.bucket === bucket &&
    bound.sessionKey === sessionKey &&
    bound.epoch === epoch &&
    bound.storage === storage &&
    bound.client === client &&
    !bound.anonymous
    ? bound.adapter
    : undefined;
}
