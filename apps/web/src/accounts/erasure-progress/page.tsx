import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { sessionQuery, useSession } from '../../session/query';
import { routedId } from '../resource-access/data';
import { readAccountErasure } from './actions';
import { ErasureProgressView } from './view';
import { ErasureReader } from './reader';

const serverSessionRead = () => undefined;

export function AccountErasurePage({ accountId }: { accountId: string }) {
  const session = useSession();
  const client = useQueryClient();
  const location = useLocation();
  const subscribe = useCallback(
    (changed: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.length === 1 && event.query.queryKey[0] === sessionQuery.queryKey[0]) changed();
      }),
    [client],
  );
  // Observe the existing query without another initial read. Errors can have no session data at all.
  const sessionRead = useSyncExternalStore(
    subscribe,
    () => client.getQueryState(sessionQuery.queryKey),
    serverSessionRead,
  );
  const reading = sessionRead?.fetchStatus !== undefined && sessionRead.fetchStatus !== 'idle';
  const failed = sessionRead?.status === 'error';
  const returnTo = location.publicHref;
  const viewerId = session.state === 'signed-in' && routedId(session.subject) ? session.subject : null;
  const binding = sessionRead?.data;
  const current =
    !reading &&
    !failed &&
    sessionRead?.status === 'success' &&
    routedId(accountId) &&
    viewerId !== null &&
    binding?.state === 'signed-in' &&
    binding.subject === viewerId;
  const unavailable = failed || session.state === 'unavailable' || (session.state === 'signed-in' && !current);
  return current ? (
    <BoundErasure
      key={`${accountId}:${viewerId}:${sessionRead.dataUpdateCount}:${sessionRead.errorUpdateCount}`}
      accountId={accountId}
      viewerId={viewerId}
      binding={binding}
      returnTo={returnTo}
    />
  ) : (
    <ErasureProgressView
      page={{
        status: reading
          ? 'loading'
          : unavailable
            ? 'unavailable'
            : session.state === 'signed-out'
              ? 'signed-out'
              : 'loading',
      }}
      returnTo={returnTo}
      sessionRecovery={unavailable || reading}
      reload={
        unavailable || reading
          ? () => {
              // Infinity freshness must not turn this deliberate retry into a cached unavailable result.
              // fetchQuery shares any in-flight session discovery; it never retries cleanup work.
              void client.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => {});
            }
          : undefined
      }
    />
  );
}
function BoundErasure({
  accountId,
  viewerId,
  binding,
  returnTo,
}: {
  accountId: string;
  viewerId: string;
  binding: NonNullable<ReturnType<typeof useSession>>;
  returnTo: string;
}) {
  const client = useQueryClient();
  const active = useRef(false);
  const [reader] = useState(
    () =>
      new ErasureReader(
        { accountId, viewerId },
        () => readAccountErasure({ data: { accountId, viewerId } }),
        () => {
          const read = client.getQueryState(sessionQuery.queryKey);
          return active.current && read?.status === 'success' && read.fetchStatus === 'idle' && read.data === binding;
        },
      ),
  );
  useEffect(() => {
    active.current = true;
    // Invalidate immediately, including a session loss and recovery batched into one React render.
    const unsubscribe = client.getQueryCache().subscribe(() => reader.clearIfStale());
    void reader.reload();
    return () => {
      active.current = false;
      unsubscribe();
      reader.clear();
    };
  }, [client, reader]);
  const page = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  return <ErasureProgressView page={page} returnTo={returnTo} reload={() => void reader.reload()} />;
}
