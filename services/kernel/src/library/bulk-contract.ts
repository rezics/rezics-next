/** Bulk integration ports; Collection occurrence removal delegates to its native executor. */
import { executeCollectionRemoveTarget as removeCapturedOccurrence } from './collection-bulk-remove.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime, CommandOutcome, CommandTransaction } from '../command/command.ts';
import type {
  DurableInitiatorReader,
  DurableInitiatorRecord,
  DurableOperationAnchor,
  InitiatorRestorer,
} from '../access/durable-initiator.ts';
import type { WriteRateContext, WriteRateDecision, WriteRateFamily } from '../access/write-rate.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkContext } from '../work/registry.ts';
import type { EntryState } from './entry-model.ts';

export const BULK_PAGE_LIMIT = 100;
export const BULK_SEGMENT_PAGES = 100;
export const BULK_EXECUTION_HOURS = 24;
export const BULK_RESULTS_HOURS = 48;
export const BULK_COMMAND_DEADLINE_MS = 5_000;
export { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';
export type DecimalSequence = string; // canonical nonnegative bigint decimal, compared numerically
export type SubjectSelection =
  | { kind: 'explicit'; targets: readonly { subjectId: string }[] }
  | {
      kind: 'query';
      filter: {
        state?: EntryState;
        /** Raw type identifier; no per-id length cap. The shelf reader's opaque type-key codec is a dependency. */ primaryType?: string;
      };
    };
export type OccurrenceSelection = { kind: 'occurrences'; memberIds: readonly string[] };
export type BulkAdmission =
  | { action: 'set_status'; state: EntryState; selection: SubjectSelection }
  | { action: 'add_to_collection'; collectionId: string; selection: SubjectSelection }
  | { action: 'remove_from_collection'; collectionId: string; selection: SubjectSelection | OccurrenceSelection }
  | { action: 'remove_from_library'; selection: SubjectSelection };
export type BulkPhase =
  | 'queued'
  | 'discovering'
  | 'expanding'
  | 'applying'
  | 'reconciling'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'stopped'
  | 'expired';
export type TerminalOutcome = 'applied' | 'no_effect' | 'conflict' | 'denied' | 'failed' | 'cancelled';
export type TargetState = TerminalOutcome | 'pending' | 'reconciling';
export type BulkReason =
  | 'revision_mismatch'
  | 'incarnation_mismatch'
  | 'missing_target'
  | 'authority_lost'
  | 'target_denied'
  | 'collection_full'
  | 'invalid_subject'
  | 'dependency_unavailable'
  | 'deadline'
  | 'cancel_requested'
  | 'evidence_missing'
  | 'execution_expired';
export type BulkCounters = Readonly<{
  scannedCandidates: number;
  selectedSubjects: number;
  scannedOccurrences: number;
  capturedOccurrences: number;
  targets: number;
  pending: number;
  reconciling: number;
  applied: number;
  no_effect: number;
  conflict: number;
  denied: number;
  failed: number;
  cancelled: number;
}>;
/** Public roll-up; failed includes conflicts, denials, failures and cancelled targets. */
export type BulkSummary = Readonly<{ changed: number; unchanged: number; failed: number }>;
export type OperationView = Readonly<{
  id: string;
  action: BulkAdmission['action'];
  selectionKind: BulkAdmission['selection']['kind'];
  state: EntryState | null;
  collectionId: string | null;
  phase: BulkPhase;
  selectionComplete: boolean;
  occurrencesComplete: boolean;
  cancelRequested: boolean;
  counts: BulkCounters;
  /** Null until discovery/expansion is complete and every target is terminal. */
  summary: BulkSummary | null;
  admittedAt: string;
  targetBoundAt: string | null;
  expiresAt: string;
  resultsExpireAt: string;
  finishedAt: string | null;
  reason: BulkReason | null;
}>;
export type OperationResult = { operation: OperationView };
export type OutcomeView = Readonly<{
  ordinal: DecimalSequence;
  subjectId: string;
  memberId: string | null;
  state: TargetState;
  reason: BulkReason | null;
  resultingMemberId: string | null;
}>;
export type OutcomeQuery = { limit?: number; cursor?: string; state?: TargetState };
export type OutcomePage = { outcomes: readonly OutcomeView[]; next: string | null };

/** Frozen on source; an absent slot generation also changes on create/delete ABA. */
export type EntryExpectation =
  | { kind: 'present'; incarnation: string; admissionSequence: DecimalSequence; revision: number }
  | { kind: 'absent'; slotGeneration: DecimalSequence };
export type SubjectTarget = Readonly<{
  kind: 'subject';
  operationId: string;
  ordinal: DecimalSequence;
  subjectId: string;
  requestedSubjectId: string | null;
  expected: EntryExpectation;
}>;
/** Exact native row stamps, captured together. member_revision alone does not cover note/order edits. */
export type OccurrenceExpectation = Readonly<{
  memberRevision: DecimalSequence;
  transactionId: string;
  addedAt: string;
}>;
export type OccurrenceTarget = Readonly<{
  kind: 'occurrence';
  operationId: string;
  ordinal: DecimalSequence;
  subjectId: string;
  collectionId: string;
  memberId: string;
} & (
  | { expected: OccurrenceExpectation; incarnation?: never; admissionSequence?: never }
  | { expected?: never; incarnation: string; admissionSequence: DecimalSequence }
)>;
export type ImmutableTarget = SubjectTarget | OccurrenceTarget;
export type ReceiptLocator = Readonly<{
  partition: number;
  principalKind: 'account';
  principalId: string;
  commandKind: string;
  key: string;
  digest: string;
}>;
export type BulkSource = Readonly<{
  id: string;
  route: number;
  operationId: string;
  request: BulkAdmission;
  initiator: DurableInitiatorRecord;
  entryHighWater: DecimalSequence;
  admittedAt: string;
  expiresAt: string;
  resultsExpireAt: string;
}>;
export type Checkpoint = Readonly<{
  operationId: string;
  generation: number;
  phase: BulkPhase;
  /** Immutable per-phase keyset boundary; never a shelf sort or Collection ordinal. */
  after: DecimalSequence;
  highWater: DecimalSequence;
  /** Monotonic operation-wide budget index. A refused chunk retries this exact index. */
  nextChunkIndex: number;
}>;
/** Data never includes manifest arrays. Native intent remains until enqueue acknowledgement. */
export type SegmentInput = Readonly<{ operationId: string; route: number; generation: number }>;
export type EnqueueIntent = Readonly<{ workflowId: string; input: SegmentInput; queue: 'workflows' }>;
export type PageCommit = Readonly<{
  checkpoint: Checkpoint;
  chunkIndex: number;
  targets: readonly ImmutableTarget[];
  complete: boolean;
  enqueue: EnqueueIntent;
}>;
export type OccurrencePage = Readonly<{
  operationId: string;
  collectionId: string;
  page: DecimalSequence;
  sourceDigest: string;
  after: DecimalSequence;
  highWater: DecimalSequence;
  targets: readonly OccurrenceTarget[];
  complete: boolean;
}>;
export type TargetCommand = Readonly<{
  source: DurableOperationAnchor;
  sourceDigest: string;
  target: ImmutableTarget;
  receipt: ReceiptLocator;
  chunkIndex: number;
  deadline: number;
}>;
export type TargetEvidence = Readonly<{
  operationId: string;
  ordinal: DecimalSequence;
  sourceDigest: string;
  receipt: ReceiptLocator;
  /** Null for a current authority refusal with no native command receipt. */
  transactionId: string | null;
  outcome: TerminalOutcome;
  reason: BulkReason | null;
  resultingMemberId: string | null;
  /** Original native removal episode, never renewed by processing or replay. */
  memberDeletion?: Readonly<{ deletionId: string; revision: number; purgeAfter: string }>;
}>;
export type AttemptResult =
  | { kind: 'terminal'; evidence: TargetEvidence }
  | { kind: 'reconciling'; receipt: ReceiptLocator; reason: BulkReason }
  | { kind: 'stop'; reason: 'authority_lost' | 'evidence_missing' | 'execution_expired' };

/** Inject the accounts-owned WriteRateLimiter.spendChunk unchanged. Call in
 * CommandAuthorization.prepare after restoration at the same T; context.actor
 * is exactly the restored actor. This operational window ledger is not an effect
 * receipt: a new window or UNLOGGED ledger loss can charge the chunk again.
 */
export type SpendBulkChunk = (
  context: WriteRateContext,
  chunk: Readonly<{ operation: DurableOperationAnchor; index: number }>,
  family: WriteRateFamily,
  units: number,
) => Promise<WriteRateDecision>;
export type BulkDependencies = Readonly<{
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock: KernelClock;
  initiators: InitiatorRestorer;
  readInitiator: DurableInitiatorReader;
  spendChunk: SpendBulkChunk;
}>;
export type BulkOperations = Readonly<{
  admit(actor: Actor, input: BulkAdmission, idempotencyKey: string): Promise<CommandOutcome<OperationResult>>;
  get(actor: Actor, operationId: string): Promise<OperationResult>;
  outcomes(actor: Actor, operationId: string, query: OutcomeQuery): Promise<OutcomePage>;
  cancel(actor: Actor, operationId: string, idempotencyKey: string): Promise<CommandOutcome<OperationResult>>;
}>;

/** Native rows, not workflow payloads. Every row is led by its owning route. */
export type OperationRow = Readonly<{
  route: number;
  accountId: string;
  source: BulkSource;
  view: OperationView;
  checkpoint: Checkpoint;
  admissionKey: string;
  admissionDigest: string;
  creationReceipt: ReceiptLocator;
  cancelReceipt: ReceiptLocator | null;
}>;
export type TargetRow = Readonly<{
  route: number;
  target: ImmutableTarget;
  receipt: ReceiptLocator;
  state: TargetState;
  evidence: TargetEvidence | null;
  chunkIndex: number;
}>;
export type DiscoveryPage = Readonly<{
  previous: Checkpoint;
  next: Checkpoint;
  scanned: number;
  chunkIndex: number;
  selected: readonly SubjectTarget[];
  sealed: boolean;
}>;
export type Transition = Readonly<{
  operationId: string;
  ordinal: DecimalSequence;
  from: 'pending' | 'reconciling';
  evidence: TargetEvidence;
}>;
export type ExpiryPage = Readonly<{ route: number; after: string | null; removed: number; complete: boolean }>;

/** Store ports perform native transactions; callers cannot submit trusted rows
 * from HTTP/DBOS. Constructors install readers from actual native storage.
 */
export type BulkStore = Readonly<{
  readOperation(route: number, operationId: string): Promise<OperationRow | null>;
  readTargets(route: number, checkpoint: Checkpoint, limit: number): Promise<readonly TargetRow[]>;
  commitDiscovery(tx: CommandTransaction, time: AuthoritativeTime, page: DiscoveryPage): Promise<void>;
  transition(tx: CommandTransaction, time: AuthoritativeTime, change: Transition): Promise<boolean>;
}>;

export function createBulkStore(_pool: Pool): BulkStore {
  throw new Error('Library bulk store is not implemented');
}

/** Route/action data only; an implementation installs it in the ordinary mounted
 * catalogue and creates no grants by virtue of adding these action names.
 */
export type BulkRouteAction =
  | 'library_operation:create'
  | 'library_operation:read'
  | 'library_operation:list_outcomes'
  | 'library_operation:cancel';

export async function expireBulkPage(
  _dependencies: BulkDependencies,
  _route: number,
  _after: string | null,
): Promise<ExpiryPage> {
  throw new Error('Library bulk expiry is not implemented');
}

export function createBulkOperations(_dependencies: BulkDependencies): BulkOperations {
  throw new Error('Library bulk operations are not implemented');
}
/** Source command captures original identity using captureDurableInitiator during
 * CommandAuthorization.prepare, then commits source/operation/creation commitment.
 */
export async function admitBulkOperation(
  _dependencies: BulkDependencies,
  _actor: Actor,
  _input: BulkAdmission,
  _key: string,
): Promise<CommandOutcome<OperationResult>> {
  throw new Error('Library bulk admission is not implemented');
}
/** Raw keyset C<=100, including nonmatches; no effects before both seals. */
export async function discoverBulkPage(_dependencies: BulkDependencies, _input: SegmentInput): Promise<Checkpoint> {
  throw new Error('Library bulk discovery is not implemented');
}
/** One owning-partition transaction: checkpoint, immutable page, counters, intent. */
export async function commitBulkPage(
  _tx: CommandTransaction,
  _time: AuthoritativeTime,
  _page: PageCommit,
): Promise<void> {
  throw new Error('Library bulk page commit is not implemented');
}
/** Target Collection raw scan once, immutable high-water; source probes release
 * their connection before target page persistence. Transfer uses immutable digest.
 */
export async function captureCollectionPage(
  _dependencies: BulkDependencies,
  _input: SegmentInput,
): Promise<OccurrencePage> {
  throw new Error('Library bulk occurrence capture is not implemented');
}
export async function acknowledgeOccurrencePage(
  _dependencies: BulkDependencies,
  _page: OccurrencePage,
): Promise<Checkpoint> {
  throw new Error('Library bulk occurrence transfer is not implemented');
}
export async function executeStatusTarget(
  _dependencies: BulkDependencies,
  _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk status is not implemented');
}
export async function executeLibraryRemovalTarget(
  _dependencies: BulkDependencies,
  _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk entry removal is not implemented');
}
export async function executeCollectionAddTarget(
  _dependencies: BulkDependencies,
  _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk Collection add is not implemented');
}
export async function executeCollectionRemoveTarget(
  dependencies: BulkDependencies,
  command: TargetCommand,
): Promise<AttemptResult> {
  return removeCapturedOccurrence(dependencies, command);
}
/** Private source-bound accounting; can recover prior commits after revocation,
 * cannot restore an initiator, issue personal effects or disclose target data.
 */
export async function reconcileBulkTarget(
  _dependencies: BulkDependencies,
  _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk reconciliation is not implemented');
}
export async function acknowledgeBulkOutcome(
  _dependencies: BulkDependencies,
  _evidence: TargetEvidence,
): Promise<OperationView> {
  throw new Error('Library bulk outcome transition is not implemented');
}
export async function cancelBulkPage(_dependencies: BulkDependencies, _input: SegmentInput): Promise<Checkpoint> {
  throw new Error('Library bulk cancellation is not implemented');
}
/** At most 100 pages per segment; returns only a native checkpoint locator. */
export async function runBulkSegment(_dependencies: BulkDependencies, _input: SegmentInput): Promise<Checkpoint> {
  throw new Error('Library bulk workflow segment is not implemented');
}
/** Extends the existing library WorkModule; never launches a worker. */
export function registerLibraryBulkWork(_context: WorkContext, _dependencies: BulkDependencies): void {
  throw new Error('Library bulk work registration is not implemented');
}
