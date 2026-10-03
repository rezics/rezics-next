import type { MainClient } from '../discover/types.ts';

// Main's Work read responses (`services/main/src/modules/work/read-contract.ts`),
// taken from the typed Eden client so a contract change breaks this build.
type Main = MainClient;
type Work = ReturnType<Main['v1']['works']>;
type Resource = ReturnType<Main['v1']['resources']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

export type WorkHeader = Ok<Work['get']>;
export type RecipeWorkPage = NonNullable<Ok<ReturnType<Main['v1']['recipes']['works']>['get']>>;
export type HubWorkPage = NonNullable<Ok<ReturnType<Main['v1']['hub']['works']>['get']>>;
export type WorkName = WorkHeader['title'];
export type WorkCover = WorkHeader['cover'];
export type VersionPage = Ok<Work['versions']['get']>;
export type WorkVersion = VersionPage['items'][number];
export type HistoryPage = Ok<Work['history']['get']>;
export type HistoryEntry = HistoryPage['items'][number];
export type HistoryKind = HistoryEntry['kind'];
export type DiscussionPage = Ok<Resource['discussion']['get']>;
export type DiscussionItem = DiscussionPage['items'][number];
export type ContentsPage = Ok<Work['contents']['get']>;
export type ContentsItem = ContentsPage['items'][number];
export type ChapterRead = Ok<ReturnType<Main['v1']['chapters']>['get']>;
/** A Main Version's selected text: the one text a Work without contents is read as. */
export type WorkText = Ok<ReturnType<Main['v1']['main-versions']>['selection']['get']>;
export type Progress = Ok<ReturnType<ReturnType<Main['v1']['compositions']>['occurrences']>['progress']['get']>;
export type AgentCreditPage = Ok<Work['agent-credits']['get']>;
export type AgentCredit = AgentCreditPage['items'][number];
export type AdoptionPage = Ok<Work['adoptions']['get']>;
export type Adoption = AdoptionPage['items'][number];
export type CreditPage = Ok<Work['credits']['get']>;
export type Credit = CreditPage['items'][number];
export type ClassificationPage = Ok<Work['classifications']['get']>;
export type Classification = ClassificationPage['items'][number];
export type RatingContextPage = Ok<Resource['rating-contexts']['get']>;
export type RatingContext = RatingContextPage['items'][number];
export type RatingSummary = Ok<Resource['ratings']['get']>;
export type RealmHeader = Ok<ReturnType<Main['v1']['realms']>['get']>;
export type AgentWorksPage = Ok<ReturnType<Main['v1']['agents']>['works']['get']>;
export type AgentProfile = Ok<ReturnType<Main['v1']['agents']>['get']>;
export type ReviewPage = Ok<Resource['reviews']['get']>;
export type Review = ReviewPage['items'][number];
export type ReviewQuery = NonNullable<Parameters<Resource['reviews']['get']>[0]>['query'];
export type AlsoEnjoyedPage = Ok<Work['also-enjoyed']['get']>;
export type AlsoEnjoyedItem = AlsoEnjoyedPage['items'][number];
/** People reading the Work now and its reviews, counted from public libraries (`work/read-stats.ts`). */
export type WorkStats = Ok<Work['reader-stats']['get']>;
export type StatCount = WorkStats['reading'];

/** A reviewer as the page names them; null while Main cannot. */
export interface Reviewer { name: string; handle: string | null }

/** A scope's rating summary with the Context (question) it answers. */
export interface RatingRead {
  /** The standing rating Contexts this scope supports (one page of at most 20). */
  contexts: RatingContext[];
  /** The Context the summary answers, or null when the scope has none. */
  context: RatingContext | null;
  summary: RatingSummary;
}

/** Why a region has no data. Each region shows its own and the rest of the page stays. */
export type ReadFailure =
  /** Main answered 404: missing, private or not visible in this scope. */
  | 'missing'
  /** The read needs a signed-in person (Mine) or an acting identity. */
  | 'sign-in' | 'identity'
  /** The data changed under a cursor; restart from the first page. */
  | 'moved'
  /** Main refused the request as malformed, or over its read budget. */
  | 'invalid' | 'budget'
  /** Main or a source it reads is down or timed out; retrying may help. */
  | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };
