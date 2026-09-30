// Work page addresses: `/w/{slug|id}/{tab}?scope=…`. Pure functions shared by
// the routes, the components and their tests.

import { withoutLocale } from '../../i18n/locale.ts';

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

/**
 * The last eight characters of an IRI's UUID, a readable stand-in while a
 * resource has no name. Main mints time-ordered UUIDv7s, whose leading
 * characters repeat for resources made in the same minute; the tail is random.
 */
export const shortId = (iri: string) => (idOf(iri) ?? iri).slice(-8);

/**
 * Whose view of ratings, classification and adoption a page shows. Global is
 * its own population; Mine is the signed-in person's own standing rating; a
 * Realm view never falls back to Global.
 */
export type WorkScope = { kind: 'global' } | { kind: 'realm'; realm: string } | { kind: 'mine' };

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? undefined : value);

/**
 * Everyone's view as one shared value: reads are cached per request by
 * argument identity, so the frame, the rating line and reviews share one read.
 */
export const EVERYONE: WorkScope = Object.freeze({ kind: 'global' });

/** The URL's scope; null when `scope` names no scope this page can show, which the page says. */
export function parseScope(params: SearchParams): WorkScope | null {
  if (Array.isArray(params.scope) || Array.isArray(params.realm)) return null;
  const scope = single(params.scope);
  const realm = single(params.realm);
  if (scope === undefined || scope === 'global') return realm === undefined ? EVERYONE : null;
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

/**
 * A Work's pages inside a Zone's site: `path` is the Work's address there (`/r/books/w/{id}`), `realm` the Zone's
 * default Realm, whose view the pages open with, and `ref` the Work's own reference, for the global reader.
 */
export interface ZoneWorkBase { ref: string; path: string; realm: string }
/** Where a Work's pages are: its global `/w/{ref}`, or inside a Zone's site. */
export type WorkAt = string | ZoneWorkBase;

export const workRefOf = (at: WorkAt) => typeof at === 'string' ? at : at.ref;

/** The scope a Work's pages open with: Everyone's globally, the Zone's Realm inside a Zone's site. */
export function defaultScope(at: WorkAt): WorkScope {
  return typeof at === 'string' ? EVERYONE : { kind: 'realm', realm: at.realm };
}

/**
 * The scope in the URL; a Zone's site opens with its Realm's view when the URL names none, and keeps Everyone's
 * behind an explicit `scope=global`.
 */
export function scopeAt(at: WorkAt, params: SearchParams): WorkScope | null {
  return typeof at !== 'string' && params.scope === undefined && params.realm === undefined
    ? defaultScope(at) : parseScope(params);
}

/**
 * A Work view's address. Scope is kept across tabs so a Realm reader stays in their Realm; inside a Zone's site
 * the Zone's Realm is the default and adds nothing, and Everyone's view says so.
 */
export function workHref(at: WorkAt, tab: WorkTab = 'overview', scope: WorkScope | null = null,
  query: Record<string, string | undefined> = {}): string {
  const base = typeof at === 'string' ? `/w/${encodeURIComponent(at)}` : at.path;
  const path = `${base}${tab === 'overview' ? '' : `/${tab}`}`;
  const chosen = scope && typeof at !== 'string' && sameScope(scope, defaultScope(at)) ? {}
    : scope?.kind === 'global' && typeof at !== 'string' ? { scope: 'global' } : scope ? scopeQuery(scope) : {};
  return withQuery(path, { ...chosen, ...query });
}

/** The tab a pathname shows, for the tab bar's current item. */
export function tabOf(pathname: string, at?: WorkAt): WorkTab {
  // `/{locale}/w/{ref}/{tab}`, or `{base}/{tab}` inside a Zone's site; the locale prefix is optional.
  const path = withoutLocale(pathname);
  const segment = at && typeof at !== 'string' ? path.slice(at.path.length).split('/')[1] : path.split('/')[3];
  return workTabs.find(tab => tab === segment) ?? 'overview';
}

// Main's content-language tag (`readLanguage` in the Work read contract).
const languageTag = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** The Versions tab's filters and page, as the URL gives them. */
export interface VersionQuery { kind?: 'text-variant' | 'release'; language?: string; cursor?: string }

/** A content language from the URL with its primary subtag lower-cased (`EN` → `en`), or null when malformed. */
function contentLanguage(raw: string | undefined): string | undefined | null {
  const value = raw?.trim();
  if (!value) return undefined;
  const [primary = '', ...rest] = value.split('-');
  const tag = [primary.toLowerCase(), ...rest].join('-');
  return tag.length <= 35 && languageTag.test(tag) ? tag : null;
}

/**
 * Filters from the URL, or null when one is malformed. A language's primary
 * subtag is lower-cased (`EN` → `en`) as Main expects; anything else that is
 * not a tag is refused rather than dropped, so a filtered view never widens.
 */
export function parseVersionQuery(params: SearchParams): VersionQuery | null {
  if ([params.kind, params.language, params.cursor].some(Array.isArray)) return null;
  const kind = single(params.kind) || undefined;
  const cursor = single(params.cursor) || undefined;
  const language = contentLanguage(single(params.language));
  if (kind !== undefined && kind !== 'text-variant' && kind !== 'release') return null;
  if (language === null) return null;
  if (cursor !== undefined && cursor.length > 2048) return null;
  return { kind, language, cursor };
}

/** History's `kind` filter; anything else is refused rather than widened to all activity. */
export const historyKinds = ['metadata-revision', 'publication-decision', 'reply-placement'] as const;
export type HistoryFilter = (typeof historyKinds)[number];

export function parseHistoryQuery(params: SearchParams): { kind?: HistoryFilter; cursor?: string } | null {
  if (Array.isArray(params.kind) || Array.isArray(params.cursor)) return null;
  const kind = single(params.kind) || undefined;
  const cursor = single(params.cursor) || undefined;
  if (kind !== undefined && !historyKinds.includes(kind as HistoryFilter)) return null;
  if (cursor !== undefined && cursor.length > 2048) return null;
  return { kind: kind as HistoryFilter | undefined, cursor };
}

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(params: SearchParams): string | undefined {
  const cursor = single(params.cursor);
  return cursor && cursor.length <= 2048 ? cursor : undefined;
}

/** A chapter's reader address. The chapter is its table-of-contents occurrence. */
export const chapterHref = (ref: WorkAt, chapter: string, language?: string) =>
  withQuery(`/w/${encodeURIComponent(workRefOf(ref))}/read/${chapter}`, { language });

/** The reader of a Work read as one text: its Main Version's selected text, with no contents to choose from. */
export const textHref = (ref: WorkAt, language?: string) =>
  withQuery(`/w/${encodeURIComponent(workRefOf(ref))}/read`, { language });

/**
 * Where a chapter Work is read: at its place in its Book's reader, or the Book's Contents when it has no
 * place there now. A chapter is never shown as a Work of its own.
 */
export function chapterPlaceHref(partOf: { work: string; occurrence: string | null }): string | null {
  const book = idOf(partOf.work);
  const chapter = partOf.occurrence ? idOf(partOf.occurrence) : null;
  if (!book) return null;
  return chapter ? chapterHref(book, chapter) : workHref(book, 'contents');
}

/** The Contents tab's level, language and page. */
/** `open` names the volume (a top-level group) Contents shows open, such as the one being read. */
export interface ContentsQuery { parent?: string; language?: string; cursor?: string; open?: string }

export function parseContentsQuery(params: SearchParams): ContentsQuery | null {
  if ([params.parent, params.language, params.cursor, params.open].some(Array.isArray)) return null;
  const parent = single(params.parent) || undefined;
  const language = contentLanguage(single(params.language));
  const cursor = single(params.cursor) || undefined;
  const open = single(params.open) || undefined;
  if ((parent !== undefined && !uuid.test(parent)) || language === null
    || (cursor !== undefined && cursor.length > 2048) || (open !== undefined && !uuid.test(open))) return null;
  return { parent, language, cursor, ...(open ? { open } : {}) };
}

/** The reader's optional content language; a malformed one is refused. */
export function parseReaderLanguage(params: SearchParams): string | undefined | null {
  return Array.isArray(params.language) ? null : contentLanguage(params.language);
}
