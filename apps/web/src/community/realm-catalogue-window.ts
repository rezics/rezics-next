import type { SearchPageData } from '../search/search';

/** Retain only the last row window during a continuation; aggregates require the new read's proof. */
export function realmCatalogueWindow(current: SearchPageData, previous?: SearchPageData): SearchPageData {
  if (
    !previous?.result ||
    !['loading', 'unavailable', 'index-not-ready', 'source-not-ready'].includes(current.recovery?.status ?? '')
  )
    return current;
  const { kinds: _kinds, ...rows } = previous.result;
  return {
    ...current,
    result: { ...rows, next: null },
    hitTypes: previous.hitTypes,
    yearProperties: previous.yearProperties,
  };
}
