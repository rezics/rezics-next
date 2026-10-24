// The two halves of the control plane meet only here. The worker side owns tasks, attempts, routing, launch,
// failure classes and evidence bundles; the integration side owns the merge train, manager sessions and inboxes.
// Each side tests against fakes of the other side's interface.

export type AttemptRef = { taskId: string; attempt: number };

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
}

export type LandingRequest = AttemptRef & {
  branch: string;
  worktree: string;
  /** Path patterns the brief declared; changes outside them fail at the scope stage. */
  declaredPaths: readonly string[];
  gate: readonly string[];
};

/** Implemented by the integration side. */
export interface LandingQueue {
  enqueue(request: LandingRequest): void;
}

export type GateStage = 'setup' | 'rebase' | 'scope' | 'gate' | 'merge';

export type FirstFailure = {
  /** Stable for the same failing assertion across runs; repeats are detected by comparing it. */
  fingerprint: string;
  assertion: string;
  excerpt: string;
};

export type GateOutcome = AttemptRef & {
  passed: boolean;
  /** The stage that failed, or 'merge' when the task merged. */
  stage: GateStage;
  firstFailure?: FirstFailure;
  /** The same first failure also occurs on main. */
  failsOnMain?: boolean;
  timedOut?: boolean;
  logPath: string;
  hostMs: number;
  changedFiles: readonly string[];
  diffLines: number;
  mergedCommit?: string;
};

/** Implemented by the worker side: classifies the outcome and decides the next step. */
export interface GateOutcomeSink {
  onGateOutcome(outcome: GateOutcome): void;
}

/** Only these wake a manager. Passing gates, merges, environment reruns and automatic consultations are recorded only. */
export type ManagerEventKind =
  | 'spec-conflict'
  | 'scope-growth'
  | 'round-limit'
  | 'stalled'
  | 'failed-after-consult'
  | 'goal-unmet'
  | 'instruction';

export type ManagerEvent = {
  managerId: string;
  kind: ManagerEventKind;
  taskId?: string;
  /** One line; the manager reads details through the control plane. */
  summary: string;
  evidencePath?: string;
};

/** Implemented by the integration side. */
export interface ManagerInbox {
  deliver(event: ManagerEvent): void;
}
