/** Native identity storage and fixed participant protocol. Mapping conveys no permission. */
import type { Pool } from 'pg';
import type { CommandReceipt, CommandResult, CommandTransaction } from '../command/command.ts';
import type { mergeSubjects } from './merges.ts';
import type { verifyAccountAgent, unverifyAccountAgent } from './account-agents.ts';

export type MergeSubjects = typeof mergeSubjects;
export type VerifyAccountAgent = typeof verifyAccountAgent;
export type UnverifyAccountAgent = typeof unverifyAccountAgent;
export type AccountAgentSuccess = Awaited<ReturnType<VerifyAccountAgent>>;

/** Native storage uses bigint; durable JSON uses canonical unsigned decimal strings. */
export type IdentityEpoch = bigint;
export type IdentityJobRef = Readonly<{ jobId: string; epoch: IdentityEpoch }>;
export type IdentityReceipt =
  | Readonly<{ kind: 'subject.merge'; command: Readonly<CommandReceipt> }>
  | Readonly<{ kind: 'account-agent.verify'; account: string; receipt: string }>
  | Readonly<{ kind: 'account-agent.unverify'; account: string; receipt: string }>;

/** Persisted once at admission. No user callback, completion flags, or original-ID vector. */
export type IdentityIntent =
  | Readonly<{ kind: 'merge'; redirected: string; survivor: string; release: string }>
  | Readonly<{
      kind: 'unmerge';
      original: string;
      undoJob: IdentityJobRef;
      verificationReceipt: string | null;
      release: string;
    }>
  | Readonly<{ kind: 'repoint'; original: string; terminal: string; release: string }>;

/** The Library name is fixed: its scope includes ALL Library canonical records and directories. */
export type IdentityStepName = 'mapping' | 'search-canonical-index' | 'library-private-follow-counts';
/** Native command component plus transaction identity; a receipt locator, never an allow. */
export type IdentityNativeReceipt = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
}>;
export type IdentityStepReceipt = Readonly<{
  job: IdentityJobRef;
  step: IdentityStepName;
  version: 1;
  native: IdentityNativeReceipt;
}>;

export type IdentityChange = Readonly<{
  original: string;
  previousTerminal: string;
  terminal: string;
}>;
export type IdentityFrontier = Readonly<{
  /** At most eight scalar keys and 2048 JSON bytes; never a serialized group. */
  after: readonly (string | number | null)[];
  segment: number;
}>;
export type NativeStepWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;
/** Returned only after native effect/frontier receipts commit. Not publication authority. */
export type IdentityStepProgress = Readonly<{
  job: IdentityJobRef;
  frontier: IdentityFrontier;
  state: 'more' | 'complete';
  work: NativeStepWork;
  receipt: IdentityStepReceipt;
}>;
export type IdentityEpochState =
  | Readonly<{ state: 'published'; epoch: IdentityEpoch }>
  | Readonly<{ state: 'pending'; publishedEpoch: IdentityEpoch; job: IdentityJobRef }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;
export type IdentityMapping =
  | Readonly<{ state: 'mapped'; original: string; terminal: string; epoch: IdentityEpoch }>
  | Readonly<{ state: 'pending'; original: string; job: IdentityJobRef }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;
export type IdentityJob = Readonly<{
  ref: IdentityJobRef;
  intent: IdentityIntent;
  receipt: IdentityReceipt;
  state: 'pending' | 'published';
  mapping: IdentityStepProgress | null;
  participants: Readonly<{
    'search-canonical-index': IdentityStepProgress | null;
    'library-private-follow-counts': IdentityStepProgress | null;
  }>;
}>;

export type IdentityEffect =
  | Readonly<{ kind: 'structural'; job: IdentityJobRef; original: string }>
  | Readonly<{ kind: 'follow-count'; original: string; terminal: string; epoch: IdentityEpoch }>;

/** Native producer: semantic/identity-epoch-store.ts, export identityEpochStore.
 * Every mutation uses currentCommand(tx), its real owner and native time.
 * Pool methods release each home before acquiring another home or engine.
 */
export type IdentityEpochStore = Readonly<{
  /** Bootstrap topology home. Job control homes are encoded in native job IDs. */
  controlPartition: number;
  readEpoch(client: CommandTransaction, partition?: number): Promise<IdentityEpochState>;
  readJob(client: CommandTransaction, job: IdentityJobRef): Promise<IdentityJob | null>;
  findJob(client: CommandTransaction, receipt: IdentityReceipt): Promise<IdentityJob | null>;
  /** Source and explicit current control use one native backend RR snapshot when colocated.
   * Observes only the affected group; no list/publication wait.
   * Missing/unready/moved source OR control is unavailable, never guessed self.
   */
  readMapping(pool: Pool, original: string): Promise<IdentityMapping>;
  /** Same producer and snapshot shared across a bounded page; no per-ID control probes. */
  readMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]>;
  /** Exact maintained group cardinality (including the terminal), cap 4096 BEFORE any effect.
   * Busy conflicts without a second pending epoch. Repeated identical receipt returns the same job.
   * Emits native durable wakeup in the same command as pending + immutable intent.
   */
  admit(
    tx: CommandTransaction,
    input: Readonly<{
      intent: IdentityIntent;
      receipt: IdentityReceipt;
    }>,
  ): Promise<CommandResult<IdentityJobRef>>;
  /** Exact self mapping atomically with actual fresh revision-1 creation; never lazy or bootstrap. */
  initializeSubject(tx: CommandTransaction, original: string): Promise<void>;
  /** Immutable complete input-generation refs + constant transform, atomically retained at admission.
   * <=100 RAW inputs including overlap/lookahead/retry; same DTO and unique originals.
   * Terminal/self destinations included; next generation is flat before later admission.
   */
  pageChanges(
    client: CommandTransaction,
    job: IdentityJobRef,
    after: string | null,
  ): Promise<
    Readonly<{
      changes: readonly IdentityChange[];
      next: string | null;
    }>
  >;
  /** Native home-local compare/lock in the SAME effect transaction; throws on stale admission.
   * Returns no reusable capability. A global pre-read is insufficient.
   */
  admitHomeEffect(tx: CommandTransaction, effect: IdentityEffect): Promise<void>;
  /** Released-home receipt reconciliation. Resolves the exact persisted native step record,
   * verifies job/version/scope and complete observation, and takes durable control custody.
   * Missing/uncommitted/conflicting receipts reject; the caller cannot assert completion.
   */
  reconcileStepReceipt(pool: Pool, receipt: IdentityStepReceipt): Promise<IdentityStepProgress>;
  /** Reconciles persisted fixed participant ACK receipts; never accepts a caller completion flag.
   * Library coverage includes canonical owner candidates, structural-support directories and concurrent
   * first-apply custody, as well as follow/support/totals. A follow-only ACK is incomplete.
   */
  publish(tx: CommandTransaction, job: IdentityJobRef): Promise<CommandResult<IdentityJobRef>>;
}>;

/** MISSING producer: semantic/identity-epoch-mapping.ts, export stepIdentityEpochMapping.
 * One bounded native step; reads saved work, never takes a caller-supplied frontier as authority.
 */
export type IdentityEpochStep = (pool: Pool, job: IdentityJobRef) => Promise<IdentityStepProgress>;

/** Fixed trusted versioned composition, installed once through WorkModule.register.
 * Both adapters consume Store + Step contracts; neither imports the final coordinator.
 * No default/noData implementation and no request-selected participant list.
 */
export type IdentityEpochParticipants = Readonly<{
  version: 1;
  'search-canonical-index': IdentityEpochStep;
  /** Same participant/receipt ABI; all canonical removals/additions/fences/directory rekeys must be custodied. */
  'library-private-follow-counts': IdentityEpochStep;
}>;

/** MISSING producer: semantic/identity-epoch-coordinator.ts.
 * DBOS resumes job identity only. Completion reads persisted native receipts, not this return value.
 */
export type ResumeIdentityEpochJob = (pool: Pool, job: IdentityJobRef) => Promise<void>;
export type WaitIdentityEpochPublished = (pool: Pool, job: IdentityJobRef) => Promise<void>;
