/**
 * LIBRARY_SHELVES_DRIVER is an absolute path or file URL exporting
 * createLibraryShelvesDriver(): Promise<LibraryShelvesDriver>. Each call owns an isolated, migrated PostgreSQL
 * database and the shared testKernel/Access personas with real Auth-issued tokens. Every request goes through
 * createKernel(...).handle; entries, sessions and their transitions are written only by the production HTTP commands,
 * and subjects only by semantic's production create path. The platform gates personal_library and reading_progress
 * start open. close removes the database, tokens and any installed gate state, even on failure.
 *
 * Personas (all active accounts unless stated; each holds only the scopes named):
 * - owner: the account under test, with every library and progress scope.
 * - other: a different account with the same scopes. It owns its own library and sessions.
 * - libraryOnly: the owner account, token consents to library_entry:* but not progress_session:list.
 * - progressOnly: the owner account, token consents to progress_session:* but not library_entry:list.
 * - ungranted: the owner account, token consents to no library or progress scope.
 * - anonymous: no token. suspended: real suspended credentials, never a fabricated failure.
 * Scope-limited personas see the owner's data, so a refusal cannot be mistaken for an empty library.
 *
 * The driver maps transport and setup only: no ordering, activity, active-session, cursor or authorization rules, no
 * in-memory model, no outcome normalization. request returns the raw Response. inspect reads authoritative rows in
 * stable primary-key order, bounded to the data the scenario created, never transient executor timestamps.
 * Instrumentation observes actual SQL, never constants, estimates or replayed mutations.
 */
export type Persona =
  | 'owner'
  | 'other'
  | 'libraryOnly'
  | 'progressOnly'
  | 'ungranted'
  | 'anonymous'
  | 'suspended';
export type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnit = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
export type Gate = 'personal_library' | 'reading_progress';

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
  activeProgressSession: SessionView | null;
  /** Present only for view=FULL. */
  subject?: unknown;
}
export interface ActivityRow {
  accountId: string;
  subjectId: string;
  /** Latest session change of this account and subject, null when none was ever persisted. */
  progressAt: string | null;
  /** The entry's persisted activity, null when no entry exists. */
  entryActivityAt: string | null;
}
export interface ShelvesInspection {
  entries: (EntryView & { accountId: string })[];
  sessions: (SessionView & { accountId: string })[];
  completedUnits: { sessionId: string; unitId: string }[];
  changes: { sessionId: string; revision: number }[];
  /** One row per account and subject with an entry or persisted progress activity. */
  activity: ActivityRow[];
  events: { id: string; type: string; data: Record<string, unknown> }[];
}
export interface ShelvesSeed {
  /** Totals of unrelated entries. Never owner or other entries; they never appear in a tested shelf. */
  entries: number;
  /** Totals of unrelated active sessions on unrelated accounts, subjects, or both. */
  activeSessions: number;
  /** Totals of completed and abandoned sessions, including history on the owner's tested subjects. */
  inactiveSessions: number;
}
export interface LibraryShelvesDriver {
  readonly accounts: Record<'owner' | 'other' | 'suspended', Anchor>;
  /** A valid absent routable subject id, never a malformed one. */
  readonly unknownSubjectId: string;
  /** Moves the kernel clock the commands read as T. It may move backward; nothing here enforces monotonic time. */
  setTime(instant: string): Promise<void>;
  now(): string;
  /** Makes cursor tokens issued so far appear this many milliseconds older to the kernel. */
  ageCursors(milliseconds: number): Promise<void>;
  provisionSubject(): Promise<Anchor>;
  provisionSubjects(count: number): Promise<Anchor[]>;
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
  settle(): Promise<void>;
  /**
   * Grow unrelated data to these totals through bulk rows that reproduce what the production commands write (including
   * the activity rows), preserving every tested row. Seeded timestamps precede 2030-01-01. Seeded sessions of the
   * owner's tested subjects are never active, so seeding cannot change a tested active session or activity.
   */
  seed(input: ShelvesSeed): Promise<void>;
  /** Request SQL only; excludes seed and inspection SQL and asynchronous worker work. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; statements: number; rows: number; buffers: number }>;
  close(): Promise<void>;
}
