import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  recentBucket,
  recentHistoryKey,
  type RecentEntry,
  type RecentStorage,
  type RecentHistoryOwner,
} from './recent-history';
import type { RecentSearchSyncAdapter } from './recent-sync';
import { useRecentSearchOperation } from './recent-host';

/** Session credentials stay in the BFF. The browser supplies only its matching account bucket. */
export function useRecentSearchSyncAdapter(
  bucket: string | null,
  onRemote?: (entries: readonly RecentEntry[]) => void,
  storage?: RecentStorage,
  owner?: RecentHistoryOwner,
): RecentSearchSyncAdapter | undefined {
  const { host, createSyncAdapter } = useRecentSearchOperation();
  const session = useSyncExternalStore(host.observeSession, host.readSession, host.readSession);
  const expected = recentBucket(session.state, session.subject);
  const sessionKey = session.sessionKey;
  const current = useRef({
    bucket,
    expected,
    sessionKey,
    owner,
    storage,
    host,
  });
  current.current = {
    bucket,
    expected,
    sessionKey,
    owner,
    storage,
    host,
  };
  const previous = useRef<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [bound, setBound] = useState<{
    bucket: string;
    sessionKey: string;
    epoch: number;
    storage: RecentStorage;
    host: typeof host;
    anonymous: boolean;
    owner: RecentHistoryOwner | undefined;
    adapter: RecentSearchSyncAdapter;
  }>();
  useLayoutEffect(() => {
    if (owner?.() === false) return;
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
  }, [bucket, expected, owner, session.state, session.subject, storage]);

  useLayoutEffect(() => {
    if (
      session.anonymous ||
      owner?.() === false ||
      !storage ||
      session.state !== 'signed-in' ||
      !session.subject ||
      expected === null ||
      sessionKey === null ||
      bucket !== expected
    ) {
      setBound(undefined);
      return;
    }
    const observationIsCurrent = () =>
      !host.readSession().anonymous &&
      owner?.() !== false &&
      current.current.owner === owner &&
      current.current.host === host &&
      current.current.storage === storage &&
      current.current.bucket === bucket &&
      current.current.expected === expected &&
      current.current.sessionKey === sessionKey &&
      host.readSession().sessionKey === sessionKey;
    let retired = false;
    const adapter = createSyncAdapter({
      accountId: session.subject,
      bucket: expected,
      storage,
      currentBucket: () => (!retired && observationIsCurrent() ? expected : null),
      onRemote: (entries) => {
        if (!retired && observationIsCurrent()) onRemote?.(entries);
      },
    });
    const retire = () => {
      if (retired) return;
      retired = true;
      adapter.dispose();
      setBound((value) => (value?.adapter === adapter ? undefined : value));
      setEpoch((value) => value + 1);
    };
    const unsubscribe = host.observeRetirement(retire);
    if (!observationIsCurrent()) retire();
    else
      setBound({
        bucket,
        sessionKey,
        epoch,
        storage,
        host,
        anonymous: session.anonymous,
        owner,
        adapter,
      });
    return () => {
      unsubscribe();
      if (!retired) {
        retired = true;
        adapter.dispose();
      }
    };
  }, [
    bucket,
    createSyncAdapter,
    epoch,
    expected,
    host,
    owner,
    session.anonymous,
    session.state,
    session.subject,
    sessionKey,
    storage,
  ]);

  const currentSession = host.readSession();
  return currentSession.state === 'signed-in' &&
    !currentSession.anonymous &&
    owner?.() !== false &&
    bucket === expected &&
    sessionKey !== null &&
    currentSession.sessionKey === sessionKey &&
    bound?.bucket === bucket &&
    bound.owner === owner &&
    bound.sessionKey === sessionKey &&
    bound.epoch === epoch &&
    bound.storage === storage &&
    bound.host === host &&
    !bound.anonymous
    ? bound.adapter
    : undefined;
}
