// Author page addresses: `/authors/open-library/{OL…A}` and its `/works` list.
// Pure functions shared by the routes, the components and their tests; every
// place that names an author links through `authorHref`.

import type { AuthorCredit } from './types.ts';

// Open Library's author identifiers (`services/main/src/modules/source/author-name.ts`).
const openLibraryId = /^OL[1-9][0-9]{0,11}A$/;

/** The Open Library author key (`/authors/OL21594A`) a route segment names, or null when it names none. */
export function parseOpenLibraryAuthor(segment: string): string | null {
  return openLibraryId.test(segment) ? `/authors/${segment}` : null;
}

export type AuthorView = { kind: 'overview' } | { kind: 'works' };

/**
 * An Open Library author page's address from their key (`/authors/OL21594A`),
 * before the locale prefix. `/authors` is not yet one of the public page paths
 * `LocalizedLink` prefixes (`i18n/locale.ts`), so links add the prefix with
 * `localizedPath` themselves until it is.
 */
export function openLibraryAuthorHref(key: string, view: AuthorView = { kind: 'overview' }, cursor?: string): string {
  const path = `/authors/open-library/${key.replace(/^\/authors\//, '')}${view.kind === 'works' ? '/works' : ''}`;
  return cursor ? `${path}?${new URLSearchParams({ cursor })}` : path;
}

/**
 * Where an author's name leads: a REZICS Agent's profile (`/@handle`), or the
 * author page of someone Open Library lists. Work pages, cards and search
 * results link author names through this.
 */
export function authorHref(credit: Pick<AuthorCredit, 'kind'> & ({ kind: 'agent'; handle: string }
  | { kind: 'external'; key: string })): string {
  return credit.kind === 'agent' ? `/@${credit.handle}` : openLibraryAuthorHref(credit.key);
}

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;
}
