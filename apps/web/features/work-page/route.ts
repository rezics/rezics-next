// Work page addresses: `/w/{slug|id}/{tab}?scope=…`. Pure functions shared by
// the routes, the components and their tests.

/** The Work's views, in tab order. Each is its own URL. */
export const workTabs = ['overview', 'contents', 'versions', 'discussion', 'history'] as const;
export type WorkTab = (typeof workTabs)[number];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Main's address slug (`services/main/src/routes/addresses.ts`).
const slug = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const idPrefix = 'https://rezics.com/id/';

/** A `/w/{ref}` segment: a Work UUID, or a slug Main resolves. A UUID-shaped ref is always an ID. */
export type WorkRef = { kind: 'id'; id: string } | { kind: 'slug'; slug: string };

export function parseWorkRef(ref: string): WorkRef | null {
  if (uuid.test(ref)) return { kind: 'id', id: ref };
  if (ref.length <= 64 && slug.test(ref)) return { kind: 'slug', slug: ref.toLowerCase() };
  return null;
}

/** The UUID of a native IRI (`https://rezics.com/id/{uuid}`), or null. */
export function idOf(iri: string): string | null {
  const id = iri.startsWith(idPrefix) ? iri.slice(idPrefix.length) : '';
  return uuid.test(id) ? id : null;
}

export const iriOf = (id: string) => `${idPrefix}${id}`;

/** The first eight characters of an IRI's UUID, a readable stand-in while a resource has no name. */
export const shortId = (iri: string) => (idOf(iri) ?? iri).slice(0, 8);

/**
 * Whose view of ratings, classification and adoption a page shows. Global is
 * its own population; Mine is the signed-in person's own standing rating; a
 * Realm view never falls back to Global.
 */
export type WorkScope = { kind: 'global' } | { kind: 'realm'; realm: string } | { kind: 'mine' };

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? undefined : value);

/** The URL's scope; null when `scope` names no scope this page can show, which the page says. */
export function parseScope(params: SearchParams): WorkScope | null {
  if (Array.isArray(params.scope) || Array.isArray(params.realm)) return null;
  const scope = single(params.scope);
  const realm = single(params.realm);
  if (scope === undefined || scope === 'global') return realm === undefined ? { kind: 'global' } : null;
  if (scope === 'mine') return realm === undefined ? { kind: 'mine' } : null;
  if (scope === 'realm' && realm && uuid.test(realm)) return { kind: 'realm', realm };
  return null;
}

/** The query that selects `scope`; Global is the default and adds nothing. */
export function scopeQuery(scope: WorkScope): Record<string, string> {
  if (scope.kind === 'realm') return { scope: 'realm', realm: scope.realm };
  return scope.kind === 'mine' ? { scope: 'mine' } : {};
}

export const sameScope = (a: WorkScope | null, b: WorkScope | null) =>
  a?.kind === b?.kind && (a?.kind !== 'realm' || a.realm === (b as { realm: string }).realm);

/**
 * The scope an empty state offers instead: a Realm or Mine offers Global, and
 * Global offers the first Realm that adopted the Work. Never applied silently.
 */
export function neighbourScope(scope: WorkScope, realms: readonly string[]): WorkScope | null {
  if (scope.kind !== 'global') return { kind: 'global' };
  return realms[0] ? { kind: 'realm', realm: realms[0] } : null;
}

/** Main's `scope`/`realm` read parameters for a scope. */
export function mainScope(scope: WorkScope): { scope: WorkScope['kind']; realm?: string } {
  return scope.kind === 'realm' ? { scope: 'realm', realm: iriOf(scope.realm) } : { scope: scope.kind };
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const entries = Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? `${path}?${new URLSearchParams(entries)}` : path;
}

/** A Work view's address. Scope is kept across tabs so a Realm reader stays in their Realm. */
export function workHref(ref: string, tab: WorkTab = 'overview', scope: WorkScope | null = null,
  query: Record<string, string | undefined> = {}): string {
  const path = `/w/${encodeURIComponent(ref)}${tab === 'overview' ? '' : `/${tab}`}`;
  return withQuery(path, { ...(scope ? scopeQuery(scope) : {}), ...query });
}

/** The tab a pathname shows, for the tab bar's current item. */
export function tabOf(pathname: string): WorkTab {
  const segment = pathname.split('/')[3];
  return workTabs.find(tab => tab === segment) ?? 'overview';
}

// Main's content-language tag (`readLanguage` in the Work read contract).
const languageTag = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** The Versions tab's filters and page, as the URL gives them. */
export interface VersionQuery { kind?: 'text-variant' | 'release'; language?: string; cursor?: string }

/**
 * Filters from the URL, or null when one is malformed. A language's primary
 * subtag is lower-cased (`EN` → `en`) as Main expects; anything else that is
 * not a tag is refused rather than dropped, so a filtered view never widens.
 */
export function parseVersionQuery(params: SearchParams): VersionQuery | null {
  if ([params.kind, params.language, params.cursor].some(Array.isArray)) return null;
  const kind = single(params.kind) || undefined;
  const cursor = single(params.cursor) || undefined;
  const raw = single(params.language)?.trim() || undefined;
  const [primary = '', ...rest] = raw?.split('-') ?? [];
  const language = raw ? [primary.toLowerCase(), ...rest].join('-') : undefined;
  if (kind !== undefined && kind !== 'text-variant' && kind !== 'release') return null;
  if (language !== undefined && (language.length > 35 || !languageTag.test(language))) return null;
  if (cursor !== undefined && cursor.length > 2048) return null;
  return { kind, language, cursor };
}
