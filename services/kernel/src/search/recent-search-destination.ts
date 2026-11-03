import type { RecentEntry } from './recent-searches.ts';

/** History keeps only text, ordered languages and one native resource reference. */
export function recentSearchDestination(entry: RecentEntry): string | undefined {
  const scope = entry.scope;
  if (entry.kind === 'scope') {
    return scope.kind === 'route' ? '/library' : `/${scope.kind === 'realm' ? 'realms' : 'collections'}/${scope.id}`;
  }
  // The installed Search resource operand currently admits Realm and Collection only.
  if (scope?.kind === 'route') return;
  const params = [
    `q=${encodeURIComponent(entry.text)}`,
    ...(entry.languages ?? []).map((tag) => `language=${encodeURIComponent(tag)}`),
    ...(scope
      ? [`filter=${encodeURIComponent(JSON.stringify({ [scope.kind]: { id: scope.id.toLowerCase() } }))}`]
      : []),
  ];
  return `/search?${params.join('&')}`;
}
