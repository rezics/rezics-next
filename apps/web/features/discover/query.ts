import { infiniteQueryOptions } from '@tanstack/react-query';
import { browserMainApi } from '../api/browser.ts';
import { readDiscovery } from './read.ts';
import type { DiscoveryPage, DiscoveryQuery, Loaded, ReadFailure } from './types.ts';

/** A failed page, carrying the failure the shelf shows. */
export class ReadError extends Error {
  constructor(readonly failure: ReadFailure) { super(`Discovery read failed: ${failure}`); }
}

export type DiscoveryLoader = (query: DiscoveryQuery) => Promise<Loaded<DiscoveryPage>>;

/** Pages after the server-rendered first one, read through the BFF. */
export const bffDiscovery: DiscoveryLoader = query => readDiscovery(browserMainApi(), query);

/**
 * A shelf's pages. The key includes the exact selection (scope, Realm, Context,
 * filters, locale) and the first page's source position, so a fresh server
 * render starts a new list instead of reusing pages from an older basis.
 */
export function discoveryPagesOptions(query: DiscoveryQuery, first: DiscoveryPage, load: DiscoveryLoader) {
  return infiniteQueryOptions({
    queryKey: ['discovery', query, first.sourcePosition.dataEpoch, first.sourcePosition.sequence],
    queryFn: async ({ pageParam }) => {
      const read = await load(pageParam ? { ...query, cursor: pageParam } : query);
      if (!read.ok) throw new ReadError(read.failure);
      return read.data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
    retry: false,
  });
}
