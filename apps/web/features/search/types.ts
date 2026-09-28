import type { MainClient, WorkCover, WorkName } from '../discover/types.ts';

// Main's phrase page shapes (`publicPhrasePageRequest`/`publicPhrasePageResult`
// in `services/main/src/api-contract.ts`), taken from the typed Eden client.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type PagePost = MainClient['v1']['queries']['page']['post'];

export type SearchPageRequest = Parameters<PagePost>[0];
/** Work-grain pages; this UI never asks for the Content-variant profile. */
export type SearchPage = Exclude<Ok<PagePost>, { profile: 'public-content-phrase-page-v1' }>;
export type SearchContinuation = NonNullable<SearchPage['next']>;
type Match = SearchPage['results'][number];

/** Where the phrase was found: Main ranks title matches first, then credited names, taglines and text. */
export type MatchField = 'title' | 'credit' | 'tagline' | 'body';

/** Why a Work matched, as Main states it. */
export interface MatchReasons {
  /** The published text's language. */
  language: string;
  /** The field that matched and its text, such as an original title or the author's name; body text has none. */
  field: MatchField;
  matchedText: string | null;
  matchedLanguage: string | null;
  /** Realm results: adopted by the Realm, or its Main Version because the Realm selected none. */
  realm: 'realm-adoption' | 'main-fallback' | null;
  /** Classified results: the accepted concept and whose decision placed it. */
  classification: { concept: string | null; conceptName: WorkName | null; source: 'local' | 'global' } | null;
}

/** One result with the title and cover hydrated from Main's resource summaries. */
export interface SearchHit {
  matchUnit: string;
  work: string;
  mainVersion: string;
  title: WorkName | null;
  cover: WorkCover | null;
  types: string[];
  /** Credited authors' display names in credit order; empty when Main names none. */
  authors: string[];
  rating: { mean: number; count: number; max: number } | null;
  tagline: WorkName | null;
  completion: 'ongoing' | 'completed' | 'hiatus' | null;
  reasons: MatchReasons;
}

export interface SearchResultPage {
  total: number;
  /** Published texts the index searched. */
  population: number;
  sequence: string;
  indexGeneration: string;
  next: SearchContinuation | null;
  hits: SearchHit[];
  facets?: SearchPage['facets'];
  /** False when Main answered but could not name the results; hits then show IDs. */
  titles: boolean;
}

export type SearchFailure =
  /** The continuation expired or the results changed: restart at page one. */
  | 'restart'
  /** The phrase matches more texts than Main ranks completely. */
  | 'budget'
  /** The Realm is not public or does not exist. */
  | 'missing'
  | 'invalid' | 'unavailable';

export type SearchLoaded = { ok: true; page: SearchResultPage } | { ok: false; failure: SearchFailure };

export function searchFailureOf(status: number, code: string | undefined): SearchFailure {
  if (status === 409 || code === 'invalid_search_continuation') return 'restart';
  if (status === 422) return 'budget';
  if (status === 404) return 'missing';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

export function reasonsOf(match: Match): Omit<MatchReasons, 'classification'>
  & { classification: { concept: string | null; source: 'local' | 'global' } | null } {
  const classification = 'classification' in match ? match.classification : null;
  return { language: match.language, field: match.matchedField ?? 'body',
    matchedText: match.matchedField && match.matchedField !== 'body' ? match.matchedText ?? null : null,
    matchedLanguage: match.matchedLanguage ?? null,
    realm: 'reason' in match && (match.reason === 'realm-adoption' || match.reason === 'main-fallback')
      ? match.reason : null,
    classification: classification ? { concept: classification.concept ?? null,
      source: classification.source === 'local' ? 'local' : 'global' } : null };
}
