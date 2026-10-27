/** Proposed independent bulk ports. No function in this file implements product behavior. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime, CommandOutcome, CommandTransaction } from '../command/command.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord, InitiatorRestorer } from '../access/durable-initiator.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkContext } from '../work/registry.ts';
import type { EntryState } from './entry-model.ts';

export const BULK_PAGE_LIMIT = 100;
export const BULK_SEGMENT_PAGES = 100;
export const BULK_EXECUTION_HOURS = 24;
export type DecimalSequence = string; // canonical nonnegative bigint decimal, compared numerically
export type SubjectSelection =
  | { kind: 'explicit'; targets: readonly { subjectId: string }[] }
  | { kind: 'query'; filter: { state?: EntryState; primaryType?: string } };
export type OccurrenceSelection = { kind: 'occurrences'; memberIds: readonly string[] };
export type BulkAdmission =
  | { action: 'set_status'; state: EntryState; selection: SubjectSelection }
  | { action: 'add_to_collection'; collectionId: string; selection: SubjectSelection }
  | { action: 'remove_from_collection'; collectionId: string; selection: SubjectSelection | OccurrenceSelection }
  | { action: 'remove_from_library'; selection: SubjectSelection };
export type BulkPhase = 'queued' | 'discovering' | 'expanding' | 'applying' | 'reconciling'
  | 'completed' | 'completed_with_errors' | 'cancelled' | 'stopped' | 'expired';
export type TerminalOutcome = 'applied' | 'no_effect' | 'conflict' | 'denied' | 'failed' | 'cancelled';
export type TargetState = TerminalOutcome | 'pending' | 'reconciling';
export type BulkReason = 'revision_mismatch' | 'incarnation_mismatch' | 'missing_target' | 'authority_lost'
  | 'target_denied' | 'collection_full' | 'invalid_subject' | 'dependency_unavailable' | 'deadline'
  | 'cancel_requested' | 'evidence_missing' | 'execution_expired';
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
  | { kind: 'absent'; generation: DecimalSequence };
export type SubjectTarget = Readonly<{
  kind: 'subject'; operationId: string; ordinal: DecimalSequence;
  subjectId: string; requestedSubjectId: string | null; expected: EntryExpectation;
}>;
export type OccurrenceTarget = Readonly<{
  kind: 'occurrence'; operationId: string; ordinal: DecimalSequence;
  subjectId: string; collectionId: string; memberId: string;
  incarnation: string; admissionSequence: DecimalSequence;
}>;
export type ImmutableTarget = SubjectTarget | OccurrenceTarget;
export type ReceiptLocator = Readonly<{
  partition: number; principalId: string; commandKind: string; key: string; digest: string;
}>;
export type BulkSource = Readonly<{
  id: string; route: number; operationId: string; request: BulkAdmission;
  initiator: DurableInitiatorRecord; entryHighWater: DecimalSequence;
  admittedAt: string; expiresAt: string; resultsExpireAt: string;
}>;
export type Checkpoint = Readonly<{
  operationId: string; generation: number; phase: BulkPhase;
  after: DecimalSequence; highWater: DecimalSequence;
}>;
/** Data never includes manifest arrays. Native intent remains until enqueue acknowledgement. */
export type SegmentInput = Readonly<{ operationId: string; route: number; generation: number }>;
export type EnqueueIntent = Readonly<{ workflowId: string; input: SegmentInput; queue: 'workflows' }>;
export type PageCommit = Readonly<{
  checkpoint: Checkpoint; targets: readonly ImmutableTarget[]; complete: boolean; enqueue: EnqueueIntent;
}>;
export type OccurrencePage = Readonly<{
  operationId: string; collectionId: string; page: DecimalSequence;
  sourceDigest: string; after: DecimalSequence; highWater: DecimalSequence;
  targets: readonly OccurrenceTarget[]; complete: boolean;
}>;
export type TargetCommand = Readonly<{
  sourceId: string; target: ImmutableTarget; receipt: ReceiptLocator; deadline: number;
}>;
export type TargetEvidence = Readonly<{
  operationId: string; ordinal: DecimalSequence; sourceDigest: string;
  receipt: ReceiptLocator; transactionId: string; outcome: TerminalOutcome;
  reason: BulkReason | null; resultingMemberId: string | null;
}>;
export type AttemptResult =
  | { kind: 'terminal'; evidence: TargetEvidence }
  | { kind: 'reconciling'; receipt: ReceiptLocator; reason: BulkReason }
  | { kind: 'stop'; reason: 'authority_lost' | 'evidence_missing' | 'execution_expired' };

/** New shared Access port needed before effects can be enabled. Durable replay of
 * the same operation/chunk/digest returns its original reservation, without spend.
 * It confers capacity only; restoration and current command authorization still run.
 */
export type AdmitBulkChunk = (input: Readonly<{
  actor: AccountActor; operationId: string; chunk: DecimalSequence; digest: string;
  units: number; deadline: number; expiresAt: string;
}>) => Promise<
  | { allowed: true; reservationId: string }
  | { allowed: false; retryAfter: number }
>;
export type BulkDependencies = Readonly<{
  pool: Pool; access: Access; tokens: KeyRing; clock: KernelClock;
  initiators: InitiatorRestorer; readInitiator: DurableInitiatorReader;
  admitChunk: AdmitBulkChunk;
}>;
export type BulkOperations = Readonly<{
  admit(actor: Actor, input: BulkAdmission, idempotencyKey: string): Promise<CommandOutcome<OperationResult>>;
  get(actor: Actor, operationId: string): Promise<OperationResult>;
  outcomes(actor: Actor, operationId: string, query: OutcomeQuery): Promise<OutcomePage>;
  cancel(actor: Actor, operationId: string, idempotencyKey: string): Promise<CommandOutcome<OperationResult>>;
}>;

export function createBulkOperations(_dependencies: BulkDependencies): BulkOperations {
  throw new Error('Library bulk operations are not implemented');
}
/** Source command captures original identity using captureDurableInitiator during
 * CommandAuthorization.prepare, then commits source/operation/creation commitment.
 */
export async function admitBulkOperation(
  _dependencies: BulkDependencies, _actor: Actor, _input: BulkAdmission, _key: string,
): Promise<CommandOutcome<OperationResult>> {
  throw new Error('Library bulk admission is not implemented');
}
/** Raw keyset C<=100, including nonmatches; no effects before both seals. */
export async function discoverBulkPage(_dependencies: BulkDependencies, _input: SegmentInput): Promise<Checkpoint> {
  throw new Error('Library bulk discovery is not implemented');
}
/** One owning-partition transaction: checkpoint, immutable page, counters, intent. */
export async function commitBulkPage(
  _tx: CommandTransaction, _time: AuthoritativeTime, _page: PageCommit,
): Promise<void> {
  throw new Error('Library bulk page commit is not implemented');
}
/** Target Collection raw scan once, immutable high-water; source probes release
 * their connection before target page persistence. Transfer uses immutable digest.
 */
export async function captureCollectionPage(
  _dependencies: BulkDependencies, _input: SegmentInput,
): Promise<OccurrencePage> {
  throw new Error('Library bulk occurrence capture is not implemented');
}
export async function acknowledgeOccurrencePage(
  _dependencies: BulkDependencies, _page: OccurrencePage,
): Promise<Checkpoint> {
  throw new Error('Library bulk occurrence transfer is not implemented');
}
export async function executeStatusTarget(_dependencies: BulkDependencies, _command: TargetCommand): Promise<AttemptResult> {
  throw new Error('Library bulk status is not implemented');
}
export async function executeLibraryRemovalTarget(
  _dependencies: BulkDependencies, _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk entry removal is not implemented');
}
export async function executeCollectionAddTarget(
  _dependencies: BulkDependencies, _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk Collection add is not implemented');
}
export async function executeCollectionRemoveTarget(
  _dependencies: BulkDependencies, _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk Collection remove is not implemented');
}
/** Private source-bound accounting; can recover prior commits after revocation,
 * cannot restore an initiator, issue personal effects or disclose target data.
 */
export async function reconcileBulkTarget(
  _dependencies: BulkDependencies, _command: TargetCommand,
): Promise<AttemptResult> {
  throw new Error('Library bulk reconciliation is not implemented');
}
export async function acknowledgeBulkOutcome(
  _dependencies: BulkDependencies, _evidence: TargetEvidence,
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
