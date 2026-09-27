import { infiniteQueryOptions } from '@tanstack/react-query';
import { browserMainApi } from '../api/browser.ts';
import { readSearchPage } from './read.ts';
import type { SearchState } from './state.ts';
import type { SearchContinuation, SearchFailure, SearchLoaded, SearchResultPage } from './types.ts';

export class SearchError extends Error {
  constructor(readonly failure: SearchFailure) { super(`Search read failed: ${failure}`); }
}

export type SearchLoader = (continuation: SearchContinuation | undefined) => Promise<SearchLoaded>;

/** Later pages through the BFF, which carries the session and so the same mutes as page one. */
export function bffSearch(state: SearchState, language: string, actingSubject?: string): SearchLoader {
  return continuation => {
    const main = browserMainApi();
    return readSearchPage({ search: main, names: main }, state, { language, actingSubject, continuation });
  };
}

/**
 * A search's pages. The key holds the exact selection and page one's index
 * position; Main binds each continuation to that basis and asks for a restart
 * when it moves.
 */
export function searchPagesOptions(state: SearchState, language: string, first: SearchResultPage,
  load: SearchLoader) {
  return infiniteQueryOptions({
    queryKey: ['public-search', state, language, first.indexGeneration, first.sequence],
    queryFn: async ({ pageParam }) => {
      const read = await load(pageParam ?? undefined);
      if (!read.ok) throw new SearchError(read.failure);
      return read.page;
    },
    initialPageParam: null as SearchContinuation | null,
    getNextPageParam: page => page.next,
    initialData: { pages: [first], pageParams: [null] },
    retry: false,
  });
}
