import type { ProcessIdentity } from './process.ts';
import type { AttemptRef, FirstFailure, ManagerEventKind } from './contracts.ts';
import type { GuardId } from './guards.ts';

export type Cli = 'codex' | 'grok' | 'cursor' | 'claude';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TaskState =
  | 'ready'
  | 'held'
  | 'running'
  | 'landing'
  | 'integrated'
  | 'merged'
  | 'stopped'
  | 'cancelled'
  | 'verified';
export type TaskKind =
  | 'implementation'
  | 'interface'
  | 'bulk-text'
  | 'claim'
  | 'specification'
  | 'research'
  | 'verification'
  | 'mechanical';
export type IntegrationTarget = 'main' | 'integration' | 'stabilize';
export type TaskClass = Exclude<TaskKind, 'verification'> | 'critical-path';
export type AcceptancePlacement = 'local' | 'default';
export type AcceptanceRequirement = 'browser' | 'native' | 'root';
export type PromptLayer = 'role' | 'conditions' | 'brief' | 'opening' | 'total';
export type PromptBudgetManifest = {
  layers: Partial<Record<PromptLayer, number>>;
  budgets: Partial<Record<PromptLayer, number>>;
  overBudget: PromptLayer[];
};
export type PromptManifest = PromptBudgetManifest & {
  agents: string;
  role: string;
  conditions: Record<string, string>;
  brief: string;
  policy: string;
  architectureModules?: string;
  layers: { role: number; conditions: number; brief: number; total: number };
};
/** Original integrated acceptance identity; metadata alone never authorizes native execution. */
export type ProofMetadata = {
  journey: string;
  sourceTasks: string[];
  sourceCommit: string;
};
export type BriefContinuation = { taskId: string; expectedAttempt: number };
/** The landed attempt whose provider session a chained task resumes, with the session's identity at chain time. */
export type ChainLink = {
  from: { taskId: string; attempt: number };
  session: string;
  cli: Cli;
  pool: string;
  model: string;
  effort: string;
  /** Tasks in the chain including this one; the first task of a chain has depth 1. */
  depth: number;
};
/** serviceTier is ignored at launch (the Codex tier is the codex.serviceTier setting); kept so older attempts still parse. */
export type Profile = { cli: Cli; model: string; effort: Effort; poolClass: string; serviceTier?: 'default' | 'fast' };
export type Pool = {
  name: string;
  cli: Cli | 'claude';
  classes: string[];
  configDirectory: string;
  command: string;
  /** Pools with the same allowanceKey share a quota, including pools across CLIs. */
  allowanceKey: string;
  usageFile?: string;
  policy: {
    weight: number;
    reservePercent: number;
    reservePerHour?: number;
    allowUnknown: boolean;
    maxAgeMs: number;
    maxBurnPerHour?: number;
    /** Optional cap on this pool's live sessions (pending start and running). Waiting attempts do not occupy it. */
    maxConcurrent?: number;
  };
};
export type AffectedTestCheck = { paths: string[]; command: string[] };
export type SiblingTests = { command: string[] };
export type DerivedFile = {
  path: string;
  stage: 'integration' | 'promotion';
  command: string[];
  inputs?: string[];
};
export type AffectedTestResult = {
  command: string[];
  status: 'passed' | 'failed' | 'unverified';
  failingFiles: string[];
  durationMs: number;
  output: string;
};
export type PromotionPlacementSettings = {
  /** Untracked ordinary-host source; promotion derives a one-host gate file from this input. */
  ordinaryHostsFile: string;
};
export type PromotionPlacementSnapshot = {
  sourcePath: string;
  sourceSha256: string;
  hostsFile: string;
  host: 'c';
  hostProjectionSha256: string;
  gateSlots: number;
  ordinarySlots: number;
  cOrdinarySlots: number;
  retainedOrdinarySlots: number;
};
export type Settings = {
  version: 1;
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  /** Opt in locally. Each module has its own ws/<module> branch and persistent shared checkout. */
  sharedWebModules?: Record<string, string[]>;
  notes?: readonly import('./notes.ts').Note[];
  flowThresholds?: import('./flow.ts').FlowThresholds;
  policy?: import('./policy.ts').ControlPolicy;
  mainBranch: string;
  integrationBranch: string;
  stabilizeBranch: string;
  promotionParallelism: number;
  promotionPlacement?: PromotionPlacementSettings;
  branchPrefix: string;
  localFile: string;
  pools: Pool[];
  routingFile: string;
  riskAreasFile: string;
  gate: string[];
  formatCommand: string[];
  /** Checks selected by changed paths and run by the independent verifier after integration. */
  verifierChecks?: AffectedTestCheck[];
  /** Legacy landing selection retained for main-lane compatibility; never used by the dev landing train. */
  affectedTests?: AffectedTestCheck[];
  /** The command prefix for sibling tests selected by the independent verifier. */
  siblingTests?: SiblingTests;
  /** Repository boot tests the verifier runs on each newest dev head before queued checks. */
  bootSmoke?: { tests: string[] };
  derivedFiles?: DerivedFile[];
  terminationGraceMs: number;
  /** How long a worker may write nothing before it counts as never started; START_GRACE_MS by default. */
  startGraceMs?: number;
  /** How long a running worker may go without log, worktree or process-group CPU activity; 40 minutes by default. */
  silenceMs?: number;
  /** Tool-blocker retry delays by sightings of the same fingerprint; TOOL_RETRY_BACKOFF_MS by default. */
  toolRetryBackoffMs?: readonly number[];
  codex: {
    serviceTier: string;
    compactTokens: { sol: number; luna: number };
    solContextWindow: number;
    toolOutputTokens: number;
    backgroundTerminalMaxTimeoutMs: number;
  };
  integration: {
    batchSize: number;
    batchAcceptanceConcurrency: number;
    devLandingChecks: boolean;
    devPrelandingTypecheck?: boolean;
    devLandingBootCheck?: boolean;
    devKernelImport?: boolean;
    gateConcurrency: number;
    gateTimeoutMs: number;
    managerDirectory: string;
    inboxDirectory: string;
    managerSocket: string;
    tmuxSocket: string;
    termspacesCommand: string;
    supermanager: string;
    /** Authenticated operations manager allowed to register original proofs for another owner. */
    operationsManager?: string;
    /** Optional argv prefix for the nonblocking hourly report notifier. */
    hourlyReportNotifier?: string[];
    hourlyReportTimeoutMs: number;
    /** Clean captured integration source used only to read historical native custody data. */
    checkScriptReaderRoot?: string;
    managerLimits: { turns: number; turnsWithoutDecision: number; wallMs: number };
    tmuxCommand: string;
    tmuxSession: string;
    managerCompactTokens: number;
    checkResultReuse: boolean;
  };
};
export type Brief = {
  /** Dispatch hygiene measurements; warnings never prevent task creation. */
  lintWarnings?: string[];
  proof?: ProofMetadata;
  continuation?: BriefContinuation;
  goal: string;
  manager: string;
  kind: TaskKind;
  paths: string[];
  riskAreas: string[];
  acceptance: {
    /** For ordinary dev outcome briefs, an empty command is paired with workerOwned. */
    command: string[];
    tests: string[];
    failing: boolean;
    /** Set by the parser when an ordinary dev product brief omits its acceptance command. */
    workerOwned?: true;
    /** Omitted briefs keep the existing placement policy; local opts into the audited local command boundary. */
    placement?: AcceptancePlacement;
    /** Checks the outcome needs; interface briefs and paths that include stories imply browser. */
    requires?: AcceptanceRequirement[];
  };
  /** Ordinary dev product briefs default to the routing slice ceiling when no estimate is supplied. */
  estimate: { lines: number; files: number };
  /** Authorized repair work uses reserved host slots. */
  urgent?: boolean;
  criticalPath: boolean;
  waiting: string[];
  after: string[];
  inseparable: boolean;
  citesSources: boolean;
  hostileInput: boolean;
  markdown: string;
  /**
   * A fix for the frozen promotion candidate bases on and integrates into the stabilize branch. Control-plane work
   * with `main` or `stabilize` is released through the main proof lane; without a target it lands on dev.
   */
  target?: 'stabilize' | 'main';
  /** A provider model (and effort) this task runs on instead of its class route. */
  model?: string;
  effort?: string;
  /** Models fanned out as independent tasks by the backlog; only valid on research briefs. */
  researchers?: string[];
  /** Controller-owned identity shared by the tasks in one research fan-out. */
  researchGroup?: string;
  /** Report path assigned to one researcher task. */
  researchReport?: string;
};
export type PoolReading = {
  pool: string;
  allowanceKey: string;
  at: string;
  observedAt: string | null;
  windows: { window?: string; usedPercent: number; resetsAt: number | null; minutes: number | null }[];
  exhausted: boolean;
  error: string | null;
};
export type Task = {
  proofAuthorization?: import('./verification.ts').ProofAuthorization;
  proofRun?: import('./verification.ts').ProofReservation;
  id: string;
  sequence: number;
  brief: Brief;
  briefPath: string;
  state: TaskState;
  worktree: string;
  branch: string;
  base: string;
  workspace?: { module: string; taskName: string };
  taskClass: TaskClass;
  currentAttempt: number;
  createdAt: string;
  /** Priority mutations are appended here; absent history on older tasks is unknown legacy provenance. */
  priorityHistory?: PriorityHistoryEntry[];
  /** Task-bound grants authorizing one manager to raise this task to critical priority. */
  priorityGrants?: PriorityGrant[];
  /** A held contract change is recorded on the next attempt once its dependencies are met. */
  pendingBriefChange?: { previousBriefHash: string; newBriefHash: string };
  /** `retry --fresh-session`: the next attempt starts a new provider session; cleared when that attempt is created. */
  freshSession?: boolean;
  /** Set on a brief chained into the warm session of a landed task; its first attempt resumes that session. */
  chain?: ChainLink;
  /** Checks the brief requires that this launch's conditions defer to the dev verifier. */
  deferredAcceptance?: AcceptanceRequirement[];
  integratedBase?: string;
  integratedCommits?: string[];
  integratedCommit?: string;
  mergedCommit?: string;
};
export type PriorityHistoryEntry = {
  value: 'critical' | 'normal';
  setter: string | null;
  grantor: string | null;
  at: string;
  grantId?: string;
  provenance: { kind: 'manager-session'; sessionId: string } | { kind: 'programmatic' };
};
export type PriorityGrant = {
  id: string;
  taskId: string;
  grantor: string;
  grantee: string;
  scope: 'critical-path';
  grantedAt: string;
  provenance: { kind: 'manager-session'; sessionId: string };
  consumedAt?: string;
  consumedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
};
export type IntegrationPlan = { taskId: string; attempt: number; base: string; commit: string; commits: string[] };
export type DevVerifierResult = 'pass' | 'fail' | 'infrastructure';
export type DevVerifierCause = 'compiler' | 'product-runtime' | 'setup' | 'transport' | 'cleanup';
export type DevVerifierCommand = { argv: string[]; cwd?: string };
export type DevVerifierDiagnosticLocation = {
  file: string;
  line?: number;
  column?: number;
  workspace?: string;
  resolved: boolean;
};
export type DevVerifierDiagnostic = {
  cause: DevVerifierCause;
  message: string;
  code?: string;
  location?: DevVerifierDiagnosticLocation;
};
export type DevVerifierEvidence = {
  commit: string;
  command: string[];
  passed: boolean;
  timedOut: boolean;
  output: string;
  logPath: string;
  /** Classification of the executed check; older cached evidence may not have this field. */
  result?: DevVerifierResult;
  cwd?: string;
};
export type DevVerifierRun = {
  key: string;
  createdAt: string;
  evidence: DevVerifierEvidence;
  round?: DevVerifierRoundSummary;
};
export type DevVerifierRoundSummary = {
  baseCommit: string;
  headCommit: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  testsRun: number;
  passed: number;
  failed: number;
  unknown: number;
  fullSuite: boolean;
  pendingChecks: { command: string[]; closure: string[]; taskId?: string; cwd?: string }[];
};
export type DevVerifierFinding = {
  rangeKey: string;
  identity: string;
  signature: string;
  baseCommit: string;
  headCommit: string;
  status: 'existing' | 'new' | 'unknown';
  result: DevVerifierResult;
  check: { command: string[]; closure: string[]; taskId?: string; cwd?: string };
  assertion: string;
  test?: string;
  cause?: DevVerifierCause;
  diagnostic?: DevVerifierDiagnostic;
  baseline: DevVerifierEvidence | null;
  head: DevVerifierEvidence | null;
  reason: string;
  taskId?: string;
  createdAt: string;
};
export type RetryIntent = AttemptRef & {
  /** When this intent entered the queue. Older records may lack the timestamp. */
  queuedAt?: string;
  options: {
    evidence?: string;
    escalation?: string;
    fixRound?: number;
    consulted?: boolean;
    consultation?: string;
    excludePools?: string[];
    conflictFiles?: string[];
    /** A backed-off retry starts no earlier than this ISO time. */
    notBefore?: string;
    /** Start the next attempt in a new provider session while preserving its branch and worktree. */
    freshSession?: boolean;
    /** A check-host transport retry waits only while every eligible performance host is in a probed outage. */
    awaitCheckHosts?: boolean;
    profile?: Profile;
    /** Exact dev-landing compiler feedback for the same-session continuation. */
    landingDiagnostic?: string;
  };
  status: 'pending' | 'started' | 'abandoned';
  abandonedBy?: 'stop' | 'cancel';
  nextAttempt?: number;
};
/** A manager-accepted replacement brief waiting for the next retry to consume it. */
export type PendingBriefProposal = {
  id: number;
  taskId: string;
  writtenForAttempt: number;
  previousBriefHash: string;
  newBriefHash: string;
  markdown: string;
  createdAt: string;
};
export type BriefProposalRecord = Omit<PendingBriefProposal, 'id'>;
export type WorktreeCleanupDisposition = {
  taskId: string;
  /** Fingerprint of the exact offending path and its in-worktree ancestors. */
  generation: string;
  path: string;
  owner: { uid: number; gid: number } | null;
  worktreeIdentity: { dev: string; ino: string };
  detail: string;
  recordedAt: string;
};
export type MaintenanceCandidateRef = {
  ticket: number;
  kind: 'worktree' | 'reap';
  taskId: string;
  attempt: number;
};
export type WorktreeMaintenanceCandidate = MaintenanceCandidateRef & { kind: 'worktree'; task: Task };
export type ProcessMaintenanceCandidate = MaintenanceCandidateRef & {
  kind: 'reap';
  worktree: string;
  process: ProcessIdentity;
};
export type StrayWorktreeCandidate = { ticket: number; path: string };
export type WorktreeScanDirectory = {
  watch_ticket: number;
  root: string;
  path: string;
  generation: string | null;
  offset: number;
  complete: boolean;
};
export type MaintenanceBackfillProgress = { examined: number; complete: boolean };
export type PromotionGateResult = {
  commit: string;
  command: string[];
  passed: boolean;
  timedOut: boolean;
  firstFailure?: FirstFailure;
};
export type PromotionRun = {
  id: string;
  phase:
    | 'gate-head'
    | 'classify-main'
    | 'classify-prefixes'
    | 'revert-planned'
    | 'revert-published'
    | 'route-culprit'
    | 'gate-remainder'
    | 'publish-main'
    | 'report-environment'
    | 'blocked'
    | 'stabilize-blocked';
  mainBase: string;
  devHead: string;
  taskIds: string[];
  rootGate: string[];
  promotionParallelism: number;
  /** Snapshot of the ordinary host input used by every gate in this promotion run. */
  placement?: PromotionPlacementSnapshot;
  boundaries: { taskId: string; commit: string }[];
  headResults: PromotionGateResult[];
  prefixResults: PromotionGateResult[];
  failedCommand?: string[];
  firstFailure?: FirstFailure;
  mainResult?: PromotionGateResult;
  culpritAttempt?: number;
  culpritTaskId?: string;
  closureTaskIds?: string[];
  remainingTaskIds?: string[];
  revertBase?: string;
  revertCommit?: string;
  /** A culprit that later tasks build on is fixed forward; promotion waits for its next integrated attempt. */
  blockedOn?: { taskId: string; attempt: number };
  promoteHead?: string;
  promoteTaskIds?: string[];
  /** Same-candidate retries of infrastructure-only stabilize gate failures. */
  infrastructureReruns?: {
    kind: 'promotion-infrastructure-rerun';
    commit: string;
    command: string[];
    attempt: number;
    initial: PromotionGateResult;
    result: PromotionGateResult;
    log: string;
  }[];
};
export type AttemptFailure = 'spec-conflict' | 'scope-growth' | 'pool-exhausted' | 'tool';
export type TerminationIntent = {
  operation: 'stop' | 'cancel';
  requestedAt: string;
  state: 'requested' | 'unknown' | 'complete';
  processIdentity: 'known' | 'not-started' | 'waiting' | 'unknown';
  process: ProcessIdentity | null;
  auxiliaryProcesses: ProcessIdentity[];
  error?: string;
  /** The requested disposition was committed after physical termination was confirmed. */
  settledAt?: string;
};
export type Attempt = AttemptRef & {
  /** Completed source waiting only for compiler evidence, never a source-writing retry. */
  typingEvidencePending?: { result: string; command?: string[] };
  state: 'pending' | 'running' | 'waiting' | 'exited' | 'superseded' | 'stopped' | 'cancelled';
  /** Detached check runs whose completion will resume this attempt's session. */
  checks?: string[];
  /** Durable operator disposition, distinct from confirmed process-group termination. */
  terminationIntent?: TerminationIntent;
  previousBriefHash?: string;
  newBriefHash?: string;
  supersededFinalized?: boolean;
  affectedTests?: AffectedTestResult[];
  failureKind?: AttemptFailure | null;
  profile: Profile;
  pool: string;
  tableVersion: string;
  experiment: string | null;
  startedAt: string;
  endedAt: string | null;
  process: ProcessIdentity | null;
  driver: ProcessIdentity | null;
  logPath: string;
  evidencePath: string;
  auxiliaryProcesses: ProcessIdentity[];
  session: string | null;
  fixRound: number;
  consulted: boolean;
  previousFailure: string | null;
  failure: FirstFailure | null;
  escalation: string | null;
  failureCommand?: string[] | null;
  failureOnBase?: boolean | null;
  failureLogPath?: string | null;
  before: PoolReading | null;
  after: PoolReading | null;
  exitCode: number | null;
  result: string;
  blocker: string | null;
  approaches: { approach: string; result: string }[];
  /** Sources and rendered sizes of the prompt sent on this attempt; absent on older records. */
  prompt?: PromptManifest;
};
export type StepClass = 'decision' | 'read' | 'edit' | 'wait' | 'check' | 'commit';
export type Tokens = { input: number; cached: number; output: number };
export type AttemptUsage = {
  model: string;
  effort: Effort | string;
  serviceTier: string | null;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  compactions: number;
  source: 'codex-session' | 'attempt-profile';
};
export type AttemptRecord = AttemptRef & {
  /** Absent on historical records. Verification uses the implementation route but remains a separate record kind. */
  taskKind?: TaskKind;
  taskClass: TaskClass;
  profile: Profile;
  pool: string;
  tableVersion: string;
  experiment: string | null;
  startedAt: string;
  endedAt: string;
  steps: number;
  urgent?: boolean;
  criticalPath: boolean;
  tokens: Tokens;
  before: PoolReading | null;
  after: PoolReading | null;
  outcome: 'passed' | 'gate-failed' | 'stopped' | 'cancelled' | 'pending-gate' | 'superseded' | 'verified';
  proof?: import('./verification.ts').ProofObservation;
  firstFailure: string | null;
  escalation: string | null;
  consulted: boolean;
  fixRound: number;
  diffLines: number | null;
  changedFiles: string[] | null;
  /** Changed files outside the brief's declared paths; absent when there were none and on older records. */
  outsidePaths?: string[];
  /** A dev product diff beyond its estimate's tolerance, recorded instead of a scope stop; absent within it. */
  estimateOverrun?: { lines: number; files: number; estimate: { lines: number; files: number } };
  /** Guard refusals and attempt endings that priced this record; absent on historical records. */
  guardIds?: GuardId[];
  hostMs: number | null;
  classifierVersion: string;
  stepClasses: Record<StepClass, number>;
  earlyStop: boolean;
  /** Session-ledger usage is absent on older records and on imported non-Codex logs. */
  usage?: AttemptUsage | null;
  /** Sources and rendered sizes of the prompt sent on this attempt; absent on older records. */
  prompt?: PromptManifest;
};
export type FailureClass =
  | 'environment'
  | 'pool-exhausted'
  | 'repeated-assertion'
  | 'new-failure'
  | 'early-stop'
  | Exclude<ManagerEventKind, 'width'>;
