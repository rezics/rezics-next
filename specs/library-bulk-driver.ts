/**
 * LIBRARY_BULK_DRIVER is an absolute path/file URL exporting
 * createLibraryBulkDriver(): Promise<LibraryBulkDriver>.
 * Each instance owns an isolated migrated PostgreSQL database, real Auth tokens
 * and installed Access, and a production DBOS worker composed with
 * KERNEL_WORK_MODULES. close drains/stops only its worker and drops only its DB,
 * including partial setup failures. No shared development DB or fake Access.
 *
 * request maps verb/path/body to createKernel(...).handle and returns its raw
 * Response. Fixture methods call production semantic/entry/member/history
 * commands. They must not implement discovery, policy, CAS, counters, receipts,
 * effects or expected outcomes. No model, result normalization or selection in
 * this adapter. inspect reads actual authoritative native rows/receipts, not
 * workflow return values. Instrumentation observes real SQL and payloads.
 *
 * Bulk dispatch starts held; only runUntil/settle/resume release dispatch.
 * pauseAt parks at the named next production boundary; runUntil reaches it
 * without passing it. resume releases it. crashAt kills the owned executor once
 * at the boundary; runUntil returns once that owned process has exited. restart
 * uses its unchanged native DB and DBOS history. Hooks
 * do not replace commands or fabricate commits. settle runs all runnable work;
 * it does not turn pending/reconciling into success. Tests control retry clocks.
 */
import type {
  BulkAdmission,
  BulkCounters,
  BulkPhase,
  EntryExpectation,
  ImmutableTarget,
  OperationResult,
  OperationView,
  OutcomePage,
  ReceiptLocator,
  TargetEvidence,
  TargetState,
} from '../services/kernel/src/library/bulk-contract.ts';
import type { EntryState } from '../services/kernel/src/library/entry-model.ts';

export type { BulkAdmission, OperationResult, OperationView, OutcomePage };
export type Persona = 'owner' | 'other' | 'anonymous' | 'suspended' | 'delegated' | 'consent_revoked';
export type Boundary =
  | 'before_discovery_page'
  | 'after_discovery_commit'
  | 'after_discovery_seal'
  | 'after_occurrence_commit'
  | 'before_occurrence_ack'
  | 'after_occurrence_seal'
  | 'before_target_command'
  | 'before_target_commit'
  | 'after_target_commit'
  | 'before_outcome_ack'
  | 'after_outcome_ack'
  | 'before_segment_enqueue'
  | 'after_segment_enqueue';
export type AuthorityChange =
  | { kind: 'scope'; action: string; enabled: boolean }
  | { kind: 'role'; action: string; resourceId?: string; enabled: boolean }
  | { kind: 'gate'; gate: 'personal_library' | 'collections'; resourceId?: string; enabled: boolean }
  | { kind: 'consent' | 'delegation' | 'account'; enabled: boolean };
export interface BulkInspection {
  operations: {
    id: string;
    route: number;
    view: OperationView;
    sourceDigest: string;
    entryHighWater: string;
    occurrenceHighWater: string | null;
    generation: number;
    creationCommitment: string;
    durableInitiatorVerified: boolean;
  }[];
  targets: {
    operationId: string;
    target: ImmutableTarget;
    state: TargetState;
    receipt: ReceiptLocator;
    evidence: TargetEvidence | null;
  }[];
  entries: { subjectId: string; state: EntryState; revision: number; expectation: EntryExpectation }[];
  members: { id: string; collectionId: string; subjectId: string; incarnation: string; admissionSequence: string }[];
  history: { subjectId: string; sessions: string[]; changes: string[]; copies: string[]; follows: string[] }[];
  receipts: { locator: ReceiptLocator; transactionId: string; response: unknown }[];
  steps: {
    operationId: string;
    phase: BulkPhase;
    rawCandidates: number;
    targets: number;
    externalProbes: number;
    pagesInSegment: number;
    inputBytes: number;
    resultBytes: number;
    heldPartitions: number[];
    chunkIndex: number | null;
    rateUnits: number | null;
  }[];
  /** Actual attempted spend calls and persisted counter deltas, not target counts. */
  rate: {
    operationId: string;
    index: number;
    units: number;
    charged: number;
    allowed: boolean;
    restoredActorId: string;
    family: string;
  }[];
  events: { type: string; data: unknown; partition: number }[];
  enqueueIntents: { operationId: string; generation: number; acknowledged: boolean }[];
}
export interface LibraryBulkDriver {
  readonly accounts: Record<Exclude<Persona, 'anonymous'>, { id: string; route: number }>;
  readonly unknownOperationId: string;
  readonly unknownMemberId: string;
  setTime(instant: string): Promise<void>;
  now(): string;
  /** A fresh JSON-encoded UUIDv4 Idempotency-Key header value, no product rules. */
  key(): string;
  request(
    as: Persona,
    input: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  provisionEntries(
    count: number,
    input?: { state?: EntryState; primaryType?: string; as?: Persona },
  ): Promise<string[]>;
  provisionSubject(input?: { primaryType?: string; versionOf?: string }): Promise<string>;
  provisionCollection(input?: { as?: Persona; members?: readonly string[] }): Promise<string>;
  provisionHistory(subjectId: string): Promise<void>;
  /** Real ordinary putEntry, with omitted revision meaning validated create. */
  putEntry(subjectId: string, state: EntryState, revision?: number): Promise<void>;
  deleteEntry(subjectId: string, revision: number): Promise<void>;
  appendMember(collectionId: string, subjectId: string): Promise<string>;
  removeMember(collectionId: string, memberId: string): Promise<void>;
  reorderMember(collectionId: string, memberId: string): Promise<void>;
  /** Production semantic type update, to exercise discovery-time external probes. */
  changePrimaryType(subjectId: string, primaryType: string): Promise<void>;
  changeAuthority(as: Persona, change: AuthorityChange): Promise<void>;
  pauseAt(boundary: Boundary, occurrence?: number): Promise<void>;
  runUntil(boundary: Boundary): Promise<void>;
  resume(): Promise<void>;
  crashAt(boundary: Boundary, occurrence?: number): Promise<void>;
  restart(): Promise<void>;
  /** Replay the same registered segment/input, never generate new target keys. */
  replay(operationId: string): Promise<void>;
  settle(): Promise<void>;
  inspect(): Promise<BulkInspection>;
  rotateCursorKey(input: { retainPrevious: boolean }): Promise<void>;
  /** Fault injected at actual dependency boundary; unavailable is never denial. */
  fault(input: {
    dependency: 'enqueue' | 'receipt_read' | 'source_read' | 'write_rate';
    mode: 'unavailable' | 'missing' | 'refused' | 'clear';
    retryAfter?: number;
  }): Promise<void>;
  /** Expire only owned DBOS history / run production bounded native GC. */
  collect(input: { dbos?: boolean; native?: boolean }): Promise<void>;
  /** Grow independently, preserving fixture identities. No tested write is replayed by measure. */
  seed(
    scale: number,
    axis: 'entries' | 'sparse' | 'sessions' | 'jobs' | 'duplicates' | 'outcomes' | 'accounts',
  ): Promise<void>;
  measure<T>(
    body: () => Promise<T>,
  ): Promise<{ value: T; statements: number; rows: number; buffers: number; sequentialRelations: string[] }>;
  close(): Promise<void>;
}

/** Raw response wire schemas are exactly BulkAdmission, OperationResult and
 * OutcomePage above; validation and route mappings are specified in bulk-contract.md.
 * Setup never returns expected counters. These aliases make consumer checks explicit.
 */
export type CounterInspection = BulkCounters;
