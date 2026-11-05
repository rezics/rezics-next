import type { SearchLoaderDeps } from './search-params';

/** Only unconfigured searches browse Realms; explicit result controls use native search. */
export function hasResultSearchIntent(state: SearchLoaderDeps): boolean {
  return Boolean(
    state.query ||
    state.type ||
    state.cursor ||
    state.sort ||
    state.filter ||
    state.condition ||
    state.kinds?.length ||
    state.languages?.length ||
    Object.keys(state.facets).length ||
    Object.keys(state.ranges ?? {}).length,
  );
}
