import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { readFollowState, setFollow } from './follow-actions';
import { FollowControl } from './follow-control';
import type { FollowState } from './follow-records';

export const followStateQuery = (targetId: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['follow-state', targetId],
    queryFn: () => readFollowState({ data: { targetId } }),
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
  const { state: session, csrfToken } = useSession();
  const canFollow = useOperation('follow.put');
  const canRemove = useOperation('follow.delete');
  const canRead = useOperation('follow.get');
  const queryClient = useContext(QueryClientContext) ?? previewClient;
  const read = useQuery(
    {
      ...followStateQuery(targetId),
      enabled: personalRead.enabled && session === 'signed-in' && canRead && following === undefined,
    },
    queryClient,
  );
  if (session !== 'signed-in' || (!canFollow && !canRemove)) return null;
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
      key={targetId}
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
        queryClient.setQueryData<FollowState>(followStateQuery(targetId).queryKey, (): FollowState => ({
          state: 'ready',
          following: next,
        }));
        if (!next) onRemoved?.();
      }}
    />
  );
}
