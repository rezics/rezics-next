// Whose view a browse page shows, in the URL form the Work page also uses
// (`?scope=realm&realm={uuid}`), so a reader keeps their scope between pages.
// Pure functions shared by routes, components and tests.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idPrefix = 'https://rezics.com/id/';

/**
 * Global is its own population; a Realm view never falls back to Global; Mine
 * is the signed-in person's own standing rating, never an aggregate of Realms.
 */
export type BrowseScope = { kind: 'global' } | { kind: 'realm'; realm: string } | { kind: 'mine' };

export type SearchParams = Record<string, string | string[] | undefined>;

/** A query value given once; callers refuse repeated keys rather than pick one. */
export const single = (value: string | string[] | undefined) => (Array.isArray(value) ? undefined : value);

export const isUuid = (value: string | null | undefined): value is string => !!value && uuid.test(value);

/** The UUID of a native IRI (`https://rezics.com/id/{uuid}`), or null. */
export function idOf(iri: string): string | null {
  const id = iri.startsWith(idPrefix) ? iri.slice(idPrefix.length) : '';
  return uuid.test(id) ? id : null;
}

export const iriOf = (id: string) => `${idPrefix}${id}`;

/** The first eight characters of an IRI's UUID, a readable stand-in while a resource has no name. */
export const shortId = (iri: string) => (idOf(iri) ?? iri).slice(0, 8);

/** The URL's scope; null when `scope` names no scope a page can show, which the page says. */
export function parseScope(params: SearchParams): BrowseScope | null {
  if (Array.isArray(params.scope) || Array.isArray(params.realm)) return null;
  const scope = single(params.scope);
  const realm = single(params.realm);
  if (scope === undefined || scope === 'global') return realm === undefined ? { kind: 'global' } : null;
  if (scope === 'mine') return realm === undefined ? { kind: 'mine' } : null;
  if (scope === 'realm' && isUuid(realm)) return { kind: 'realm', realm };
  return null;
}

/** The query that selects `scope`; Global is the default and adds nothing. */
export function scopeQuery(scope: BrowseScope): Record<string, string> {
  if (scope.kind === 'realm') return { scope: 'realm', realm: scope.realm };
  return scope.kind === 'mine' ? { scope: 'mine' } : {};
}

export const sameScope = (a: BrowseScope, b: BrowseScope) =>
  a.kind === b.kind && (a.kind !== 'realm' || a.realm === (b as { realm: string }).realm);

/** The scope an empty state offers instead. Never applied silently. */
export function neighbourScope(scope: BrowseScope): BrowseScope | null {
  return scope.kind === 'global' ? null : { kind: 'global' };
}

/** `path?query`, dropping empty values, with keys in the order given. */
export function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const entries = Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? `${path}?${new URLSearchParams(entries)}` : path;
}

/** A Work's page (`/w/{id}`) in the scope the reader was browsing. */
export function workHref(work: string, scope: BrowseScope): string {
  return withQuery(`/w/${idOf(work) ?? encodeURIComponent(work)}`, scopeQuery(scope));
}
