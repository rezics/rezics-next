import type { FeedApi } from './api.ts';
import type { FeedItem, FeedPage, FeedQuery, Loaded } from './types.ts';

export function projecting(page: FeedPage): boolean {
  return page.projection.status === 'catching-up' || page.caughtUp?.state === 'projecting';
}

/** Source sequences are decimal strings, potentially larger than a JS number. */
export function sameSource(left: FeedPage, right: FeedPage): boolean {
  return (
    left.sourcePosition.dataEpoch === right.sourcePosition.dataEpoch &&
    left.sourcePosition.sequence === right.sourcePosition.sequence
  );
}

export function appendPosts(items: readonly FeedItem[], next: readonly FeedItem[]): FeedItem[] {
  const seen = new Set(items.map((item) => item.id));
  return [
    ...items,
    ...next.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

export function sameProjection(left: FeedPage, right: FeedPage): boolean {
  return (
    sameSource(left, right) &&
    left.projection.sequence === right.projection.sequence &&
    left.projection.reviewSequence === right.projection.reviewSequence
  );
}

/**
 * A backfill invalidates old cursors. Replay a fresh cursor chain through the
 * last loaded post before swapping any rows, so inserted history cannot leave
 * a gap between the refreshed first page and the reader's old later pages.
 * Bound each attempt to the previously loaded pages plus the sparse-page budget.
 */
export async function recoverProjection(
  api: FeedApi,
  query: FeedQuery,
  first: FeedPage,
  previous: { page: FeedPage; items: readonly FeedItem[]; pages: number },
  sparseBudget: number,
  active: () => boolean,
): Promise<Loaded<{ page: FeedPage; items: FeedItem[]; pages: number }>> {
  const moved = { ok: false, failure: 'moved' } as const;
  // No per-item source position is served. Never mix a newer source cut into
  // this view: it could insert posts above the reader's sequence watermark.
  // Reviews have an independent sequence and must retain their own cut too.
  if (
    !sameSource(first, previous.page) ||
    first.projection.reviewSequence !== previous.page.projection.reviewSequence ||
    projecting(first)
  )
    return moved;
  const last = previous.items.at(-1)?.id;
  let page = first;
  let items = appendPosts([], first.items);
  let pages = 1;
  const cursors = new Set<string>();
  while (page.nextCursor && last && !items.some((item) => item.id === last)) {
    if (!active() || pages >= previous.pages + sparseBudget || cursors.has(page.nextCursor))
      return moved;
    cursors.add(page.nextCursor);
    const next = await api.page({ ...query, cursor: page.nextCursor });
    if (!next.ok) return next;
    if (!sameProjection(first, next.data) || projecting(next.data)) return moved;
    page = next.data;
    items = appendPosts(items, page.items);
    pages++;
  }
  return { ok: true, data: { page, items, pages } };
}
