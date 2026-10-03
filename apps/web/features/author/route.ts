import { type AddressTarget } from '../address/path.ts';
import { profileHref } from '../profile/route.ts';
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

/** An Open Library author page's address from their key (`/authors/OL21594A`), before the locale prefix. */
export function openLibraryAuthorHref(key: string, view: AuthorView = { kind: 'overview' }, cursor?: string): string {
  const path = `/authors/open-library/${key.replace(/^\/authors\//, '')}${view.kind === 'works' ? '/works' : ''}`;
  return cursor ? `${path}?${new URLSearchParams({ cursor })}` : path;
}

/** How Main names an Open Library author as a follow target: `open-library:OL21594A` for `/authors/OL21594A`. */
export function externalAuthorFollow(key: string): string {
  return `open-library:${key.replace(/^\/authors\//, '')}`;
}

/**
 * Where an author's name leads: a REZICS Agent's profile (`/@handle`), or the
 * author page of someone Open Library lists. Work pages, cards and search
 * results link author names through this.
 */
export function authorHref(credit: Pick<AuthorCredit, 'kind'> & ({ kind: 'agent'; handle: string | null;
  agent?: string; id?: string; address?: AddressTarget }
  | { kind: 'external'; key: string })): string {
  return credit.kind === 'agent' ? profileHref({ ...credit, id: credit.agent ?? credit.id })
    : openLibraryAuthorHref(credit.key);
}

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;
}
