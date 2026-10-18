import type { ContentsPage, Loaded } from './types.ts';

/** Counts disclosed chapter occurrences, including private drafts, never group headings. */
export interface BookChapters { count: number; more: boolean; published: number }

/**
 * Follow the contents owner's parent and cursor addresses. The budget bounds a
 * home read, not the book: an unfinished traversal remains a lower bound.
 */
export async function countBookChapters(first: ContentsPage,
  load: (parent: string | undefined, cursor: string | undefined) => Promise<Loaded<ContentsPage>>,
  maxPages = 20): Promise<BookChapters> {
  const total: BookChapters = { count: 0, published: 0, more: false };
  const pending: Array<{ parent?: string; cursor?: string; page?: ContentsPage }> = [{ page: first }];
  const occurrences = new Set<string>();
  const addresses = new Set<string>();
  let pages = 0;
  while (pending.length) {
    if (pages++ >= maxPages) return { ...total, more: true };
    const next = pending.shift()!;
    const address = JSON.stringify([next.parent ?? null, next.cursor ?? null]);
    if (addresses.has(address)) return { ...total, more: true };
    addresses.add(address);
    const loaded = next.page ? { ok: true as const, data: next.page } : await load(next.parent, next.cursor);
    if (!loaded.ok) return { ...total, more: true };
    const page = loaded.data;
    if (page.work !== first.work || page.version !== first.version || page.composition !== first.composition
      || page.compositionRevision !== first.compositionRevision || page.language !== first.language) {
      return { ...total, more: true };
    }
    // Reject an overlapping page rather than accidentally counting it twice.
    if (page.items.some(item => occurrences.has(item.occurrence))
      || new Set(page.items.map(item => item.occurrence)).size !== page.items.length) return { ...total, more: true };
    for (const item of page.items) {
      occurrences.add(item.occurrence);
      if (item.role === 'chapter') {
        total.count++;
        if (item.availability === 'available') total.published++;
      } else if (item.role === 'group') pending.push({ parent: item.occurrence });
    }
    if (page.nextCursor) pending.push({ parent: next.parent, cursor: page.nextCursor });
  }
  return total;
}
