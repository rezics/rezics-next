import type { AffectedTestResult } from './types.ts';
import type { ProcessIdentity } from './process.ts';

// The two halves of the control plane meet only here. The worker side owns tasks, attempts, routing, launch,
// failure classes and evidence bundles; the integration side owns the merge train, manager sessions and inboxes.
// Each side tests against fakes of the other side's interface.

export type AttemptRef = { taskId: string; attempt: number };

/** Immutable input to the controller; identities come from accepted current queue requests. */
export type ControlPlaneBatchManifest = {
  version: 1;
  managerId: string;
  /** readmitFrom names an exact terminal prior cohort's preparation exclusion, never a worker retry. */
  members: readonly (AttemptRef & { acceptedCommit: string; readmitFrom?: string })[];
};

export type ControlPlaneBatchDisposition = AttemptRef & {
  acceptedCommit: string;
  disposition: 'released' | 'already-represented' | 'excluded';
  phase?: 'preparation' | 'native';
  mergedCommit?: string;
  logPath: string;
  reason?: string;
  files?: readonly string[];
};

export type ControlPlaneBatchResult = {
  batchId: string;
  members: ControlPlaneBatchDisposition[];
};

export type ControlPlaneBatchSource = AttemptRef & { acceptedCommit: string };

/** Separate native authority for concrete additional files; the worker contract and request stay immutable. */
export type ControlPlaneScopeApprovalRequest = ControlPlaneBatchSource & {
  version: 1;
  managerId: string;
  contractIdentity: string;
  requestIdentity: string;
  additionalPaths: readonly { path: string; reason: string }[];
};

export type ControlPlaneScopeApprovalReceipt = ControlPlaneScopeApprovalRequest & {
  id: string;
  actor: { managerId: string; sessionId: string };
  approvedAt: string;
};

/** Complete mapping: a corrected generation can replace only the same task. */
export type ControlPlaneBatchMemberMapping = {
  previous: ControlPlaneBatchSource;
} & (
  | { disposition: 'replacement'; current: ControlPlaneBatchSource }
  | { disposition: 'deferred-to-dev'; cause: string }
);

/** Immutable migration input. Its queue claims remain reserved until the native dev receiver consumes it. */
export type ControlPlaneBatchDevHandoff = {
  previousBatchId: string;
  replacementBatchId: string;
  ownerId: string;
  authorization: { order: string; expectedDeferredCount: number };
  members: (ControlPlaneBatchSource & {
    queueEntryId: number;
    claimBatchId: string;
    request: LandingRequest;
    contractIdentity: string;
    cause: string;
  })[];
};

export type ControlPlaneBatchDevHandoffRequest = { previousBatchId: string; replacementBatchId: string };

/** Operations supplies verified known dead identities; never a worker receipt or physical capacity release. */
export type ControlPlaneBatchHandoff = {
  journalHash: string;
  controller: ProcessIdentity;
  ownedCommands: readonly ProcessIdentity[];
  /** Missing on older callers means a complete inventory. Unknown legacy custody remains explicitly unknown. */
  inventory?: 'complete' | 'legacy-inventory-unavailable';
  /** Reference to retained physical terminal/handoff evidence, not a claim that any check passed. */
  evidence: string;
  /** Only older journals need this exact retained log evidence; it cannot invent a result. */
  failures?: readonly { node: string; candidate: string; failedCommand: readonly string[]; output: string }[];
};

/** One fresh proof for an exact unpublished single-source ref-exhausted journal, never a source retry. */
export type ControlPlaneBatchRefContinuation = {
  version: 1;
  manifest: ControlPlaneBatchManifest;
  handoff: Omit<ControlPlaneBatchHandoff, 'failures'>;
  /** SHA-256 of the retained root log documenting all three positive, moved-ref attempts. */
  logHash: string;
};

export type ControlPlaneBatchSupersession = {
  version: 1;
  previousBatchId: string;
  replacement: ControlPlaneBatchManifest;
  handoff: ControlPlaneBatchHandoff;
  /** Required when a prior generation is corrected or any member is deferred. Covers every prior member exactly once. */
  memberMapping?: readonly ControlPlaneBatchMemberMapping[];
  /** Owning manager's retained Root order, including the exact number to hand off to dev. */
  deferralAuthorization?: ControlPlaneBatchDevHandoff['authorization'];
  /** Owning manager identifies actual omitted or added producer edits relevant to the retained failure. */
  changedInputs: readonly { taskId: string; path: string; reason: string }[];
};

export type ControlPlaneBatchSupersessionResult = {
  previousBatchId: string;
  replacementBatchId: string;
  status: 'superseded/interrupted';
  members: (AttemptRef & { acceptedCommit: string; disposition: 'failed' | 'unknown' })[];
  devHandoff?: ControlPlaneBatchDevHandoff;
  physicalInventory?: 'complete' | 'legacy-inventory-unavailable';
};

/** Thrown when a write carries an attempt number that is no longer the task's current attempt. */
export class StaleAttemptError extends Error {
  constructor(
    readonly ref: AttemptRef,
    readonly current: number,
  ) {
    super(`attempt ${ref.attempt} of ${ref.taskId} is stale; the current attempt is ${current}`);
    this.name = 'StaleAttemptError';
  }
}

/** Implemented by the worker side. Every state-changing step checks it, including the merge itself. */
export interface AttemptFence {
  assertCurrent(ref: AttemptRef): void;
  /** Hold the shared store write lock through Git advancement and publication of merged task state. */
  commitMerge(ref: AttemptRef, merge: () => string): string;
  /** Atomically fence every member while one cumulative candidate advances the integration ref. */
  commitBatchMerge?(members: readonly (AttemptRef & { commit: string })[], merge: () => string): string;
}

export type LandingRequest = AttemptRef & {
  branch: string;
  worktree: string;
  /** Source branch HEAD before controller-only retry rebases, frozen when the worker settles. */
  workerCommit?: string;
  /** A clean completion with no source commit asks the train to verify this exact retained contract and head. */
  unchangedClaim?: true;
  contractHash?: string;
  /** A worker worktree that was dirty at settlement cannot be certified as unchanged. */
  sourceDirtyAtSettlement?: true;
  /** Path patterns the brief declared: where the work is expected. A worker may change files outside them. */
  declaredPaths: readonly string[];
  /** Risk-area patterns the brief did not declare; a change outside declaredPaths that matches one is refused. */
  protectedPaths?: readonly string[];
  gate: readonly string[];
  affectedTests?: readonly AffectedTestResult[];
  /** Original worker acceptance is retained when the owning manager advances an already accepted attempt. */
  managerLanding?: {
    managerId: string;
    acceptedCommit: string;
    acceptanceCommand: readonly string[];
  };
};

/** Implemented by the integration side. */
export interface LandingQueue {
  enqueue(request: LandingRequest): void;
}

export type GateStage = 'setup' | 'rebase' | 'scope' | 'gate' | 'merge';
export type GateOutcomeRefusal = {
  kind: 'frozen-acceptance-change';
  paths: readonly string[];
};

export type FirstFailure = {
  /** Stable for the same failing assertion across runs; repeats are detected by comparing it. */
  fingerprint: string;
  assertion: string;
  excerpt: string;
};

/** Git state captured by the train while an unresolved rebase conflict is present. */
export type RebaseConflictContext = {
  /** Exact effective target HEAD used by the failed rebase (including earlier members of a batch). */
  targetHead: string;
  /** Exact source branch HEAD before the controller rebased or amended the candidate. */
  workerCommit: string;
  /** Sorted, unique paths reported by Git as unresolved at the conflict. */
  paths: readonly string[];
};

export type GateOutcome = AttemptRef & {
  passed: boolean;
  /** The stage that failed, or 'merge' when the task merged. */
  stage: GateStage;
  /** Actual acceptance run for a clean unchanged claim, pinned to its retained source. */
  retainedSourceAcceptance?: {
    sourceCommit: string;
    command: readonly string[];
    status: 'passed' | 'failed' | 'unavailable';
  };
  firstFailure?: FirstFailure;
  /** The same first failure also occurs on main. */
  failsOnMain?: boolean;
  /** Exact command that produced firstFailure when the gate runner identified one. */
  failedCommand?: readonly string[];
  timedOut?: boolean;
  logPath: string;
  hostMs: number;
  changedFiles: readonly string[];
  /** Changed paths and line count excluding files marked linguist-generated by the candidate's attributes. */
  nonGeneratedChangedFiles?: readonly string[];
  nonGeneratedDiffLines?: number;
  /** Paths left unresolved by a rebase-stage failure. */
  conflictedFiles?: readonly string[];
  /** Typed train refusal for immutable inputs; not a Git rebase conflict. */
  refusal?: GateOutcomeRefusal;
  /** Complete Git identity of an actual unresolved rebase conflict; absent on legacy or non-Git failures. */
  rebaseConflict?: RebaseConflictContext;
  /** A task repeated the same control-plane propagation conflict without source or target progress. */
  controlPlaneConflictRepeated?: boolean;
  diffLines: number;
  mergedCommit?: string;
};

/** Implemented by the worker side: classifies the outcome and decides the next step. */
export interface GateOutcomeSink {
  onGateOutcome(outcome: GateOutcome): void;
}

/** Only these wake a manager. Passing gates, merges, environment reruns and automatic consultations are recorded only. */
export type ManagerEventKind =
  | 'width'
  | 'question'
  | 'decision'
  | 'blocker'
  | 'handoff'
  | 'info'
  | 'spec-conflict'
  | 'scope-growth'
  | 'environment'
  | 'round-limit'
  | 'stalled'
  | 'failed-after-consult'
  | 'goal-unmet'
  | 'goal-met'
  | 'goal-idle'
  | 'instruction';

export type ManagerEvent = {
  managerId: string;
  kind: ManagerEventKind;
  from?: string;
  /** Provider session captured by the authenticated manager inbox sender; used for durable authority provenance. */
  senderSessionId?: string;
  /** Persisted source fence when a worker sends through the manager inbox CLI. */
  senderProvenance?: { kind: 'worker'; taskId: string; attempt: number; ownerManager: string };
  taskId?: string;
  /** Goal identity is written only when it comes from persisted manager or task metadata. */
  goalId?: string;
  /** The exact inbox row this message answers or follows. */
  replyToId?: number;
  /** Document paths and optional change descriptions attached to a decision. */
  documentRefs?: readonly InboxDocumentReference[];
  /** Explicit escalation context; system event kinds are not inferred to be escalations. */
  escalation?: InboxEscalation;
  /** One line; the manager reads details through the control plane. */
  summary: string;
  evidencePath?: string;
};

export type InboxDocumentReference = { path: string; change?: string };
export type InboxEscalation = { target?: string; reason: string };

/** Implemented by the integration side. */
export interface ManagerInbox {
  deliver(event: ManagerEvent): void;
}
