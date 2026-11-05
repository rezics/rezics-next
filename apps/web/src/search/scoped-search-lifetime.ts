import { parseDiscoveryFilter, walkDiscoveryFilter } from '@rezics/filter';
import type { SearchLoaderDeps } from './search-params';

/** Private predicates, resource membership and Realm rating bind output to the current server reader. */
export function searchRequiresCurrentReader(
  state: Pick<SearchLoaderDeps, 'resourceScope' | 'ratingPopulation' | 'filter' | 'condition'>,
): boolean {
  if (state.resourceScope !== undefined || state.ratingPopulation !== undefined) return true;
  for (const input of [state.condition, state.filter]) {
    if (input === undefined || input === '') continue;
    try {
      const filter = parseDiscoveryFilter(typeof input === 'string' ? JSON.parse(input) : input);
      for (const node of walkDiscoveryFilter(filter)) if ('owner' in node) return true;
    } catch {
      // Invalid authored input remains the existing admission/repair path; this selects no authority.
    }
  }
  return false;
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
