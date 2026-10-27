/**
 * Test-only binding: CONTENT_NOTIFICATION_DRIVER is an absolute path or file URL
 * exporting createContentNotificationDriver(): Promise<ContentNotificationDriver>.
 * Each factory provisions an isolated migrated PostgreSQL namespace. close()
 * removes accounts, grants, receipts, notices, decisions, appeals and queued
 * effects, even after failure; factory failures clean their partial setup.
 *
 * API methods call production createKernel.handle with real signed credentials,
 * Access, accounts notificationAllowed and production command/effect boundaries.
 * Never implement policy, delivery, pagination or appeal transitions in the
 * adapter. response is the original HTTP Response; value is a lossless mapping
 * of its cloned JSON, never fixture data. Errors keep the full problem response
 * and have null value. Route spelling and JSON envelopes are implementation
 * choices; mapping field names/envelopes is permitted, inventing fields is not.
 * Write keys are sent as the production Idempotency-Key header.
 *
 * Fixtures may install accounts/grants and control the authoritative clock and
 * effect delivery, but never seed notices, decisions, reports or appeals. Every
 * content/moderation operation below uses the actual HTTP API. Effects start
 * paused. drain runs committed events to a barrier through production effects;
 * replay redelivers those same committed events through those effects. It must
 * not replay HTTP requests or manufacture event payloads. Assertions use only
 * API outcomes, with no SQL observation or synthetic result cache.
 */
export interface Persona {
  id: string;
  bearer: string;
}
export interface ApiResult<T> {
  response: Response;
  value: T | null;
}
export type NoticeKind = 'reply' | 'mention' | 'moderation_decision';
export type Target = { kind: 'thread' | 'post'; id: string };
export interface Post {
  id: string;
  threadId: string;
}
export interface Thread {
  id: string;
  firstPost: Post;
}
export interface Notice {
  id: string;
  kind: NoticeKind;
  createdAt: string;
  actorId: string | null;
  /** Exactly the applicable target IDs, with no authored text. */
  target: { threadId?: string; postId?: string; decisionId?: string; reportId?: string };
  unread: boolean;
}
export interface Inbox {
  items: Notice[];
  next: string | null;
}
export interface Decision {
  id: string;
  target: Target;
  action: 'takedown';
  statement: string;
  deciderId: string;
  createdAt: string;
  appealDeadline: string;
}
export interface Report {
  id: string;
  outcome: 'open' | 'actioned' | 'dismissed';
}
export interface Appeal {
  id: string;
  decisionId: string;
  appellantId: string;
  statement: string;
  outcome: 'pending' | 'uphold' | 'reverse';
  resolutionStatement: string | null;
}
export interface Fixture {
  author: Persona;
  replier: Persona;
  mentioned: Persona;
  nonMember: Persona;
  moderator: Persona;
  secondModerator: Persona;
  reporter: Persona;
  /** Eleven distinct active readers, separate from every named persona. */
  readers: Persona[];
  publicBoardId: string;
  protectedBoardId: string;
  now: string;
}
export interface WriteOptions {
  actor: Persona;
  key: string;
}
export interface ContentNotificationDriver {
  close(): Promise<void>;
  /**
   * Author, replier, mentioned, reporter and both moderators are protected Realm members;
   * nonMember is not. Both moderators hold moderation:takedown on that Realm's
   * content and public content; other personas do not. Readers can read public
   * content. Notification kinds initially enabled. Account and content routes
   * occupy different partitions to exercise recipient-routed delivery.
   */
  provision(): Promise<Fixture>;
  createThread(
    input: { boardId: string; body: unknown; visibility: 'published' | 'draft' },
    options: WriteOptions,
  ): Promise<ApiResult<Thread>>;
  createPost(
    input: { threadId: string; parentId?: string; body: unknown; visibility: 'published' | 'draft' },
    options: WriteOptions,
  ): Promise<ApiResult<Post>>;
  /** A draft's first transition to published is its first published revision. */
  revise(
    input: { post: Post; body: unknown; visibility: 'published' | 'draft' },
    options: WriteOptions,
  ): Promise<ApiResult<Post>>;
  readPost(post: Post, actor: Persona): Promise<ApiResult<Post>>;
  /** Ordinary content read response, including its current security revision. */
  readTarget(target: Target, actor: Persona): Promise<ApiResult<{ id: string; securityRevision: string }>>;
  inbox(accountId: string, actor: Persona, query?: { limit?: number; cursor?: string }): Promise<ApiResult<Inbox>>;
  unread(accountId: string, actor: Persona): Promise<ApiResult<{ count: number; capped: boolean }>>;
  markSeen(accountId: string, noticeId: string, options: WriteOptions): Promise<ApiResult<unknown>>;
  takedown(
    target: Target,
    reason: string,
    options: WriteOptions,
  ): Promise<
    ApiResult<{
      decisionId: string;
      securityRevision: string;
    }>
  >;
  decision(id: string, actor: Persona): Promise<ApiResult<Decision>>;
  report(target: Target, options: WriteOptions): Promise<ApiResult<{ reportId: string }>>;
  readReport(id: string, actor: Persona): Promise<ApiResult<Report>>;
  dismissReport(id: string, statement: string, options: WriteOptions): Promise<ApiResult<unknown>>;
  appeal(decisionId: string, statement: string, options: WriteOptions): Promise<ApiResult<Appeal>>;
  resolveAppeal(
    id: string,
    outcome: 'uphold' | 'reverse',
    statement: string,
    options: WriteOptions,
  ): Promise<ApiResult<Appeal>>;
  /** Map the pending appeals section of the real moderator queue response. */
  pendingAppeals(actor: Persona): Promise<ApiResult<Appeal[]>>;
  effects(mode: 'drain' | 'replay'): Promise<void>;
  fixtures: {
    /** Set actual preference evidence consumed by accounts' notificationAllowed. */
    notificationAllowed(account: Persona, kind: NoticeKind, allowed: boolean): Promise<void>;
    /** Change membership evidence, not an adapter visibility flag. */
    realmMember(account: Persona, member: boolean): Promise<void>;
    /**
     * Set authoritative account state. Reactivation is test-only, allowing an
     * API read to prove delivery was skipped while deleted; do not erase notices
     * in this hook or substitute the account-deletion cleanup workflow.
     */
    accountState(account: Persona, state: 'active' | 'deleted'): Promise<void>;
    /** Advance all authoritative clocks; keep credentials valid at that instant. */
    now(instant: string): Promise<void>;
  };
}
