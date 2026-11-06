import type { KernelClient } from '@rezics/client';

type NativeBoardRecent = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['realms']>['home']['get']>>['data']
>['boards']['items'][number]['recent'];

export type RealmBoardRecentThread = {
  id: string;
  title: string | null;
  comments: { state: 'current'; kind: 'exact' | 'lower-bound'; value: number } | { state: 'unavailable' };
};

export type RealmBoardRecent =
  | { state: 'current'; threads: readonly RealmBoardRecentThread[]; complete: boolean }
  | { state: 'unavailable' };

/** Installed Home/shelf `recent`. A missing older callable, overflow, or mismatched target stays unavailable. */
export function presentRealmBoardRecent(
  value: NativeBoardRecent | null | undefined,
  boardId: string,
): RealmBoardRecent {
  if (value == null || value.state === 'unavailable') return { state: 'unavailable' };
  if (value.threads.length > 3) return { state: 'unavailable' };
  const threads: RealmBoardRecentThread[] = [];
  for (const item of value.threads) {
    if (item.target.boardId !== boardId || item.target.id !== item.thread.id) return { state: 'unavailable' };
    threads.push({
      id: item.thread.id,
      title: item.thread.title,
      comments:
        item.comments.state === 'current'
          ? { state: 'current', kind: item.comments.count.kind, value: item.comments.count.value }
          : { state: 'unavailable' },
    });
  }
  return { state: 'current', threads, complete: value.complete };
}
