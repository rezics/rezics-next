import {
  parseSearchResourceScope,
  removeSearchResourceScope,
  type SearchResourceScope,
} from './advanced-scope';
import type { SearchLoaderDeps } from './search-params';

/** A new or removed resource scope starts a first traversal without the previous facet window. */
export function searchResourceScopeChanged(
  previous?: SearchResourceScope,
  next?: SearchResourceScope,
): boolean {
  return previous?.kind !== next?.kind || previous?.id !== next?.id;
}

export function searchScopeFromFilter(filter?: string): SearchResourceScope | undefined {
  return filter ? parseSearchResourceScope(filter).scope : undefined;
}

/** Facet fields belong to the previous scope's continuation and cannot travel into a new predicate. */
export function withoutRetiredScopeFacets(
  fields: readonly [string, string][],
  previous?: SearchResourceScope,
  next?: SearchResourceScope,
): [string, string][] {
  if (!searchResourceScopeChanged(previous, next)) return [...fields];
  return fields.filter(([key]) => !key.startsWith('f.'));
}

/** Restart in the next scope: keep the executed query, drop facet values and the hit cursor. */
export function searchStateForScopeRestart(
  state: SearchLoaderDeps,
  next: Readonly<{ filter?: string; resourceScope?: SearchResourceScope }>,
): SearchLoaderDeps {
  return {
    ...state,
    filter: next.filter,
    resourceScope: next.resourceScope,
    facets: {},
    cursor: undefined,
  };
}

export function searchStateWithoutScope(state: SearchLoaderDeps): SearchLoaderDeps {
  return searchStateForScopeRestart(state, {
    filter: removeSearchResourceScope(state.filter),
    resourceScope: undefined,
  });
}
