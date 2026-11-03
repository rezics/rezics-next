import type { SearchLoaderDeps } from './search-params';

/** Resource membership and Realm rating both bind Search output to the current server reader. */
export function searchRequiresCurrentReader(
  state: Pick<SearchLoaderDeps, 'resourceScope' | 'ratingPopulation'>,
): boolean {
  return state.resourceScope !== undefined || state.ratingPopulation !== undefined;
}

/** A browser owner is only a cache hint; the server resolves and compares the current session. */
export function searchSessionLifetime(locale: string, state: SearchLoaderDeps, reader?: string): string {
  const sessionBound = searchRequiresCurrentReader(state);
  return JSON.stringify([
    'search-session-v1',
    sessionBound ? 'personal' : 'public-anonymous',
    locale,
    sessionBound ? (reader ?? 'unverified') : 'anonymous',
    state,
  ]);
}
