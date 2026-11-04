export type {
  IdentityEpoch,
  IdentityJobRef,
  IdentityIntent,
  IdentityStepName,
  IdentityNativeReceipt,
  IdentityStepReceipt,
  IdentityChange,
  IdentityFrontier,
  NativeStepWork,
  IdentityStepProgress,
  IdentityEpochState,
  IdentityMapping,
  IdentityEffect,
} from '../identity-core/index.ts';
import type {
  IdentityEpoch,
  IdentityJobRef,
  IdentityIntent,
  IdentityStepName,
  IdentityNativeReceipt,
  IdentityStepReceipt,
  IdentityChange,
  IdentityFrontier,
  NativeStepWork,
  IdentityStepProgress,
  IdentityEpochState,
  IdentityMapping,
  IdentityEffect,
} from '../identity-core/index.ts';
/** Native identity storage and fixed participant protocol. Mapping conveys no permission. */
import type { Pool } from 'pg';
import type { IdentityReceiptBinding } from './identity-epoch-binding.ts';
export type { IdentityReceiptBinding } from './identity-epoch-binding.ts';
import type {
  CommandBasis,
  CommandAuthorization,
  CommandReceipt,
  CommandResult,
  CommandTransaction,
} from '../../command/command.ts';
import type { mergeSubjects } from '../merges.ts';
import type { verifyAccountAgent, unverifyAccountAgent } from '../account-agents.ts';

export type MergeSubjects = typeof mergeSubjects;
export type VerifyAccountAgent = typeof verifyAccountAgent;
export type UnverifyAccountAgent = typeof unverifyAccountAgent;
export type AccountAgentSuccess = Awaited<ReturnType<VerifyAccountAgent>>;

export type IdentityReceipt =
  | Readonly<{ kind: 'subject.merge'; command: Readonly<CommandReceipt> }>
  | Readonly<{ kind: 'account-agent.verify'; account: string; receipt: string }>
  | Readonly<{ kind: 'account-agent.unverify'; account: string; receipt: string }>;

export type IdentityJob = Readonly<{
  ref: IdentityJobRef;
  intent: IdentityIntent;
  receipt: IdentityReceipt | Readonly<{ kind: 'erased' }>;
  state: 'preparing' | 'pending' | 'cancelling' | 'cancelled' | 'published';
  mapping: IdentityStepProgress | null;
  participants: Readonly<{
    'search-canonical-index': IdentityStepProgress | null;
    'library-private-follow-counts': IdentityStepProgress | null;
  }>;
}>;

/** Native producer: semantic/identity-epoch-store.ts, export identityEpochStore.
 * Every mutation uses currentCommand(tx), its real owner and native time.
 * Pool methods release each home before acquiring another home or engine.
 */
export type IdentityAdmissionInput = Readonly<{ intent: IdentityIntent; receipt: IdentityReceipt }>;
export type IdentityAdmissionAuthority = Readonly<{
  basis?: CommandBasis;
  authorization?: CommandAuthorization;
  deadline?: number;
  clock?: () => Date;
}>;
export type IdentityEpochStore = Readonly<{
  /** Bootstrap topology home. Job control homes are encoded in native job IDs. */
  controlPartition: number;
  readEpoch(client: CommandTransaction, partition?: number): Promise<IdentityEpochState>;
  readJob(client: CommandTransaction, job: IdentityJobRef): Promise<IdentityJob | null>;
  findJob(
    client: CommandTransaction,
    receipt: IdentityReceipt,
    binding?: IdentityReceiptBinding,
  ): Promise<IdentityJob | null>;
  /** Released current authorization, cap proof and native actor/account-home claim. */
  bindReceipt(
    pool: Pool,
    authority: IdentityAdmissionAuthority,
    input: IdentityAdmissionInput,
  ): Promise<IdentityReceiptBinding>;
  /** Source and explicit current control use one native backend RR snapshot when colocated.
   * Observes only the affected group; no list/publication wait.
   * Missing/unready/moved source OR control is unavailable, never guessed self.
   */
  readMapping(pool: Pool, original: string): Promise<IdentityMapping>;
  /** Same producer and snapshot shared across a bounded page; no per-ID control probes. */
  readMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]>;
  /** Released-home admission producer. Returns durable preparation, never public completion.
   * Double-collects source/current generation bases before any effect, then reserves the FIRST ordered home.
   * prearm-open and prearm-sealed are claim-free internal phases; all native Source scope custody precedes
   * the first actual pending claim. A preparing ref is never a successful public mutation.
   * Bounded stepIdentityEpochAdmission takes actual receiving receipts into native job custody.
   */
  prepareAdmission(
    pool: Pool,
    authority: IdentityAdmissionAuthority,
    input: IdentityAdmissionInput,
  ): Promise<IdentityJobRef>;
  /** Colocated command path; cross-home inputs use prepareAdmission.
   * Exact maintained group cardinality (including the terminal), cap 4096 BEFORE any effect.
   * Busy conflicts without a second pending epoch. Repeated identical receipt returns the same job.
   * Emits native durable wakeup in the same command as pending + immutable intent.
   * Consumes sealed native preparation, or a locked bounded colocated empty-directory proof.
   * A nonempty unprepared inverse prefix returns retryable unavailability; use prepareAdmission after release.
   */
  admit(
    tx: CommandTransaction,
    input: Readonly<{
      intent: IdentityIntent;
      receipt: IdentityReceipt;
      binding?: IdentityReceiptBinding;
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
   * Receiving effects additionally resolve the committed exact local Source/owner record and native hold;
   * their successful command must atomically record its scope effect/frontier. See identity-receiving-effects.ts.
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

/** Native producer: semantic/identity-epoch-mapping.ts, export stepIdentityEpochMapping.
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

/** Final composition: semantic/identity-epoch-coordinator.ts.
 * DBOS resumes job identity only. Completion reads persisted native receipts, not this return value.
 */
export type ResumeIdentityEpochJob = (pool: Pool, job: IdentityJobRef) => Promise<void>;
export type WaitIdentityEpochPublished = (pool: Pool, job: IdentityJobRef) => Promise<void>;
