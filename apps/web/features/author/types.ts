import type { MainClient } from '../discover/types.ts';

// Main's author reads (`services/main/src/routes/authors.ts`), taken from the
// typed Eden client so a contract change breaks this build.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type OpenLibraryAuthor = ReturnType<MainClient['v1']['authors']['open-library']>;

export type ExternalAuthor = Ok<OpenLibraryAuthor['get']>;
export type AuthorWorksPage = Ok<OpenLibraryAuthor['works']['get']>;
export type AuthorWork = AuthorWorksPage['items'][number];
export type AuthorCredit = AuthorWork['authors'][number];
export type AuthorFacts = NonNullable<ExternalAuthor['facts']>;
export type AuthorDate = NonNullable<AuthorFacts['birthDate']>;
export type AuthorIdentifier = AuthorFacts['identifiers'][number];
export type AuthorTotals = ExternalAuthor['totals'];

/**
 * Why a region has no data; each region shows its own and the page stays.
 * `missing` is Main's 404 (no public Work credits the author), `moved` a 409
 * under a cursor, `unavailable` anything else.
 */
export type ReadFailure = 'missing' | 'moved' | 'invalid' | 'unavailable';
export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number): ReadFailure {
  if (status === 404 || status === 410) return 'missing';
  if (status === 409) return 'moved';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}
