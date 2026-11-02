import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import * as v from 'valibot';
import { loadRealmDiscovery } from '../community/realm-discovery/source';
import type { RealmDiscoverySort, RealmDiscoveryState } from '../community/realm-discovery';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SearchLoaderDeps } from './search-params';

export type RealmDiscoveryPage = Exclude<RealmDiscoveryState, { kind: 'loading' }>;
export type RealmDiscoveryReadInput = Readonly<{ locale: string; sort: RealmDiscoverySort; cursor?: string }>;
export type RealmDiscoveryReader = (input: {
  data: RealmDiscoveryReadInput;
  signal: AbortSignal;
}) => Promise<RealmDiscoveryPage>;

const input = v.strictObject({
  locale: v.pipe(v.string(), v.minLength(1), v.maxLength(35)),
  sort: v.picklist(['popular', 'trending']),
  cursor: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
});

/** Existing server-function transport, delegating once to Content's original adapter. */
export const readRealmDiscovery = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<RealmDiscoveryPage> => {
    try {
      const { kernelClient } = await import('../kernel/client');
      return await loadRealmDiscovery(kernelClient(data.locale), {
        sort: data.sort,
        limit: 20,
        ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
      });
    } catch (error) {
      return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
    }
  });

/** Browsing never substitutes for a query, selected scope, filter or advanced draft. */
export function isRealmDiscoverySearch(state: SearchLoaderDeps): boolean {
  return !(
    state.query ||
    state.type ||
    state.cursor ||
    state.sort ||
    state.filter ||
    state.condition ||
    state.kinds?.length ||
    state.languages?.length ||
    Object.keys(state.facets).length ||
    Object.keys(state.ranges ?? {}).length
  );
}

/** One cache entry per anonymous locale/sort/page, with no background refills or automatic retries. */
export function realmDiscoveryQueryOptions(
  locale: string,
  sort: RealmDiscoverySort = 'popular',
  cursor?: string,
  read: RealmDiscoveryReader = readRealmDiscovery,
) {
  return queryOptions({
    queryKey: ['search', 'realm-discovery-v1', 'anonymous', 'public-global', locale, sort, 20, cursor ?? null],
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => read({ data: { locale, sort, ...(cursor !== undefined ? { cursor } : {}) }, signal }),
  });
}

export type RealmDiscoveryWindow = Readonly<{
  state: RealmDiscoveryState;
  pending: boolean;
  retry: boolean;
  restart: boolean;
}>;

export const REALM_DISCOVERY_PAGE_SIZE = 20;

export function createRealmDiscoveryWindow(state: RealmDiscoveryState): RealmDiscoveryWindow {
  return reduceRealmDiscovery({
    state: { kind: 'loading' },
    pending: false,
    retry: false,
    restart: false,
  }, state);
}

/** Successful pages replace the finite window; pending and failed requests retain the accepted window. */
export function reduceRealmDiscovery(
  previous: RealmDiscoveryWindow,
  incoming: RealmDiscoveryState,
): RealmDiscoveryWindow {
  if (incoming.kind !== 'ready') {
    if (incoming.kind === 'loading')
      return {
        state: previous.state.kind === 'ready' ? previous.state : incoming,
        pending: true,
        retry: false,
        restart: false,
      };
    if (incoming.kind === 'closed') return { state: incoming, pending: false, retry: false, restart: false };
    return {
      state: previous.state.kind === 'ready' ? previous.state : incoming,
      pending: false,
      retry: true,
      restart: false,
    };
  }
  return {
    state: { ...incoming, realms: incoming.realms.slice(0, REALM_DISCOVERY_PAGE_SIZE) },
    pending: false,
    retry: false,
    restart: false,
  };
}

/** A broken continuation keeps the last accepted rows visible and turns Retry into a first-page restart. */
export function requireRealmDiscoveryRestart(previous: RealmDiscoveryWindow): RealmDiscoveryWindow {
  return { ...previous, pending: false, retry: true, restart: true };
}
