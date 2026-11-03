import type { RecentEntry } from './recent-searches.ts';

/** History keeps only text, ordered languages and one native resource reference. */
export function recentSearchDestination(entry: RecentEntry): string | undefined {
  if (entry.kind === 'scope') {
    const scope = entry.scope;
    return scope.kind === 'route' ? '/library' : `/${scope.kind === 'realm' ? 'realms' : 'collections'}/${scope.id}`;
  }
  const scope = entry.scope;
  const filter = scope
    ? scope.kind === 'route'
      ? { owner: { presence: true } }
      : { [scope.kind]: { id: scope.id.toLowerCase() } }
    : undefined;
  const params = [
    `q=${encodeURIComponent(entry.text)}`,
    ...(entry.languages ?? []).map((tag) => `language=${encodeURIComponent(tag)}`),
    ...(filter ? [`filter=${encodeURIComponent(JSON.stringify(filter))}`] : []),
  ];
  return `/search?${params.join('&')}`;
}
