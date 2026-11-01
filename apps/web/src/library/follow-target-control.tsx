import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { readCurrentFollowState, readFollowState, setFollow } from './follow-actions';
import { FollowControl } from './follow-control';
import type { FollowState } from './follow-records';

type FollowLifetime = { key: string; isCurrent: () => boolean; accepted?: boolean };

/** The two-argument compatibility query remains a pure state read. Production supplies current admission. */
export const followStateQuery = (subject: string | null, targetId: string, lifetime?: FollowLifetime) =>
  queryOptions({
    ...personalRead,
    queryKey: ['follow-state', subject, targetId, ...(lifetime ? [lifetime.key] : [])],
    queryFn: async ({ signal }): Promise<FollowState> => {
      signal.throwIfAborted();
      if (lifetime) {
        if (!subject || !lifetime.isCurrent()) return { state: 'unavailable' };
        const page = await readCurrentFollowState({ data: { targetId } });
        signal.throwIfAborted();
        if (!lifetime.isCurrent()) return { state: 'unavailable' };
        if (page.subject !== subject || page.targetId !== targetId)
          return page.subject === null && page.edge.state !== 'ready' ? page.edge : { state: 'unavailable' };
        lifetime.accepted = true;
        return page.edge;
      }
      const state = await readFollowState({ data: { targetId } });
      signal.throwIfAborted();
      return state;
    },
    ...(lifetime ? { gcTime: 0, staleTime: Infinity, refetchOnMount: false as const } : {}),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
const previewClient = new QueryClient();

/** Observed ABA creates a new entry; only a committed, mounted lifetime can dispatch or accept work. */
function useFollowLifetime(identity: string | null): FollowLifetime | null {
  const committed = useRef<FollowLifetime | null>(null);
  const create = () => {
    if (identity === null) return { identity, lifetime: null };
    const lifetime: FollowLifetime = {
      key: crypto.randomUUID(),
      isCurrent: () => committed.current === lifetime,
    };
    return { identity, lifetime };
  };
  const [observed, setObserved] = useState(create);
  let current = observed;
  if (observed.identity !== identity) {
    current = create();
    setObserved(current);
  }
  const lifetime = current.lifetime;
  useLayoutEffect(() => {
    committed.current = lifetime;
    return () => {
      committed.current = null;
    };
  }, [lifetime]);
  return lifetime;
}

/** Supplied edges retain their parent's authority; unsupplied targets use one current BASIC edge read. */
export function FollowTargetControl({
  targetId,
  following,
  idempotencyKey,
  menuTitle,
  onRemoved,
}: {
  targetId: string;
  following?: boolean | null;
  idempotencyKey?: string;
  menuTitle?: string;
  onRemoved?: () => void;
}) {
  const { state: session, csrfToken, subject } = useSession();
  const viewer = session === 'signed-in' && subject ? subject : null;
  const canFollow = useOperation('follow.put');
  const canRemove = useOperation('follow.delete');
  const canRead = useOperation('follow.get');
  const identity = viewer ? JSON.stringify([viewer, targetId]) : null;
  const readLifetime = useFollowLifetime(identity && canRead && following === undefined ? identity : null);
  const putLifetime = useFollowLifetime(identity && csrfToken && canFollow && !onRemoved ? identity : null);
  const deleteLifetime = useFollowLifetime(identity && csrfToken && canRemove ? identity : null);
  const removedCallback = useRef(onRemoved);
  useLayoutEffect(() => {
    removedCallback.current = onRemoved;
  });
  const queryClient = useContext(QueryClientContext) ?? previewClient;
  const options = followStateQuery(viewer, targetId, readLifetime ?? undefined);
  const read = useQuery({ ...options, enabled: personalRead.enabled && readLifetime !== null }, queryClient);
  if (viewer === null || (!canFollow && !canRemove)) return null;
  const initial: FollowState =
    following !== undefined
      ? following === null
        ? { state: 'unavailable' }
        : { state: 'ready', following }
      : !canRead
        ? { state: 'forbidden' }
        : read.isPending
          ? { state: 'pending' }
          : read.isError
            ? { state: 'unavailable' }
            : (read.data ?? { state: 'unavailable' });
  const isCurrent = (next: boolean) => (next ? putLifetime : deleteLifetime)?.isCurrent() ?? false;
  const acceptedOrigin = following !== undefined || readLifetime?.accepted === true;
  return (
    <FollowControl
      key={identity}
      targetId={targetId}
      initial={initial}
      readLifetime={following === undefined ? (readLifetime?.key ?? null) : 'supplied'}
      isCurrent={isCurrent}
      canFollow={canFollow && !onRemoved}
      canRemove={canRemove}
      ready={!!csrfToken}
      {...(idempotencyKey ? { idempotencyKey } : {})}
      {...(menuTitle ? { menuTitle } : {})}
      {...(readLifetime
        ? {
            onRetry: () => {
              if (readLifetime.isCurrent()) void read.refetch();
            },
          }
        : {})}
      write={(input) =>
        isCurrent(input.following)
          ? setFollow({ data: input, headers: { 'X-CSRF-Token': csrfToken ?? '' } })
          : Promise.resolve({ ok: false, reason: 'unavailable' })
      }
      onAccepted={(next, input) => {
        if (!isCurrent(input.following)) return false;
        // A write retains its originating read. Read retirement alone does not cancel an admitted DELETE.
        const reconcile = acceptedOrigin && (following !== undefined || readLifetime?.isCurrent() === true);
        if (readLifetime?.isCurrent()) {
          void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
          queryClient.setQueryData<FollowState>(
            options.queryKey,
            reconcile ? { state: 'ready', following: next } : { state: 'unavailable' },
          );
        }
        if (reconcile) {
          queryClient.setQueryData<FollowState>(followStateQuery(viewer, targetId).queryKey, {
            state: 'ready',
            following: next,
          });
        }
        if (!next) removedCallback.current?.();
        return reconcile;
      }}
    />
  );
}
