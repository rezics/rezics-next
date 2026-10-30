/**
 * LIBRARY_DRIVER is an absolute path or file URL exporting
 * createLibraryDriver(): Promise<LibraryDriver>. Each call owns an isolated,
 * migrated PostgreSQL database and real Auth/Access personas with real tokens.
 * owner and other are distinct active accounts; anonymous has no token;
 * suspended has real suspended credentials, never a fabricated authentication failure.
 * Every request passes through createKernel(...).handle. A real DBOS executor
 * composed from KERNEL_WORK_MODULES runs the production library effects.
 * settle resumes and awaits all enqueued library work, including derived listings.
 * close stops the executor and removes the database and credentials, even on failure.
 *
 * Subjects (including editions) use semantic's production create path, never SQL.
 * Member fixtures and unrelated growth data use production commands, never SQL.
 * The driver maps transport only: no library, privacy, authorization, ordering or
 * projection rules, no in-memory model and no outcome normalization. request returns
 * the raw HTTP Response. inspect reads authoritative rows, CloudEvents and workflows
 * in stable primary-key order, without transient executor timestamps or counters.
 * subjectPartitionRows exhaustively exposes library-derived rows physically stored
 * on subject partitions, including provenance; it must not filter forbidden sources.
 * Instrumentation observes actual SQL, never constants, estimates or mutation replay.
 */
export type Persona = 'owner' | 'other' | 'anonymous' | 'suspended';
export type Visibility = 'private' | 'unlisted' | 'public';
export type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnit = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
export interface CollectionView {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: Visibility;
  revision: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface MemberView {
  id: string;
  subjectId: string;
  note: string | null;
  addedAt: string;
}
export interface EntryView {
  subjectId: string;
  incarnationId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SessionView {
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: ProgressMode;
  unit: ProgressUnit;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: 'active' | 'completed' | 'abandoned';
  revision: number;
  startedAt: string;
  completedAt: string | null;
}
export type RecordIntent =
  | { amount: string }
  | { locator: string; position: string }
  | { add?: string[]; remove?: string[] };
export interface ProgressChange {
  id: string;
  revision: number;
  intent: RecordIntent | { action: 'complete' | 'abandon' };
  createdAt: string;
}
export interface CopyView {
  id: string;
  subjectId: string;
  status: 'ordered' | 'owned' | 'lent' | 'disposed';
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
}
export interface FollowView {
  targetId: string;
  targetType: 'subject' | 'collection' | 'space';
  state: 'following' | 'unfollowed';
  reason: 'explicit' | 'library' | 'membership';
  updatedAt: string;
}
export interface PublishedLogView {
  id: string;
  accountId: string;
  subjectId: string;
  sessionState: SessionView['state'];
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
}
export interface PublicCollectionView {
  id: string;
  curatorAccountId: string;
  title: string;
  multiplicity: number;
}
export interface Anchor {
  id: string;
  route: number;
  partition: number;
}
export interface LibraryInspection {
  collections: (CollectionView & { route: number; partition: number })[];
  members: (MemberView & { collectionId: string; orderKey: string; route: number; partition: number })[];
  entries: (EntryView & { accountId: string; route: number; partition: number })[];
  sessions: (SessionView & { accountId: string; route: number; partition: number })[];
  completedUnits: { sessionId: string; unitId: string }[];
  changes: (ProgressChange & { sessionId: string })[];
  copies: (CopyView & { accountId: string; route: number; partition: number })[];
  follows: (FollowView & { accountId: string; route: number; partition: number })[];
  publishedLogs: PublishedLogView[];
  subjectPartitionRows: {
    subjectId: string;
    route: number;
    partition: number;
    table: string;
    key: string;
    source: 'entry' | 'session' | 'copy' | 'follow' | 'collection' | 'publishedLog';
    collectionId: string | null;
    visibility: Visibility | null;
    multiplicity: number | null;
  }[];
  events: { id: string; type: string; data: Record<string, unknown> }[];
  workflows: { id: string; name: string; status: string }[];
}
export interface LibraryDriver {
  readonly accounts: Record<Exclude<Persona, 'anonymous'>, Anchor>;
  /** Valid absent routable identifiers, never malformed validation failures. */
  readonly unknown: {
    collectionId: string;
    memberId: string;
    subjectId: string;
    sessionId: string;
    copyId: string;
    logId: string;
  };
  setTime(instant: string): Promise<void>;
  now(): string;
  provisionSubject(input?: { versionOf?: string }): Promise<Anchor>;
  request(
    as: Persona,
    input: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Response>;
  inspect(): Promise<LibraryInspection>;
  settle(): Promise<void>;
  /**
   * Append this many members: all but the last through the library store in batched transactions, the last through
   * the production member command. Seeded store members emit no events.
   */
  seedMembers(input: { collectionId: string; subjectId: string; count: number }): Promise<void>;
  /**
   * Grow unrelated data to this total in each relevant relation: collections,
   * members/order keys, entries, sessions, completed units, copies, follows, logs,
   * receipts. Include unrelated accounts sharing owner/subject
   * partitions as well as other partitions. Preserve all tested accounts' visible
   * data and tested collections, sessions and subjects; use bulk rows through test/support/growth-seed.ts that
   * reproduce what the production commands write, except semantic and outbox rows.
   */
  seed(scale: number): Promise<void>;
  /** Request SQL only; exclude seed/inspection SQL and asynchronous worker work. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; statements: number; buffers: number }>;
  close(): Promise<void>;
}
