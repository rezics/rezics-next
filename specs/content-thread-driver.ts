import type { DocumentSnapshot } from '@rezics/document';

/**
 * Test-only binding: CONTENT_THREAD_DRIVER is an absolute path or file URL whose
 * module exports createContentThreadDriver(): Promise<ContentThreadDriver>.
 * Each factory call provisions an isolated migrated PostgreSQL namespace. close
 * removes all fixtures, grants, receipts and effects, including after failures;
 * factory failures must clean up their own partial setup.
 *
 * Every create/read/revise/reply binds to production createKernel.handle with
 * real Access and JWT verification. Do not reproduce authorization, canonical
 * serialization, state transitions or runCommand in the adapter. Route spelling
 * is deliberately left to the implementation. Response is the original HTTP
 * response; value is a lossless field mapping of its JSON read via clone(), never
 * seeded data. Error results have null value and keep the full problem response.
 * Fixture SQL and failure hooks stay test-only. Inspection reads authoritative
 * rows on an independent connection after requests finish, never an API cache.
 * Forward optional metadata exactly, including explicit empty subjectIds; do not
 * fill defaults in the adapter. Item views map the selected revision's stored
 * licence, subjectIds and boardId, never reconstructed thread inheritance.
 */
export interface Persona {
  id: string;
  bearer: string;
}
export type Visibility = 'published' | 'draft' | 'protected' | 'taken_down';
export interface WriteOptions {
  actor: Persona | null;
  /** Structured Idempotency-Key header value. */
  key: string;
  /** Sent only as the production session request header. */
  session?: string;
}
export interface ThreadInput {
  title: string;
  body: unknown;
  licence: string;
  subjectIds: string[];
  boardId: string;
  visibility: 'published' | 'draft';
  /** Untrusted JSON field, never an authenticated identity. */
  authorId?: string;
}
export interface ItemInput {
  threadId: string;
  body: unknown;
  licence: string;
  /** Omission may inherit thread defaults; [] is the author's empty references. */
  subjectIds?: string[];
  /** If supplied, must match the containing thread's board; never moves content. */
  boardId?: string;
  authorId?: string;
}
export interface ItemView {
  id: string;
  threadId: string;
  route: number;
  revisionId: string;
  authorId: string;
  licence: string;
  subjectIds: string[];
  boardId: string;
  parentId: string | null;
  body: DocumentSnapshot;
}
export interface ThreadView {
  id: string;
  route: number;
  title: string;
  authorId: string;
  licence: string;
  subjectIds: string[];
  boardId: string;
  firstPost: ItemView;
}
export interface ApiResult<T> {
  response: Response;
  value: T | null;
}
export interface RevisionRow {
  id: string;
  itemId: string;
  threadId: string;
  route: number;
  body: Uint8Array;
  sha256: string;
  searchText: string;
  licence: string;
  subjectIds: string[];
  boardId: string;
}
export interface Evidence {
  threads: { id: string; route: number; boardId: string; authorId: string }[];
  items: { id: string; threadId: string; route: number; parentId: string | null; authorId: string }[];
  revisions: RevisionRow[];
  /** All durable receipts in this namespace, not just successful request IDs. */
  receipts: { key: string; partition: number; command: string }[];
  outbox: {
    id: string;
    partition: number;
    command: string;
    idempotencyKey: string;
    eventSequence: number;
    eventType: string;
    envelope: { threadId: string; itemId: string; revisionId: string; actorId: string };
  }[];
  claims: { id: string; itemId: string }[];
  semanticRows: string[];
}
export interface Fixture {
  owner: Persona;
  other: Persona;
  moderator: Persona;
  board: { id: string; route: number };
  privateBoard: { id: string; route: number };
  /** At least three distinct valid subject IDs, with no corresponding semantic rows. */
  subjectIds: string[];
  /** Well-formed unused IDs; foreignItem belongs to foreignThread on another route. */
  unknownThread: string;
  unknownItem: string;
  foreignThread: ThreadView;
  foreignItem: ItemView;
}
export interface ContentThreadDriver {
  close(): Promise<void>;
  /**
   * Active accounts with real signed credentials; public/private containers and
   * reference IDs. Owner has only standing parent thread:create grants through
   * the accounts-owned principal model, no grants on prospective thread IDs.
   * Other/moderator may create on the public board. Moderator has moderation
   * rights on created content but no body authorship. No semantic rows are needed.
   */
  provision(): Promise<Fixture>;
  create(input: ThreadInput, options: WriteOptions): Promise<ApiResult<ThreadView>>;
  createPost(input: ItemInput, options: WriteOptions): Promise<ApiResult<ItemView>>;
  reply(input: ItemInput & { parentId: string }, options: WriteOptions): Promise<ApiResult<ItemView>>;
  /** Omitted metadata preserves the prior revision; boardId must still match the thread. */
  revise(
    input: {
      threadId: string;
      itemId: string;
      body: unknown;
      authorId?: string;
      licence?: string;
      subjectIds?: string[];
      boardId?: string;
    },
    options: WriteOptions,
  ): Promise<ApiResult<ItemView>>;
  readThread(id: string, actor: Persona | null): Promise<ApiResult<ThreadView>>;
  readItem(threadId: string, itemId: string, actor: Persona | null, revisionId?: string): Promise<ApiResult<ItemView>>;
  readHistory(threadId: string, itemId: string, actor: Persona | null): Promise<ApiResult<ItemView[]>>;
  readItems(threadId: string, actor: Persona | null): Promise<ApiResult<ItemView[]>>;
  readList(boardId: string, actor: Persona | null): Promise<ApiResult<ThreadView[]>>;
  inspect(): Promise<Evidence>;
  /** Await authoritative fixture changes; do not replace API transition logic. */
  fixtures: {
    /** Revoke exactly this parent create authorization; retain read and own-edit rights. */
    revokeParentCreate(actorId: string, boardId: string): Promise<void>;
    suspend(actorId: string): Promise<void>;
    visibility(id: string, state: Visibility): Promise<void>;
    /** Fail the next command after its content inserts, before outbox commit. */
    failBeforeOutbox(): Promise<void>;
  };
  /** Actual catalog metadata, not adapter constants. */
  storage(): Promise<{ schema: string; bodyType: string; compression: string }>;
  /**
   * Attempt an INSERT of a new otherwise-valid revision, cloning source metadata
   * and supplying these exact bytes/digest. Return PostgreSQL error evidence;
   * rollback the probe transaction. Do not prevalidate in TypeScript.
   */
  probeRevision(
    sourceRevisionId: string,
    body: Uint8Array,
    sha256: string,
  ): Promise<{
    sqlstate: string;
    constraint: string;
  }>;
  /** Decode and verify the real response session header with production keys. */
  session(response: Response, actor: Persona): Promise<{ token: string; partitions: number[] }>;
  /** Actual SQL executions for the last request, with parent checks decoded from their native query bindings. */
  commandTrace(): Promise<{
    queries: { statement: string; connectionId: number; index: number }[];
    checks: {
      action: string;
      resourceId: string;
      partition: number;
      statement: number;
      connectionId: number;
      at: string;
    }[];
    fences: { partition: number; statement: number; connectionId: number }[];
  }>;
}
