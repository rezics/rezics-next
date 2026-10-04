import type { MainClient, WorkCover, WorkName } from '../discover/types.ts';
import type { CatalogueAuthor } from '../catalogue/work.ts';
import { chapterHref, idOf } from '../work-page/route.ts';

// Main's phrase page shapes (`publicPhrasePageRequest`/`publicPhrasePageResult`
// in `services/main/src/api-contract.ts`), taken from the typed Eden client.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type PagePost = MainClient['v1']['queries']['page']['post'];

export type SearchPageRequest = Parameters<PagePost>[0];
/** Work-grain pages; this UI never asks for the Content-variant profile. */
export type SearchPage = Exclude<Ok<PagePost>, { profile: 'public-content-phrase-page-v1' }>;
type QueryResult = Ok<MainClient['v1']['query']['post']>['result'];
export type SearchContinuation = NonNullable<SearchPage['next']>
  | NonNullable<Extract<QueryResult, { profile: 'public-concept-set-phrase-v1' }>['next']>;
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
  /** A chapter's text matched: the chapter Post's title and its place in the result's Book. */
  chapter: { title: string; href: string } | null;
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
  /** Credited authors' display names and destinations in credit order. */
  authors: CatalogueAuthor[];
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
  /** Labels of the Concepts in the Condition bar, in the reader's language when the scheme has one. */
  concepts?: { id: string; name: string; language: string }[];
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
  | 'invalid' | 'unsupported' | 'unavailable';

export type SearchLoaded = { ok: true; page: SearchResultPage } | { ok: false; failure: SearchFailure };

export function searchFailureOf(status: number, code: string | undefined): SearchFailure {
  if (status === 409 || code === 'invalid_search_continuation') return 'restart';
  if (code === 'unsupported_query_shape' || code === 'unsupported_query_source') return 'unsupported';
  if (status === 422) return 'budget';
  if (status === 404) return 'missing';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

/** The matched chapter Post, linked by its address in the Book the result shows, which moves to its occurrence. */
function chapterOf(match: Match): MatchReasons['chapter'] {
  const book = match.matchedChapter && idOf(match.matchedChapter.book);
  const post = match.matchedChapter && idOf(match.matchedChapter.post);
  return match.matchedChapter && book && post
    ? { title: match.matchedChapter.title, href: chapterHref(book, post, match.language) } : null;
}

export function reasonsOf(match: Match): Omit<MatchReasons, 'classification'>
  & { classification: { concept: string | null; source: 'local' | 'global' } | null } {
  const classification = 'classification' in match ? match.classification : null;
  return { language: match.language, field: match.matchedField ?? 'body',
    matchedText: match.matchedField && match.matchedField !== 'body' ? match.matchedText ?? null : null,
    matchedLanguage: match.matchedLanguage ?? null, chapter: chapterOf(match),
    realm: 'reason' in match && (match.reason === 'realm-adoption' || match.reason === 'main-fallback')
      ? match.reason : null,
    classification: classification ? { concept: classification.concept ?? null,
      source: classification.source === 'local' ? 'local' : 'global' } : null };
}
