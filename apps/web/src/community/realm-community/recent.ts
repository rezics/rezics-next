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

function publicComments(
  comments: Extract<NativeBoardRecent, { state: 'current' }>['threads'][number]['comments'],
): RealmBoardRecentThread['comments'] {
  // Viewer-cohort activity is not a public count. Relabelling it as exact/lower-bound would invent a public figure.
  if (comments.state !== 'current' || comments.cohort !== 'public') return { state: 'unavailable' };
  return { state: 'current', kind: comments.count.kind, value: comments.count.value };
}

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
      comments: publicComments(item.comments),
    });
  }
  return { state: 'current', threads, complete: value.complete };
}
