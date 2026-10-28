import type { DocumentSnapshot } from '@rezics/document';

/**
 * Test-only binding: CONTENT_USER_CASES_DRIVER is an absolute path or file URL
 * exporting createContentUserCasesDriver(): Promise<ContentUserCasesDriver>.
 * The factory owns an isolated native kernel and migrated PostgreSQL namespace.
 * close() removes accounts, grants, content, votes, figures, receipts and queued
 * effects even after failure. Factory failures clean their partial setup.
 *
 * Every request is real HTTP through production createKernel.handle, with native
 * Auth signature verification, real signed credentials, native Access and the
 * production command, effect and relay boundaries. Write keys become production
 * Idempotency-Key headers. No adapter implements authorization, pagination,
 * citation snapshots, ranking, aggregation or response redaction.
 *
 * response is the original HTTP Response; value losslessly maps cloned response
 * JSON fields/envelopes only. Errors preserve the full problem response and have
 * null value. Missing API fields cannot be invented from fixture knowledge or
 * direct database reads. Subject presentation and search card methods read real
 * consumer APIs using the native public-figure producer, never adapter-built cards.
 * Figure state maps the API's explicit readiness; numeric units are not rescaled.
 *
 * provision maps specs/fixtures/content-user-cases.json logical names to created
 * IDs. All subjects, boards and Realm resources are created through production
 * HTTP. Fixtures may install accounts and grants and control authoritative clocks
 * and delivery, but never seed votes, threads, reviews, aggregates or figures.
 * Distinct voters have distinct controllers. Readers, authors and boards span
 * partitions so the production relay is required. Effects start paused; drain
 * settles committed events through production effects, relays and figure workers.
 * No event payload, aggregate row or figure snapshot may be manufactured.
 *
 * holdPage arms a one-shot production test timing barrier after the initial board
 * check and before final serialization, for exactly the supplied HTTP request.
 * reached resolves only when that check has really completed. The barrier changes
 * timing only: queries, Access, final disclosure and serialization remain native.
 * release resumes that same request, never retries or filters its response.
 * close releases outstanding barriers and joins pending requests before cleanup.
 * Assertions observe API outcomes only; no SQL observation or synthetic cache.
 */
export interface Persona {
  id: string;
  bearer: string;
}
export interface ApiResult<T> {
  response: Response;
  value: T | null;
}
export interface WriteOptions {
  actor: Persona;
  key: string;
}
export interface Fixture {
  reader: Persona;
  outsider: Persona;
  moderator: Persona;
  voters: Persona[];
  priorVoters: Persona[];
  privateVoters: Persona[];
  unpublishedVoter: Persona;
  subjectId: string;
  otherSubjectId: string;
  belowThresholdSubjectId: string;
  priorSubjectIds: string[];
  standardQuestionId: string;
  globalPopulationId: string;
  privateRealmId: string;
  globalContextId: string;
  publicReviewsBoardId: string;
  protectedReviewsBoardId: string;
}
export interface Citation {
  questionId: string;
  units: number;
  revision: number;
}
export interface Vote extends Citation {
  subjectId: string;
}
export interface Post {
  id: string;
  threadId: string;
  revisionId: string;
  boardId: string;
  subjectIds: string[];
  licence: string;
  body: DocumentSnapshot;
  voteCitation: Citation | null;
}
export interface Thread {
  id: string;
  title: string;
  boardId: string;
  subjectIds: string[];
  kind: 'review' | 'discussion';
  firstPost: Post;
}
export interface ThreadInput {
  boardId: string;
  title: string;
  kind: 'review' | 'discussion';
  subjectIds: string[];
  body: unknown;
  licence: string;
  visibility: 'published' | 'draft';
  voteCitation?: Citation;
}
/** Fields are present only when returned by the API; absent metadata stays absent. */
export interface Page<T> {
  items: T[];
  next: string | null;
  count?: number;
  summary?: unknown;
  sources?: unknown[];
}
export interface Figure {
  questionId: string;
  populationId: string;
  /** Stored integer vote units 0..20; display values 0..10, one unit = 0.5. */
  units: { minimum: number; maximum: number; displayStep: number };
  count: number;
  state: 'ready' | 'insufficient_data' | 'updating';
  /** Display scale 0..10; absent numeric fields stay absent below threshold. */
  mean?: number | null;
  score?: number | null;
}
export type Sort = 'hot' | 'active' | 'newest';
export type PageRequest =
  | { kind: 'board'; boardId: string; sort: Sort; actor: Persona; limit: number; cursor?: string }
  | { kind: 'posts'; boardId: string; threadId: string; actor: Persona; limit: number; cursor?: string };
export interface HeldPage {
  reached: Promise<void>;
  response: Promise<ApiResult<Page<{ id: string }>>>;
  release(): Promise<void>;
}
export interface ContentUserCasesDriver {
  close(): Promise<void>;
  /**
   * reader is the protected Realm member with an independent revocable board
   * read grant; outsider cannot read it. Moderator can take boards/posts down,
   * revoke that grant and manage the private Realm. Both review boards have
   * purpose reviews in Global, so protected candidates exercise disclosure rather
   * than merely a place mismatch. All voters, outsider and moderator can create
   * public reviews; reader can create on the protected reviews board. All data
   * titles are controlled test data, never real works.
   */
  provision(): Promise<Fixture>;
  putVote(subjectId: string, questionId: string, units: number, options: WriteOptions): Promise<ApiResult<Vote>>;
  ownVote(subjectId: string, questionId: string, owner: Persona, viewer: Persona | null): Promise<ApiResult<Vote>>;
  createThread(input: ThreadInput, options: WriteOptions): Promise<ApiResult<Thread>>;
  createPost(
    input: { threadId: string; body: unknown; licence: string },
    options: WriteOptions,
  ): Promise<ApiResult<Post>>;
  revise(post: Post, input: { body: unknown; licence: string }, options: WriteOptions): Promise<ApiResult<Post>>;
  readRevision(postId: string, revisionId: string, actor: Persona | null): Promise<ApiResult<Post>>;
  readPost(postId: string, actor: Persona | null): Promise<ApiResult<Post>>;
  subjectReviews(
    subjectId: string,
    placeId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ApiResult<Page<Thread>>>;
  subjectFigure(subjectId: string, actor: Persona | null): Promise<ApiResult<Figure>>;
  searchCard(subjectId: string, actor: Persona | null): Promise<ApiResult<{ subjectId: string; figure: Figure }>>;
  realmFigure(subjectId: string, realmId: string, actor: Persona | null): Promise<ApiResult<Figure>>;
  /** Change membership via real HTTP; same votes count in Global and the Realm. */
  joinPrivateRealm(member: Persona, options: WriteOptions): Promise<ApiResult<unknown>>;
  /** Make a vote ineligible via the native account lifecycle, not by editing it. */
  suspend(account: Persona, options: WriteOptions): Promise<ApiResult<unknown>>;
  /** Creates a discussion board with native reader participation/read grants. */
  createBoard(visibility: 'published' | 'protected', options: WriteOptions): Promise<ApiResult<{ id: string }>>;
  takedown(target: { kind: 'board' | 'post'; id: string }, options: WriteOptions): Promise<ApiResult<unknown>>;
  /** Revoke the reader's sole effective protected-board read grant through Access HTTP. */
  revokeBoardRead(boardId: string, reader: Persona, options: WriteOptions): Promise<ApiResult<unknown>>;
  page(request: PageRequest): Promise<ApiResult<Page<{ id: string }>>>;
  holdPage(request: PageRequest): Promise<HeldPage>;
  effects(mode: 'drain' | 'replay'): Promise<void>;
}
