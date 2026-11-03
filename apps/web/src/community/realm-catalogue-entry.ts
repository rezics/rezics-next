import { safeParse } from 'valibot';
import { isSearchResourceScope, searchResourceScopeAction } from '../search/advanced-scope';
import { searchParams } from '../search/search-params';

/** A handoff has no stored Search state, cursor, facets, sort or rating population. */
export type RealmCatalogueEntry = Readonly<{
  realmId: string;
  browseHref: string;
  action: string;
  filter: string;
}>;

/** Only the admitted Realm identity can supply membership. Never pass a Space as a fallback. */
export function realmCatalogueEntry(realmId: string | null | undefined, locale: string): RealmCatalogueEntry | null {
  const scope = { kind: 'realm', id: realmId };
  if (!isSearchResourceScope(scope)) return null;
  const browseHref = searchResourceScopeAction(locale, scope);
  const separator = browseHref.indexOf('?');
  const filter = new URLSearchParams(browseHref.slice(separator + 1)).get('filter');
  if (!filter) return null;
  return {
    realmId: scope.id.toLowerCase(),
    browseHref,
    action: browseHref.slice(0, separator),
    filter,
  };
}

/** Search is the authority for the UTF-8 limit. The early guard bounds work on pasted input too. */
export function realmCatalogueQueryAdmitted(query: string): boolean {
  return query.length <= 512 && safeParse(searchParams, { q: query }).success;
}

/** Preserve accepted bytes, including leading/trailing spaces; the Search owner normalizes its own defaults. */
export function realmCatalogueQueryHref(entry: RealmCatalogueEntry, query: string): string | null {
  if (!realmCatalogueQueryAdmitted(query)) return null;
  const params = new URLSearchParams({ filter: entry.filter });
  if (query) params.set('q', query);
  return `${entry.action}?${params}`;
}
