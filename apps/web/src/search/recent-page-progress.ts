import { RECENT_HISTORY_LIMIT } from './recent-history';

export const RECENT_HISTORY_PAGE_SIZE = 20;
export const RECENT_HISTORY_READ_PAGE_LIMIT = Math.ceil(RECENT_HISTORY_LIMIT / RECENT_HISTORY_PAGE_SIZE);

type NativePage<Row> = { recentSearches: readonly Row[]; next: string | null };

export function createRecentPageProgress<Row extends { id: string }>() {
  const rows: Row[] = [],
    ids = new Set<string>(),
    continuations = new Set<string>();
  let pages = 0;
  return {
    accept(page: NativePage<Row>) {
      if (
        !page ||
        !Array.isArray(page.recentSearches) ||
        pages >= RECENT_HISTORY_READ_PAGE_LIMIT ||
        page.recentSearches.length > RECENT_HISTORY_PAGE_SIZE ||
        (pages > 0 && page.recentSearches.length === 0)
      )
        return false;
      const next = page.next;
      if (
        next !== null &&
        (typeof next !== 'string' ||
          next.length === 0 ||
          page.recentSearches.length !== RECENT_HISTORY_PAGE_SIZE ||
          continuations.has(next))
      )
        return false;
      const pageIds = new Set<string>();
      for (const row of page.recentSearches) {
        if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || pageIds.has(row.id)) return false;
        pageIds.add(row.id);
      }
      for (const id of pageIds) ids.add(id);
      rows.push(...page.recentSearches);
      if (next !== null) continuations.add(next);
      pages++;
      return true;
    },
    get rows(): readonly Row[] {
      return rows;
    },
  };
}
