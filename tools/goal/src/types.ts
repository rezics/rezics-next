import type { ProcessIdentity } from './process.ts';
import type { AttemptRef, FirstFailure, ManagerEventKind } from './contracts.ts';

export type Cli = 'codex' | 'grok' | 'cursor';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TaskState = 'ready' | 'held' | 'running' | 'landing' | 'merged' | 'stopped' | 'cancelled';
export type TaskKind = 'implementation' | 'interface' | 'bulk-text' | 'claim' | 'specification' | 'research' | 'mechanical';
export type TaskClass = TaskKind | 'critical-path';
export type Profile = { cli: Cli; model: string; effort: Effort; poolClass: string };
export type Pool = {
  name: string; cli: Cli | 'claude'; classes: string[]; configDirectory: string; command: string;
  /** Pools with the same allowanceKey share a quota, including pools across CLIs. */
  allowanceKey: string;
  usageFile?: string;
  policy: { weight: number; reservePercent: number; allowUnknown: boolean; maxAgeMs: number; maxBurnPerHour?: number };
};
export type Settings = {
  version: 1; mainCheckout: string; stateDirectory: string; worktreeRoot: string; databasePath: string;
  mainBranch: string; branchPrefix: string; localFile: string; pools: Pool[];
  routingFile: string; riskAreasFile: string; gate: string[];
  terminationGraceMs: number;
  codex: { serviceTier: string; compactTokens: { sol: number; luna: number }; solContextWindow: number; toolOutputTokens: number };
  integration: {
    gateConcurrency: number; gateTimeoutMs: number; managerDirectory: string; inboxDirectory: string;
    managerSocket: string; tmuxSocket: string; termspacesCommand: string; supermanager: string;
    managerLimits: { turns: number; turnsWithoutDecision: number; wallMs: number };
    tmuxCommand: string; tmuxSession: string; managerCompactTokens: number;
  };
};
export type Brief = {
  goal: string; manager: string; kind: TaskKind; paths: string[]; riskAreas: string[];
  acceptance: { command: string[]; tests: string[]; failing: boolean };
  estimate: { lines: number; files: number }; criticalPath: boolean; waiting: string[]; after: string[];
  inseparable: boolean; citesSources: boolean; hostileInput: boolean; markdown: string;
};
export type PoolReading = {
  pool: string; allowanceKey: string; at: string; observedAt: string | null;
  windows: { usedPercent: number; resetsAt: number | null; minutes: number | null }[];
  exhausted: boolean; error: string | null;
};
export type Task = {
  id: string; sequence: number; brief: Brief; briefPath: string; state: TaskState;
  worktree: string; branch: string; base: string; taskClass: TaskClass; currentAttempt: number;
  createdAt: string; mergedCommit?: string;
};
export type AttemptFailure = 'spec-conflict' | 'scope-growth' | 'pool-exhausted' | 'tool';
export type Attempt = AttemptRef & {
  state: 'pending' | 'running' | 'exited' | 'superseded' | 'stopped' | 'cancelled';
  supersededFinalized?: boolean; failureKind?: AttemptFailure | null;
  profile: Profile; pool: string; tableVersion: string; experiment: string | null;
  startedAt: string; endedAt: string | null; process: ProcessIdentity | null; driver: ProcessIdentity | null;
  logPath: string; evidencePath: string; auxiliaryProcesses: ProcessIdentity[]; session: string | null; fixRound: number; consulted: boolean;
  previousFailure: string | null; failure: FirstFailure | null; escalation: string | null;
  before: PoolReading | null; after: PoolReading | null; exitCode: number | null;
  result: string; blocker: string | null; approaches: { approach: string; result: string }[];
};
export type StepClass = 'decision' | 'read' | 'edit' | 'wait' | 'check' | 'commit';
export type Tokens = { input: number; cached: number; output: number };
export type AttemptRecord = AttemptRef & {
  taskClass: TaskClass; profile: Profile; pool: string; tableVersion: string; experiment: string | null;
  startedAt: string; endedAt: string; steps: number; criticalPath: boolean; tokens: Tokens;
  before: PoolReading | null; after: PoolReading | null;
  outcome: 'passed' | 'gate-failed' | 'stopped' | 'cancelled' | 'pending-gate' | 'superseded';
  firstFailure: string | null; escalation: string | null; consulted: boolean; fixRound: number;
  diffLines: number | null; changedFiles: string[] | null; hostMs: number | null;
  classifierVersion: string; stepClasses: Record<StepClass, number>; earlyStop: boolean;
};
export type FailureClass = 'environment' | 'pool-exhausted' | 'repeated-assertion' | 'new-failure' | 'early-stop' | ManagerEventKind;
