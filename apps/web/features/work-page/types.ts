import type { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

// Main's Work read responses (`services/main/src/modules/work/read-contract.ts`),
// taken from the typed Eden client so a contract change breaks this build.
type Main = ReturnType<typeof treaty<MainApp>>;
type Work = ReturnType<Main['v1']['works']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

export type WorkHeader = Ok<Work['get']>;
export type WorkName = WorkHeader['title'];
export type WorkCover = WorkHeader['cover'];
export type VersionPage = Ok<Work['versions']['get']>;
export type WorkVersion = VersionPage['items'][number];
export type HistoryPage = Ok<Work['history']['get']>;
export type HistoryEntry = HistoryPage['items'][number];
export type HistoryKind = HistoryEntry['kind'];
export type DiscussionPage = Ok<Work['discussion']['get']>;
export type DiscussionItem = DiscussionPage['items'][number];
export type ContentsPage = Ok<Work['contents']['get']>;
export type ContentsItem = ContentsPage['items'][number];
export type ChapterRead = Ok<ReturnType<Main['v1']['chapters']>['get']>;
export type Progress = Ok<ReturnType<ReturnType<Main['v1']['compositions']>['occurrences']>['progress']['get']>;
export type AgentCreditPage = Ok<Work['agent-credits']['get']>;
export type AgentCredit = AgentCreditPage['items'][number];
export type AdoptionPage = Ok<Work['adoptions']['get']>;
export type Adoption = AdoptionPage['items'][number];
export type CreditPage = Ok<Work['credits']['get']>;
export type Credit = CreditPage['items'][number];
export type ClassificationPage = Ok<Work['classifications']['get']>;
export type Classification = ClassificationPage['items'][number];
export type RatingContextPage = Ok<Work['rating-contexts']['get']>;
export type RatingContext = RatingContextPage['items'][number];
export type RatingSummary = Ok<Work['ratings']['get']>;
export type RealmHeader = Ok<ReturnType<Main['v1']['realms']>['get']>;

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
