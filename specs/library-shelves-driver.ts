/**
 * LIBRARY_SHELVES_DRIVER is an absolute path or file URL exporting
 * createLibraryShelvesDriver(): Promise<LibraryShelvesDriver>. Each call owns an isolated, migrated PostgreSQL
 * database and the shared testKernel/Access personas with real Auth-issued tokens. Every request goes through
 * createKernel(...).handle; entries, sessions, Collections and their transitions are written only by the production
 * HTTP commands, and subjects only by semantic's production create, identity-update and merge paths. The platform
 * gates personal_library and reading_progress start open. A real DBOS executor composed from the production work
 * modules runs the subject type projection. close removes the database, tokens and any installed gate state, even on
 * failure.
 *
 * Personas (all active accounts unless stated; each holds only the scopes named):
 * - owner: the account under test, with every library, Collection and progress scope.
 * - other: a different account with the same scopes. It owns its own library, Collections and sessions.
 * - libraryOnly: the owner account, token consents to library_entry:* but not progress_session:list.
 * - progressOnly: the owner account, token consents to progress_session:* but not library_entry:list.
 * - ungranted: the owner account, token consents to no library or progress scope.
 * - anonymous: no token. suspended: real suspended credentials, never a fabricated failure.
 * Scope-limited personas see the owner's data, so a refusal cannot be mistaken for an empty library.
 *
 * The driver maps transport and setup only: no ordering, activity, active-session, counter, type, cursor or
 * authorization rules, no in-memory model, no outcome normalization. request returns the raw Response. inspect reads
 * authoritative rows in stable primary-key order, bounded to the data the scenario created, never transient executor
 * timestamps. Every timestamp inspect returns is RFC 3339 UTC text like the API's, for example
 * 2030-01-02T00:05:00.000Z. Instrumentation observes actual SQL, never constants, estimates or replayed mutations.
 */
export type Persona = 'owner' | 'other' | 'libraryOnly' | 'progressOnly' | 'ungranted' | 'anonymous' | 'suspended';
export type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnit = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
export type Gate = 'personal_library' | 'reading_progress';
export type ShelfOrder = 'lastActivity' | 'finishedAt' | 'createdAt';
export type ShelfDirection = 'desc' | 'asc';
export type ShelfTab = EntryState | 'all' | 'collections';

export interface Anchor {
  id: string;
  route: number;
  partition: number;
}
export interface EntryView {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** The exact BASIC per-session shape GET /v1/progressSessions returns. */
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
export interface ShelfItem extends EntryView {
  lastActivityAt: string;
  finishedAt: string | null;
  activeProgressSession: SessionView | null;
  /** Present only for view=FULL. */
  subject?: unknown;
}
export interface ShelfSummaryView {
  tabs: Record<ShelfTab, { total: number; shown: number }>;
}
/** Native entry columns; subjectType is joined from the actual private dictionary value, never inferred. */
export interface StoredEntry extends EntryView {
  accountId: string;
  activityAt: string;
  finishedAt: string | null;
  subjectType: string;
  typeId: string;
  incarnationId: string;
  transactionId: string;
  sourceStamp: SourceStamp;
  /** The subject whose primary type this entry follows: its own subject, or the survivor after a merge. */
  typeSourceId: string;
}
/** Native bigint; serialize only at JSON/DBOS boundaries as canonical decimal text. */
export interface SourceStamp {
  partition: number;
  epoch: number;
  position: bigint;
}
export interface StoredTypeKey {
  accountId: string;
  typeId: string;
  type: string;
  byteLength: number;
}
export interface StoredSession extends SessionView {
  accountId: string;
  lastChangedAt: string;
}
export interface StoredHead {
  accountId: string;
  subjectId: string;
  lastChangedAt: string | null;
  lastCompletedAt: string | null;
}
export interface StoredCount {
  accountId: string;
  bucket: EntryState | 'all' | 'collections';
  /** Native bounded UUID; nil UUID is the all-types/Collections rollup. */
  typeId: string;
  count: number;
}
export interface ShelvesInspection {
  entries: StoredEntry[];
  /** Actual published native dictionary rows, including retained known-zero identities. */
  typeKeys: StoredTypeKey[];
  sessions: StoredSession[];
  completedUnits: { sessionId: string; unitId: string }[];
  changes: { sessionId: string; revision: number }[];
  /** Includes locked empty heads before progress; retained after entry deletion. */
  heads: StoredHead[];
  /** Counter rows, exactly as stored. A row at zero may linger; readers and tests ignore it. */
  counts: StoredCount[];
  /** Active Collections per account. */
  collections: { accountId: string; collectionId: string }[];
  events: { id: string; type: string; data: Record<string, unknown> }[];
}
export interface ShelvesSeed {
  /** Totals of unrelated entries on unrelated accounts and subjects. Never owner or other entries. */
  entries: number;
  /** Totals of unrelated active sessions on unrelated accounts, subjects, or both. */
  activeSessions: number;
  /** Totals of completed and abandoned sessions, including history on the owner's tested subjects. */
  inactiveSessions: number;
}
/** A one-shot latch at a real production observation boundary, never a replacement apply/resolver. */
export interface TypeWorkPause {
  reached: Promise<{ sourceId: string; stamp: SourceStamp; incarnationId?: string }>;
  /** Release and await this held workflow. Other workflows must run independently while it is held. */
  resume(): Promise<void>;
}
export interface LibraryShelvesDriver {
  readonly accounts: Record<'owner' | 'other' | 'suspended', Anchor>;
  /** A valid absent routable subject id, never a malformed one. */
  readonly unknownSubjectId: string;
  /** Three distinct primary types from the bundled definitions that semantic accepts on a subject. */
  readonly types: { readonly book: string; readonly anime: string; readonly game: string };
  /** Moves the kernel clock the commands read as T. Nothing here enforces monotonic time. */
  setTime(instant: string): Promise<void>;
  now(): string;
  /** Makes cursor tokens issued so far appear this many milliseconds older to the kernel. */
  ageCursors(milliseconds: number): Promise<void>;
  /** Defaults to the book type. */
  provisionSubject(input?: { type?: string }): Promise<Anchor>;
  provisionSubjects(count: number, input?: { type?: string }): Promise<Anchor[]>;
  /**
   * Publish/activate real validated definition releases declaring these exact ASCII CURIEs under shelf:.
   * Use compact labels and minimal declarations; the expanded IRI also consumes the release byte budget.
   * Keep the built-in persona types available. Existing subjects retain their stored types across releases.
   */
  installTypes(types: readonly string[]): Promise<void>;
  /**
   * Override only the production dictionary digest dependency, before entries exist, to force collisions.
   * Exact comparisons/trie/allocation remain production code. Never modify semantic source or type IDs.
   */
  forceTypeDigestCollision(): Promise<void>;
  pauseTypeWork(input: {
    workflow: 'sync' | 'verify' | 'entry';
    boundary: 'sourceObserved' | 'entryObserved';
    subjectId: string;
    accountId?: string;
  }): Promise<TypeWorkPause>;
  /** Production semantic identity update. Returns the source revision it emitted. */
  changeSubjectType(subjectId: string, type: string): Promise<{ revision: number }>;
  /** Production semantic merge of `from` into the survivor `into`. */
  mergeSubjects(input: { from: string; into: string }): Promise<void>;
  /**
   * Replays every com.rezics.subject.revised.v1 event recorded for the subject through the production event path:
   * again in emitted order, or in reverse order. It then settles.
   */
  redeliver(input: { subjectId: string; order: 'repeat' | 'reverse' }): Promise<void>;
  /** Closes or reopens a gate through the production exposure commands. */
  setGate(gate: Gate, open: boolean): Promise<void>;
  request(
    as: Persona,
    input: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Response>;
  inspect(): Promise<ShelvesInspection>;
  /**
   * Await all enqueued library work. exceptPaused drains independently runnable work without releasing latches;
   * the default requires callers to resume their latches first. close always releases owned latches on failure.
   */
  settle(input?: { exceptPaused?: boolean }): Promise<void>;
  /**
   * Grow unrelated data to these totals through bulk rows that reproduce what the production commands write (head,
   * counter and activity columns included), preserving every tested row. Seeded timestamps precede 2030-01-01.
   * Seeded sessions of the owner's tested subjects are never active, so seeding cannot change a tested active
   * session or activity.
   */
  seed(input: ShelvesSeed): Promise<void>;
  /** Request SQL only; excludes seed and inspection SQL and asynchronous worker work. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; statements: number; rows: number; buffers: number }>;
  close(): Promise<void>;
}
