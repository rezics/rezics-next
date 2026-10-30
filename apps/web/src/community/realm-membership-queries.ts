import { queryOptions } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import type { loadRealmMembership } from './space';

export type RealmViewer = Awaited<ReturnType<typeof loadRealmMembership>>;

export const realmMembershipQuery = (realmId: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['realm-membership', realmId],
    queryFn: async () => {
      const { readRealmMembership } = await import('./realm-membership-actions');
      return readRealmMembership({ data: { realmId } });
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export const myRealmsQuery = (cursor?: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['my-realms', cursor ?? ''],
    queryFn: async () => {
      const { readMyRealmsPage } = await import('./space-actions');
      return readMyRealmsPage({ data: cursor ? { cursor } : {} });
    },
    retry: false,
  });

export type MembershipRefresh =
  | { kind: 'settled' | 'denied'; viewer: RealmViewer }
  | { kind: 'pending' | 'unavailable' | 'cancelled' };

const refreshDelays = [0, 500, 1500, 3000] as const;

/** Four current-standing reads per refresh, never a workflow-status request or a command retry. */
export async function refreshRealmMembership(
  read: () => Promise<RealmViewer | null>,
  target: 'member' | 'none' | undefined,
  options: { signal?: AbortSignal; pause?: (ms: number) => Promise<void> } = {},
): Promise<MembershipRefresh> {
  let last: 'pending' | 'unavailable' = 'pending';
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const delay of refreshDelays) {
    if (options.signal?.aborted) return { kind: 'cancelled' };
    if (delay) await pause(delay);
    if (options.signal?.aborted) return { kind: 'cancelled' };
    try {
      const viewer = await read();
      if (options.signal?.aborted) return { kind: 'cancelled' };
      if (!viewer) last = 'unavailable';
      else if (viewer.state === 'banned') return { kind: 'denied', viewer };
      else if (viewer.state !== 'pending' && (target === undefined || viewer.state === target))
        return { kind: 'settled', viewer };
      else last = 'pending';
    } catch {
      last = 'unavailable';
    }
  }
  return { kind: last };
}
