import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext, useRef, useState } from 'react';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { getLocale } from '../paraglide/runtime.js';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  type HistoryOrigin,
} from './history-current-origin';
import { readCurrentFollowState, readFollowState, setFollow } from './follow-actions';
import { FollowControl } from './follow-control';
import type { FollowState, FollowWriteInput } from './follow-records';
import { refreshFollowing } from './mine-following-refresh';

type FollowLifetime = {
  key: string;
  isCurrent: () => boolean;
  accepted?: boolean;
  data?: FollowState;
  epoch?: number | undefined;
};

/** The two-argument compatibility query remains a pure state read. Production supplies current admission. */
export const followStateQuery = (subject: string | null, targetId: string, lifetime?: FollowLifetime) =>
  queryOptions({
    ...personalRead,
    queryKey: ['follow-state', subject, targetId, ...(lifetime ? [lifetime.key] : [])],
    queryFn: async ({ signal }): Promise<FollowState> => {
      signal.throwIfAborted();
      if (lifetime) {
        assertHistoryCurrent(() => !!subject && lifetime.isCurrent(), signal);
        lifetime.accepted = false;
        let page;
        try {
          page = await readCurrentFollowState({ data: { targetId } });
          assertHistoryCurrent(lifetime.isCurrent, signal);
        } catch (error) {
          assertHistoryCurrent(lifetime.isCurrent, signal);
          throw error;
        }
        if (page.subject !== subject || page.targetId !== targetId)
          return page.subject === null && page.edge.state !== 'ready' ? page.edge : { state: 'unavailable' };
        lifetime.accepted = true;
        lifetime.data = page.edge;
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

const followOperations = ['follow.get', 'follow.put', 'follow.delete'] as const;

/** Supplied edges retain their parent's authority; unsupplied targets use one current BASIC edge read. */
export function FollowTargetControl({
  targetId,
  following,
  idempotencyKey,
  menuTitle,
  onRemoved,
  onReview,
  disabled = false,
  origin: parent,
}: {
  targetId: string;
  following?: boolean | null;
  idempotencyKey?: string;
  menuTitle?: string;
  onRemoved?: () => void;
  /** Supplied rows review only through their existing current list reader. */
  onReview?: (() => Promise<FollowState | null>) | undefined;
  /** Retained rows can show recovery while their list read is unavailable. */
  disabled?: boolean;
  /** Supplied owner rows retain their actual reader and mounted address. */
  origin?: HistoryOrigin;
}) {
  const canFollow = useOperation('follow.put');
  const canRemove = useOperation('follow.delete');
  const canRead = useOperation('follow.get');
  const address = useHistoryAddress(null, undefined, getLocale());
  const origin = useHistoryCurrentOrigin(JSON.stringify([address.key, targetId]), followOperations, null, parent, [
    canRead,
    canFollow,
    canRemove,
  ]);
  // A refreshed session may reauthorize a retry, but cannot replace its original transport.
  const commands = useRef(new WeakMap<FollowWriteInput, { token: string; send: typeof setFollow }>()).current;
  const viewer = origin.subject;
  const identity = origin.boundary.id;
  const [readGeneration, setReadGeneration] = useState(0);
  const readRef = useRef<FollowLifetime | null>(null);
  const readKey = JSON.stringify([origin.lifetime(0), readGeneration, following === undefined]);
  if (readRef.current?.key !== readKey || readRef.current.epoch !== origin.epoch(0)) {
    const previous = readRef.current;
    const lifetime: FollowLifetime = {
      key: readKey,
      epoch: origin.epoch(0),
      ...(previous?.key === readKey ? { accepted: previous.accepted, data: previous.data } : {}),
      isCurrent: () => readRef.current === lifetime && address.isCurrent() && origin.current(0),
    };
    readRef.current = lifetime;
  }
  const readLifetime = readRef.current;
  const queryClient = useContext(QueryClientContext) ?? previewClient;
  const options = followStateQuery(viewer, targetId, readLifetime);
  const read = useQuery(
    {
      ...options,
      enabled:
        personalRead.enabled &&
        origin.authoritative &&
        following === undefined &&
        !!viewer &&
        origin.allowed[0] === true &&
        address.isCurrent(),
    },
    queryClient,
  );
  if (viewer === null || (!origin.retained[1] && !origin.retained[2])) return null;
  const initial: FollowState =
    following !== undefined
      ? following === null
        ? { state: 'unavailable' }
        : { state: 'ready', following }
      : !canRead || !origin.allowed[0]
        ? { state: 'forbidden' }
        : read.isPending || read.isFetching
          ? { state: 'pending' }
          : read.isError
            ? { state: 'unavailable' }
            : read.data?.state === 'signed-out'
              ? { state: 'unavailable' }
              : (read.data ?? { state: 'unavailable' });
  const acceptedRead = () =>
    readLifetime.accepted === true &&
    queryClient.getQueryState(options.queryKey)?.status === 'success' &&
    queryClient.getQueryData(options.queryKey) === readLifetime.data;
  const isCurrent = (next: boolean) =>
    address.isCurrent() && origin.current(next ? 1 : 2) && (following !== undefined || !next || acceptedRead());
  return (
    <span hidden={!canFollow && !canRemove}>
      <FollowControl
        key={identity}
        targetId={targetId}
        initial={initial}
        readLifetime={following === undefined ? readLifetime.key : identity}
        isCurrent={isCurrent}
        canFollow={origin.retained[1] === true && !onRemoved}
        canRemove={origin.retained[2] === true}
        ready={!disabled && (origin.allowed[1] === true || origin.allowed[2] === true)}
        {...(idempotencyKey ? { idempotencyKey } : {})}
        {...(menuTitle ? { menuTitle } : {})}
        {...(following !== undefined
          ? onReview
            ? { onReview }
            : {}
          : canRead && origin.allowed[0]
            ? {
                onReview: async () => {
                  if (!readLifetime.isCurrent()) return null;
                  const result = await read.refetch();
                  return readLifetime.isCurrent() && !result.isError && acceptedRead() ? (result.data ?? null) : null;
                },
              }
            : {})}
        {...(following === undefined && canRead && origin.allowed[0]
          ? {
              onRetry: () => {
                if (readLifetime.isCurrent()) setReadGeneration((generation) => generation + 1);
              },
            }
          : {})}
        write={(input) => {
          if (!isCurrent(input.following)) return Promise.resolve({ ok: false, reason: 'unavailable' });
          let command = commands.get(input);
          if (!command) {
            const token = origin.credential(input.following ? 1 : 2);
            if (!token) return Promise.resolve({ ok: false, reason: 'unavailable' });
            command = { token, send: setFollow };
            commands.set(input, command);
          }
          return command.send({ data: input, headers: { 'X-CSRF-Token': command.token } });
        }}
        onAccepted={(next, input) => {
          if (!isCurrent(input.following)) return false;
          // A write retains its originating read. Read retirement alone does not cancel an admitted DELETE.
          // The command itself supplies the own-edge result when GET failed. A
          // replacement read or revoked read admission still cannot inherit it.
          const reconcile = following !== undefined || readLifetime.isCurrent();
          if (readLifetime?.isCurrent()) {
            void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
            if (!isCurrent(input.following)) return false;
            const data = queryClient.setQueryData<FollowState>(options.queryKey, (): FollowState =>
              reconcile ? { state: 'ready', following: next } : { state: 'unavailable' },
            );
            // Query structural sharing can preserve an existing object. Keep the actual
            // cache identity so our own successful write does not revoke its reader.
            if (data) {
              readLifetime.data = data;
              readLifetime.accepted = reconcile;
            }
          }
          if (reconcile && isCurrent(input.following)) {
            queryClient.setQueryData<FollowState>(followStateQuery(viewer, targetId).queryKey, (): FollowState => ({
              state: 'ready',
              following: next,
            }));
          }
          if (!next && isCurrent(input.following)) onRemoved?.();
          if (viewer && isCurrent(input.following)) refreshFollowing(queryClient, viewer, !!onRemoved);
          return reconcile;
        }}
      />
    </span>
  );
}
