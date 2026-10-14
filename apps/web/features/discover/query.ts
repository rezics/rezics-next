import { infiniteQueryOptions } from '@tanstack/react-query';
import { browserMainApi } from '../api/browser.ts';
import { readDiscovery } from './read.ts';
import { readQueryDiscovery } from './query-read.ts';
import type { DiscoverState } from './state.ts';
import type { DiscoveryPage, DiscoveryQuery, Loaded, ReadFailure, ReadProblem } from './types.ts';

/** A failed page, carrying the failure the shelf shows. */
export class ReadError extends Error {
  constructor(readonly failure: ReadFailure, readonly response: ReadProblem = {}) { super(`Discovery read failed: ${failure}`); }
}

export type DiscoveryLoader = (query: DiscoveryQuery) => Promise<Loaded<DiscoveryPage>>;

/**
 * Signed-out public pages omit cookies. Viewer pages and Mine keep the session;
 * Mine must never become anonymous because the caller has no eligible Agent.
 */
export function bffDiscovery(signedIn: boolean, state?: DiscoverState): DiscoveryLoader {
  return query => {
    const main = browserMainApi(undefined, {
      anonymous: !signedIn && query.scope !== 'mine' && state?.scope.kind !== 'mine',
    });
    return state ? readQueryDiscovery(main, state, query) : readDiscovery(main, query);
  };
}

/**
 * A shelf's pages. The key includes the exact selection (scope, Realm, Context,
 * filters, locale) and the first page's source position, so a fresh server
 * render starts a new list instead of reusing pages from an older basis.
 */
export function discoveryPagesOptions(query: DiscoveryQuery, first: DiscoveryPage, load: DiscoveryLoader,
  signedIn = true) {
  return infiniteQueryOptions({
    queryKey: ['discovery', query, signedIn, first.sourcePosition.dataEpoch, first.sourcePosition.sequence],
    queryFn: async ({ pageParam }) => {
      const read = await load(pageParam ? { ...query, cursor: pageParam } : query);
      if (!read.ok) throw new ReadError(read.failure, read);
      return read.data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
    retry: false,
  });
}
