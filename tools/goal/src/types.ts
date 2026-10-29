import type { ProcessIdentity } from './process.ts';
import type { AttemptRef, FirstFailure, ManagerEventKind } from './contracts.ts';

export type Cli = 'codex' | 'grok' | 'cursor' | 'claude';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TaskState = 'ready' | 'held' | 'running' | 'landing' | 'integrated' | 'merged' | 'stopped' | 'cancelled';
export type TaskKind =
  | 'implementation'
  | 'interface'
  | 'bulk-text'
  | 'claim'
  | 'specification'
  | 'research'
  | 'mechanical';
export type IntegrationTarget = 'main' | 'integration' | 'stabilize';
export type TaskClass = TaskKind | 'critical-path';
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
  };
};
export type AffectedTestCheck = { paths: string[]; command: string[] };
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
export type Settings = {
  version: 1;
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  /** Opt in locally. Each module has its own ws/<module> branch and persistent shared checkout. */
  sharedWebModules?: Record<string, string[]>;
  notes?: readonly import('./notes.ts').Note[];
  flowThresholds?: import('./flow.ts').FlowThresholds;
  mainBranch: string;
  integrationBranch: string;
  stabilizeBranch: string;
  promotionParallelism: number;
  branchPrefix: string;
  localFile: string;
  pools: Pool[];
  routingFile: string;
  riskAreasFile: string;
  gate: string[];
  formatCommand: string[];
  affectedTests?: AffectedTestCheck[];
  derivedFiles?: DerivedFile[];
  terminationGraceMs: number;
  /** How long a worker may write nothing before it counts as never started; START_GRACE_MS by default. */
  startGraceMs?: number;
  /** How long a running worker may go without run-log output; 40 minutes by default. */
  silenceMs?: number;
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
    gateConcurrency: number;
    gateTimeoutMs: number;
    managerDirectory: string;
    inboxDirectory: string;
    managerSocket: string;
    tmuxSocket: string;
    termspacesCommand: string;
    supermanager: string;
    managerLimits: { turns: number; turnsWithoutDecision: number; wallMs: number };
    tmuxCommand: string;
    tmuxSession: string;
    managerCompactTokens: number;
  };
};
export type Brief = {
  goal: string;
  manager: string;
  kind: TaskKind;
  paths: string[];
  riskAreas: string[];
  acceptance: { command: string[]; tests: string[]; failing: boolean };
  estimate: { lines: number; files: number };
  criticalPath: boolean;
  waiting: string[];
  after: string[];
  inseparable: boolean;
  citesSources: boolean;
  hostileInput: boolean;
  markdown: string;
  /** A fix for the frozen promotion candidate bases on and integrates into the stabilize branch. */
  target?: 'stabilize';
  /** A Codex model (and effort) this task runs on instead of its class route, such as deep research on Sol max. */
  model?: string;
  effort?: string;
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
  /** A held contract change is recorded on the next attempt once its dependencies are met. */
  pendingBriefChange?: { previousBriefHash: string; newBriefHash: string };
  integratedBase?: string;
  integratedCommits?: string[];
  integratedCommit?: string;
  mergedCommit?: string;
};
export type IntegrationPlan = { taskId: string; attempt: number; base: string; commit: string; commits: string[] };
export type RetryIntent = AttemptRef & {
  options: {
    evidence?: string;
    escalation?: string;
    fixRound?: number;
    consulted?: boolean;
    consultation?: string;
    excludePools?: string[];
    conflictFiles?: string[];
    profile?: Profile;
  };
  status: 'pending' | 'started';
  nextAttempt?: number;
};
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
export type Attempt = AttemptRef & {
  state: 'pending' | 'running' | 'exited' | 'superseded' | 'stopped' | 'cancelled';
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
  taskClass: TaskClass;
  profile: Profile;
  pool: string;
  tableVersion: string;
  experiment: string | null;
  startedAt: string;
  endedAt: string;
  steps: number;
  criticalPath: boolean;
  tokens: Tokens;
  before: PoolReading | null;
  after: PoolReading | null;
  outcome: 'passed' | 'gate-failed' | 'stopped' | 'cancelled' | 'pending-gate' | 'superseded';
  firstFailure: string | null;
  escalation: string | null;
  consulted: boolean;
  fixRound: number;
  diffLines: number | null;
  changedFiles: string[] | null;
  hostMs: number | null;
  classifierVersion: string;
  stepClasses: Record<StepClass, number>;
  earlyStop: boolean;
  /** Session-ledger usage is absent on older records and on imported non-Codex logs. */
  usage?: AttemptUsage | null;
};
export type FailureClass =
  | 'environment'
  | 'pool-exhausted'
  | 'repeated-assertion'
  | 'new-failure'
  | 'early-stop'
  | ManagerEventKind;
