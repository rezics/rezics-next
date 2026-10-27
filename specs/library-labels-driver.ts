/**
 * LIBRARY_LABELS_DRIVER is an absolute path or file URL exporting
 * createLibraryLabelsDriver(): Promise<LibraryLabelsDriver>.
 *
 * Each factory call owns an isolated migrated PostgreSQL database, real Auth/Access accounts and tokens, the real
 * personal-library gate, and a DBOS executor composed from production work modules. `owner` and `other` are distinct
 * active accounts with the existing library scopes; `unscoped` is an owner token without those scopes; `suspended`
 * has real suspended credentials; `anonymous` has no token. Subjects and Collection fixtures use their production
 * create/update commands. The driver maps fixture setup and transport only: it contains no label policy, access map, in-memory
 * product model, outcome normalization, or fake positive authorization. Inspection returns actual native rows and
 * production public responses. SQL instrumentation observes the command under test, excluding setup, inspection,
 * and asynchronous cleanup work.
 */
export type LibraryLabelsPersona = 'owner' | 'other' | 'anonymous' | 'suspended' | 'unscoped';
export type LabelAction =
  | 'library_label.create'
  | 'library_label.rename'
  | 'library_label.delete'
  | 'library_label.assign'
  | 'library_label.unassign'
  | 'library_label.list'
  | 'library_label.assignment_list';
export type LibraryEntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
export type CollectionVisibility = 'private' | 'unlisted' | 'public';
export type PersonalFactKind = 'state' | 'label' | 'session' | 'holding' | 'follow';

export interface AccountAnchor {
  id: string;
  route: number;
  partition: number;
}

export interface SubjectAnchor {
  id: string;
  route: number;
  partition: number;
}

export interface NativeLabelRow {
  ownerAccountId: string;
  ownerRoute: number;
  labelId: string;
  normalizedName: string;
  revision: number;
  generation: number;
  deletedAt: string | null;
}

export interface NativeAssignmentRow {
  ownerAccountId: string;
  ownerRoute: number;
  subjectId: string;
  labelId: string;
  revision: number;
}

/** Raw source rows from the shared owner subject-fact index, not a derived count or test-side policy map. */
export interface NativeSubjectFactRow {
  ownerAccountId: string;
  ownerRoute: number;
  subjectId: string;
  kind: PersonalFactKind;
  sourceId: string;
  active: boolean;
}

export interface NativeReceiptRow {
  ownerAccountId: string;
  action: string;
  keyDigest: string;
  resultDigest: string;
}

export interface NativeOutboxRow {
  type: string;
  subject: string;
  data: Record<string, unknown>;
}

export interface NativeCleanupRow {
  ownerAccountId: string;
  labelId: string;
  generation: number;
  state: 'pending' | 'running' | 'complete' | 'superseded';
  lastSubjectId: string | null;
  committedPages: number;
}

export interface LibraryLabelsInspection {
  labels: NativeLabelRow[];
  assignments: NativeAssignmentRow[];
  subjectFacts: NativeSubjectFactRow[];
  entries: { ownerAccountId: string; subjectId: string; state: string; revision: number }[];
  sessions: { ownerAccountId: string; subjectId: string; sessionId: string; state: string }[];
  holdings: { ownerAccountId: string; subjectId: string; holdingId: string; status: string }[];
  follows: { ownerAccountId: string; targetId: string; targetType: string; state: string }[];
  receipts: NativeReceiptRow[];
  privateOutbox: NativeOutboxRow[];
  cleanup: NativeCleanupRow[];
  /** Exact public listing rows and public events on each inspected subject partition. */
  publicSubjectRows: {
    subjectId: string;
    table: string;
    collectionId: string | null;
    multiplicity: number | null;
    eventType: string | null;
  }[];
}

export interface PublicExposure {
  /** Raw response from the public subject and search surfaces for this subject. */
  publicResponses: unknown[];
  /** Public native FTS/count/who-read/listing rows, ordered by their actual keys. */
  publicRows: unknown[];
}

export interface PageObservation<T> {
  value: T;
  /** Candidate rows returned by the indexed keyset statement, captured from actual SQL instrumentation. */
  candidatesExamined: number;
  rowsReturned: number;
  /** Peak rows held by the request-side page adapter, observed rather than estimated. */
  peakRowsInMemory: number;
}

export interface CommandObservation<T> {
  value: T;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  buffers: number;
}

export interface CleanupLatch {
  reached: Promise<void>;
  resume(): void;
}

export type CommandTraceEvent =
  | { sequence: number; phase: 'admission_complete'; action: string; authorized: boolean }
  | { sequence: number; phase: 'receipt_read'; action: string };

export interface TracedCommand<T> {
  value: T;
  /** Actual Access return and core receipt SQL read order observed on the production execution path. */
  events: CommandTraceEvent[];
}

export interface LibraryLabelsDriver {
  readonly accounts: Record<Exclude<LibraryLabelsPersona, 'anonymous'>, AccountAnchor>;
  /** Valid unknown label and subject IDs with the same syntax as provisioned IDs. */
  readonly unknown: { labelId: string; subjectId: string };

  provisionSubject(): Promise<SubjectAnchor>;

  /**
   * Invoke the production action with a real persona. `input` is encoded as strict JSON by the real transport.
   * `idempotencyKey` is sent as the common request key. Responses are raw; the driver must not normalize errors.
   */
  invoke(
    as: LibraryLabelsPersona,
    action: LabelAction,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Response>;

  /** Send raw JSON bytes through the production parser to cover duplicate keys and coercion rejection. */
  invokeRaw(as: LibraryLabelsPersona, action: LabelAction, rawJson: string, idempotencyKey?: string): Promise<Response>;

  /** Existing Library commands, each routed through the real production HTTP boundary. */
  setState(as: LibraryLabelsPersona, subjectId: string, state: LibraryEntryState | null): Promise<Response>;
  createProgressSession(as: LibraryLabelsPersona, subjectId: string): Promise<Response>;
  createHolding(as: LibraryLabelsPersona, subjectId: string): Promise<Response>;
  followSubject(as: LibraryLabelsPersona, subjectId: string): Promise<Response>;
  readPersonalSubject(as: LibraryLabelsPersona, subjectId: string): Promise<Response>;

  /** Existing Collection commands and reads, without changing their production routes or scopes. */
  createCollection(as: LibraryLabelsPersona, visibility: CollectionVisibility): Promise<{ id: string }>;
  appendCollectionMember(as: LibraryLabelsPersona, collectionId: string, subjectId: string): Promise<void>;
  setCollectionVisibility(
    as: LibraryLabelsPersona,
    collectionId: string,
    visibility: CollectionVisibility,
  ): Promise<void>;
  readPublicCollection(collectionId: string): Promise<Response>;

  /** Actual raw rows, selected only by the explicit keys supplied by the scenario. */
  inspect(input: {
    owner: LibraryLabelsPersona;
    subjectIds?: readonly string[];
    labelIds?: readonly string[];
  }): Promise<LibraryLabelsInspection>;
  publicExposure(subjectId: string): Promise<PublicExposure>;

  /**
   * Grow unrelated definitions and assignments only through production commands. Each subject still obeys the
   * production 32-row cap. This setup is outside measured command intervals.
   */
  growUnrelated(input: { labels: number; assignments: number }): Promise<void>;
  /** Capture actual SQL rows/statements for exactly one operation, excluding setup, inspection, and workers. */
  measure<T>(operation: () => Promise<T>): Promise<CommandObservation<T>>;
  /** Capture the actual indexed statement and request page memory for one keyset read. */
  measurePage<T>(operation: () => Promise<T>): Promise<PageObservation<T>>;
  /** Instrument real Access admission and native receipt reads; do not infer trace events from response status. */
  traceCommand<T>(operation: () => Promise<T>): Promise<TracedCommand<T>>;

  startLabelCleanup(labelId: string): Promise<string>;
  runCleanupPage(runId: string): Promise<void>;
  pauseAfterCleanupCommit(runId: string): Promise<CleanupLatch>;
  crashCleanupWorker(runId: string): Promise<void>;
  resumeCleanup(runId: string): Promise<void>;
  deleteAccount(as: LibraryLabelsPersona): Promise<Response>;
  settle(): Promise<void>;
  close(): Promise<void>;
}
