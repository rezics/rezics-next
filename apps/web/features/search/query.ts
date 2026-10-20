import { hashKey, type InfiniteData, infiniteQueryOptions } from '@tanstack/react-query';
import { browserMainApi } from '../api/browser.ts';
import { readSearchPage } from './read.ts';
import type { SearchState } from './state.ts';
import type { ReadProblem } from '../discover/types.ts';
import type { SearchContinuation, SearchFailure, SearchLoaded, SearchResultPage } from './types.ts';

export class SearchError extends Error {
  constructor(readonly failure: SearchFailure, readonly response: ReadProblem = {}) { super(`Search read failed: ${failure}`); }
}

export type SearchLoader = (continuation: SearchContinuation | undefined) => Promise<SearchLoaded>;

/** Later pages keep page one's public or viewer transport, including delegated names. */
export function bffSearch(state: SearchState, language: string, actingSubject?: string, signedIn = true): SearchLoader {
  return continuation => {
    const main = browserMainApi(undefined, { anonymous: !signedIn });
    return readSearchPage({ search: main, names: main }, state, { language, actingSubject, continuation });
  };
}

/**
 * A search's pages. The key holds the exact selection, acting reader and page
 * one's index position; Main binds each continuation to that basis and asks
 * for a restart when it moves.
 */
export function searchPagesOptions(state: SearchState, language: string, actingSubject: string | undefined,
  first: SearchResultPage, load: SearchLoader, signedIn = true) {
  const traversals = new WeakMap<AbortSignal, Set<string>>();
  const tokenKey = (token: SearchContinuation | null) => hashKey([token]);
  return infiniteQueryOptions({
    queryKey: ['public-search', state, language, actingSubject ?? null, signedIn, first.indexGeneration, first.sequence],
    queryFn: async ({ pageParam, client, queryKey, signal }) => {
      const read = await load(pageParam ?? undefined);
      if (!read.ok) throw new SearchError(read.failure, read);
      let seen = traversals.get(signal);
      if (!seen) {
        const cached = client.getQueryData<InfiniteData<SearchResultPage, SearchContinuation | null>>(queryKey);
        const params = cached?.pageParams ?? [];
        const position = params.findIndex(param => tokenKey(param) === tokenKey(pageParam));
        // A refetch starts at page one: later cached parameters have not been consumed yet.
        seen = new Set(params.slice(0, position < 0 ? params.length : position).filter(param => param !== null).map(tokenKey));
        traversals.set(signal, seen);
      }
      if (pageParam) seen.add(tokenKey(pageParam));
      // Compare complete opaque values, without decoding their owner-defined fields.
      if (read.page.next && seen.has(tokenKey(read.page.next))) throw new SearchError('restart');
      return read.page;
    },
    initialPageParam: null as SearchContinuation | null,
    getNextPageParam: page => page.next,
    initialData: { pages: [first], pageParams: [null] },
    retry: false,
  });
}
