import * as v from 'valibot';
import { isWithinGlobalSearchQueryLimit } from '../search/query-text-limit';
import { realmReadingSearch } from './realm-reading-return';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageSearch = v.record(v.string(), v.unknown());

/** Search and the native shelves share an address, but retain separate continuations. */
export function realmCataloguePageSearch(value: Record<string, unknown>) {
  const search = { ...v.parse(pageSearch, value) };
  delete search.node;
  delete search.cursor;
  return { ...search, ...realmReadingSearch(value) };
}

/** A handoff has no stored Search state, cursor, facets, sort or rating population. */
export type RealmCatalogueEntry = Readonly<{
  realmId: string;
  browseHref: string;
  action: string;
  filter: string;
}>;

/** Only the admitted Realm identity can supply membership. Never pass a Space as a fallback. */
export function realmCatalogueEntry(realmId: string | null | undefined, locale: string): RealmCatalogueEntry | null {
  if (!realmId || !uuid.test(realmId)) return null;
  const id = realmId.toLowerCase();
  const filter = JSON.stringify({ realm: { id } });
  const action = `/${encodeURIComponent(locale)}/search`;
  return {
    realmId: id,
    browseHref: `${action}?filter=${encodeURIComponent(filter)}`,
    action,
    filter,
  };
}

/** Search is the authority for the UTF-8 limit. The early guard bounds work on pasted input too. */
export function realmCatalogueQueryAdmitted(query: string): boolean {
  return query.length <= 512 && isWithinGlobalSearchQueryLimit(query);
}

/** Preserve accepted bytes, including leading/trailing spaces; the Search owner normalizes its own defaults. */
export function realmCatalogueQueryHref(entry: RealmCatalogueEntry, query: string): string | null {
  if (!realmCatalogueQueryAdmitted(query)) return null;
  const params = new URLSearchParams({ filter: entry.filter });
  if (query) params.set('q', query);
  return `${entry.action}?${params}`;
}
