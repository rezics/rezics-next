import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { readFollowState, setFollow } from './follow-actions';
import { FollowControl } from './follow-control';
import type { FollowState } from './follow-records';

export const followStateQuery = (subject: string | null, targetId: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['follow-state', subject, targetId],
    queryFn: async ({ signal }) => {
      const state = await readFollowState({ data: { targetId } });
      // Consume cancellation so a retired observer cannot publish its late private read.
      signal.throwIfAborted();
      return state;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
const previewClient = new QueryClient();

/** Collection and Following callers supply their existing private read; other pages share one keyed edge read. */
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
  const readViewer = canRead && following === undefined ? viewer : null;
  const queryClient = useContext(QueryClientContext) ?? previewClient;
  const read = useQuery(
    {
      ...followStateQuery(readViewer, targetId),
      enabled: personalRead.enabled && readViewer !== null,
    },
    queryClient,
  );
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
          : (read.data ?? { state: 'unavailable' });
  return (
    <FollowControl
      key={JSON.stringify([viewer, targetId])}
      targetId={targetId}
      initial={initial}
      canFollow={canFollow && !onRemoved}
      canRemove={canRemove}
      ready={!!csrfToken}
      {...(idempotencyKey ? { idempotencyKey } : {})}
      {...(menuTitle ? { menuTitle } : {})}
      {...(following === undefined && canRead ? { onRetry: () => void read.refetch() } : {})}
      write={(input) => setFollow({ data: input, headers: { 'X-CSRF-Token': csrfToken ?? '' } })}
      onChange={(next) => {
        queryClient.setQueryData<FollowState>(followStateQuery(viewer, targetId).queryKey, (): FollowState => ({
          state: 'ready',
          following: next,
        }));
        if (!next) onRemoved?.();
      }}
    />
  );
}
