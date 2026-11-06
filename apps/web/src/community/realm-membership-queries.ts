import { queryOptions } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import {
  beginRealmMembershipRead,
  recordRealmMembershipRead,
  type RealmMembershipCaller,
} from './realm-membership-lifetime';
import type { loadRealmMembership } from './space';
import { beginMyRealmsRead, captureMyRealmsCaller, type MyRealmsCaller } from './my-realms-caller';
import { getLocale } from '../paraglide/runtime.js';

export type RealmViewer = Awaited<ReturnType<typeof loadRealmMembership>>;

/** RealmMembership and BoardStartThread share standing only for the same known session subject. */
export const realmMembershipQuery = (realmId: string, subject: string | null, caller?: RealmMembershipCaller) =>
  queryOptions({
    ...personalRead,
    enabled: (personalRead.enabled || typeof window !== 'undefined') && !!subject && (!caller || caller.isReady()),
    queryKey: ['realm-membership', realmId, subject],
    queryFn: async (context) => {
      if (!caller) {
        const { readRealmMembership } = await import('./realm-membership-actions');
        return readRealmMembership({ data: { realmId } });
      }
      if (caller.realmId !== realmId || caller.subject !== subject) throw new Error('Realm membership caller mismatch');
      const operation = beginRealmMembershipRead(caller, context.signal, ['realm-membership', realmId, subject]);
      try {
        operation.assertCurrent();
        const { readRealmMembership } = await import('./realm-membership-actions');
        // This post-import guard is also immediately before the native standing read.
        operation.assertCurrent();
        const viewer = await readRealmMembership({ data: { realmId } });
        operation.assertCurrent();
        recordRealmMembershipRead(caller);
        return viewer;
      } finally {
        operation.finish();
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export const myRealmsQuery = (cursor?: string, caller?: MyRealmsCaller) =>
  queryOptions({
    ...personalRead,
    queryKey: ['my-realms', cursor ?? ''],
    queryFn: async ({ client, signal }) => {
      const captured =
        caller ??
        (await captureMyRealmsCaller(
          client,
          { cursor, locale: getLocale(), credentialMode: 'session' },
          { preserveQuery: true },
        ));
      const operation = beginMyRealmsRead(captured, client, signal);
      try {
        operation.assertCurrent();
        const { readMyRealmsPage } = await import('./space-actions');
        operation.assertCurrent();
        const page = await readMyRealmsPage({ data: cursor ? { cursor } : {} });
        operation.assertCurrent();
        const admitted = operation.publish(page);
        operation.assertCurrent();
        return admitted;
      } finally {
        operation.finish();
      }
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
  options: { signal?: AbortSignal; pause?: (ms: number) => Promise<void>; guard?: () => boolean } = {},
): Promise<MembershipRefresh> {
  let last: 'pending' | 'unavailable' = 'pending';
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const current = () => !options.signal?.aborted && (options.guard?.() ?? true);
  for (const delay of refreshDelays) {
    if (!current()) return { kind: 'cancelled' };
    if (delay) await pause(delay);
    if (!current()) return { kind: 'cancelled' };
    try {
      if (!current()) return { kind: 'cancelled' };
      const viewer = await read();
      if (!current()) return { kind: 'cancelled' };
      if (!viewer) last = 'unavailable';
      else if (viewer.state === 'banned') return { kind: 'denied', viewer };
      else if (viewer.state !== 'pending' && (target === undefined || viewer.state === target))
        return { kind: 'settled', viewer };
      else last = 'pending';
    } catch {
      if (!current()) return { kind: 'cancelled' };
      last = 'unavailable';
    }
  }
  return { kind: last };
}
