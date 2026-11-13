import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Database } from 'bun:sqlite';
import { acquireDirectoryLeaseWaiting } from './lease.ts';
import { identityLive, sameProcess } from './process.ts';
import {
  cleanupReceiptPath,
  isCheckId,
  isPhysicalRunId,
  physicalHistoryPath,
  remoteRunCustodyPath,
  validateRunnerIdentity,
  writeAtomicJson,
  type RunnerIdentity,
} from '../../../scripts/check-custody.ts';
import { parseRemotePhysicalRunReceipt } from '../../../scripts/remote-check.ts';
import type { AuthenticatedManager } from './priority-authority.ts';
import { readMeasurement } from './records.ts';
import type { Task, Attempt, RetryIntent } from './types.ts';
import {
  captureTypingInputs,
  isKnownTypingCompiler,
  isRetainedKernelTypingCompiler,
  readTypingInputReceipt,
  qualifyTypingInputs,
  type TypingInput,
  type TypingInputReceipt,
} from './worker-check-typing-inputs.ts';

/** One combined check plus one rerun after that check failed. */
export const WORKER_CHECK_HOST_RUN_LIMIT = 2;
export const WORKER_CHECK_HOST_BUDGET_REFUSAL =
  'Check-host budget exhausted: this attempt already used its one check and one rerun. Finish the outcome and return success or a blocker.';
export const WORKER_CHECK_HOST_TYPECHECK_REFUSAL =
  "Check-host budget exhausted: this attempt's final verification run failed its typecheck. Return a blocker naming those type errors, not success.";
/** Transport, upload or probe failure before the check command ran (`scripts/remote-check.ts`). */
export const WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT = 75;
export const WORKER_CHECK_TESTS_AFTER_LANDING = 'Tests run after landing in the dev verifier.';
const STAMP_NAME = /^[1-9]\d*$/;
const CHECK_RESULT_MAX_BYTES = 1_048_576;
const TYPECHECK_COMMAND = /(?:^|[\s;|&])(?:[^\s;|&]*\/)?typecheck(?:\.ts|:root)?(?=$|[\s;|&])/;
const TYPECHECK_FAILURE =
  /error TS\d+|error: script "typecheck" exited|error:\s*"typecheck" exited|error: Failed to run .*typecheck/;
const TYPING_LOG_CHARACTERS = 8192;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MONEY_DIRECTORY = /(^|\/)(?:commerce|checkout|payouts?|payments?|balance|points)(\/|$)/i;
const MONEY_FILE = /(^|\/)(?:payouts?|payments?|balance)(?:[-.]|$)/i;
const BROWSER_COMMAND = /(?:^|\/)(?:playwright|puppeteer|cypress|chrom(?:e|ium)|storybook)(?:$|[/\s.-])/i;
const GROWTH_COMMAND = /(?:^|\/)growth(?:\.ts)?$/i;
const NATIVE_COMMAND = /(?:^|\/)(?:isolated\.ts|check\.ts)$|(?:^|\/)auth-binding-host(?:$|[/\s.-])/i;
const TYPECHECK_ARGUMENT = /(?:^|\/)typecheck(?:\.ts)?$/;
const SHELL = new Set(['sh', 'bash', 'dash', 'zsh']);
const SKIP_STATEMENT = /^(?:s=\$\?|s=1|exit(?:\s+\$s)?)$/;

export type WorkerCheckHostBudgetLimit = typeof WORKER_CHECK_HOST_RUN_LIMIT | 'off';

export type WorkerCheckBudgetTask = {
  brief?: {
    goal?: string;
    kind?: string;
    urgent?: boolean;
    acceptance?: { requires?: readonly string[] };
  };
  proofRun?: { binding?: { attempt?: number } } | null;
  proofAuthorization?: unknown;
};

/** Native receipt fields that prove the remote check command started. */
export type WorkerCheckHostCommandReceipt = {
  resources?: { commandStartedMonoMs?: number | null } | null;
};

export type WorkerCheckHostStampRecord = {
  content?: string;
  final?: boolean;
  exitCode?: number;
  typecheckFailed?: boolean;
  includedTypecheck?: boolean;
  log?: string;
  typingRequest?: {
    physicalRunId: string;
    command: string[];
    localPrepared: TypingInput[];
    capture?: 'physical-command';
  };
  typingInputs?: TypingInputReceipt;
  typingInputsUnavailable?: string;
  typingRecovery?: { token: string; checkId: string; physicalRunId: string };
};

/** Controller-owned stamp directory beside the attempt's check-wait file. */
export function workerCheckBudgetDirectory(stateDirectory: string, taskId: string, attempt: number): string {
  return join(stateDirectory, 'runs', taskId, `${attempt}.check-host-runs`);
}

/**
 * Proof-run, registered-proof and acceptance-requiring briefs keep their declared checks. Urgent and control-plane
 * tasks are exempt. Everyone else is held to one check-host wrapper run plus one rerun after a failure.
 */
export function workerCheckHostBudgetLimit(task: WorkerCheckBudgetTask, attempt?: number): WorkerCheckHostBudgetLimit {
  const brief = task.brief;
  if (brief?.urgent === true || brief?.goal === 'control-plane') return 'off';
  if ((brief?.acceptance?.requires?.length ?? 0) > 0) return 'off';
  if (brief?.kind === 'verification' && task.proofAuthorization) return 'off';
  if (brief?.kind === 'verification' && attempt !== undefined && task.proofRun?.binding?.attempt === attempt)
    return 'off';
  return WORKER_CHECK_HOST_RUN_LIMIT;
}

export function workerCheckHostRunsUsed(directory: string): number {
  try {
    return stampNames(directory).length;
  } catch {
    return 0;
  }
}

function stampNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => STAMP_NAME.test(name))
    .sort((left, right) => Number(left) - Number(right));
}

function nextWorkerCheckHostStamp(directory: string): string {
  const names = new Set(stampNames(directory));
  for (let n = 1; ; n += 1) {
    const stamp = String(n);
    if (!names.has(stamp)) return stamp;
  }
}

function git(worktree: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  return result.stdout;
}

/** Tree of the worktree contents, including uncommitted edits and untracked files Git does not ignore. */
export function workerCheckHostContentTree(worktree: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-check-tree-'));
  const index = join(directory, 'index');
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(worktree, ['read-tree', 'HEAD'], env);
    git(worktree, ['add', '-A'], env);
    return git(worktree, ['write-tree'], env).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readWorkerCheckHostStamp(directory: string, stamp: string): WorkerCheckHostStampRecord {
  const raw = readFileSync(join(directory, stamp), 'utf8').trim();
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`worker check-host stamp ${stamp} is not an object`);
  return value as WorkerCheckHostStampRecord;
}

function writeStamp(directory: string, stamp: string, record: WorkerCheckHostStampRecord, flag?: 'wx'): void {
  writeFileSync(join(directory, stamp), `${JSON.stringify(record)}\n`, flag ? { flag } : undefined);
}

function lastStamp(directory: string): { name: string; record: WorkerCheckHostStampRecord } | undefined {
  const names = stampNames(directory);
  const name = names.at(-1);
  return name ? { name, record: readWorkerCheckHostStamp(directory, name) } : undefined;
}

export function checkCommandIncludesTypecheck(argv: readonly string[] | undefined, log = ''): boolean {
  if (argv?.some((part) => TYPECHECK_COMMAND.test(part))) return true;
  return TYPECHECK_COMMAND.test(log);
}

export function workerCheckHostTypecheckFailed(log: string, argv?: readonly string[]): boolean {
  if (!checkCommandIncludesTypecheck(argv, log)) return TYPECHECK_FAILURE.test(log);
  return TYPECHECK_FAILURE.test(log);
}

function boundedLog(path: string | undefined): string {
  if (!path) return '(check log unavailable)';
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= TYPING_LOG_CHARACTERS ? text : text.slice(-TYPING_LOG_CHARACTERS);
  } catch {
    return `(check log unavailable: ${path})`;
  }
}

type TypingStampEvidence = {
  receipt?: TypingInputReceipt;
  rejected: boolean;
  reason?: string;
};

function typingStampEvidence(worktree: string, source: WorkerCheckHostStampRecord): TypingStampEvidence {
  let receipt = source.typingInputs;
  let rejected = false;
  let reason = source.typingInputsUnavailable;
  if (!receipt && source.typingRequest) {
    try {
      receipt = readTypingInputReceipt(worktree, source.typingRequest.physicalRunId, source.typingRequest.command);
    } catch (error) {
      reason = String(error);
      rejected = true;
    }
  }
  if (
    receipt &&
    (!source.typingRequest ||
      receipt.physicalRunId !== source.typingRequest.physicalRunId ||
      JSON.stringify(receipt.command) !== JSON.stringify(source.typingRequest.command))
  ) {
    receipt = undefined;
    rejected = true;
    reason ??= 'Retained compiler receipt does not match the exact physical invocation identity.';
  }
  return { ...(receipt ? { receipt } : {}), rejected, ...(reason ? { reason } : {}) };
}

function typingFailureResult(source: WorkerCheckHostStampRecord, reason?: string): string {
  const log = source.log ? boundedLog(source.log) : '(check log unavailable)';
  const summary =
    `${TYPING_SETTLEMENT_FAILED} Settlement records a typing failure with that run's log, ` +
    'so this attempt is retried instead of landing.';
  return `${summary}\n${reason ?? ''}\n${log}`;
}

/** A failure receipt is current only when its stable compiler inputs still match the retained source. */
function typingFailureInputsMatch(
  worktree: string,
  receipt: TypingInputReceipt,
  localPrepared: readonly TypingInput[] = [],
): boolean {
  if (!receipt.sourceStable) return false;
  const current = captureTypingInputs(worktree, receipt.compilerCommand);
  if (
    current.runtime !== receipt.completed.runtime ||
    current.profile !== receipt.completed.profile ||
    JSON.stringify(current.excludedDocuments) !== JSON.stringify(receipt.completed.excludedDocuments) ||
    JSON.stringify(current.source) !== JSON.stringify(receipt.completed.source)
  )
    return false;
  const baseline = new Map(localPrepared.map((entry) => [entry.path, entry.digest]));
  const compiled = new Map(receipt.completed.prepared.map((entry) => [entry.path, entry.digest]));
  if (
    current.prepared.some(
      (entry) => compiled.get(entry.path) !== entry.digest && baseline.get(entry.path) !== entry.digest,
    )
  )
    return false;
  return localPrepared.every(
    (entry) => current.prepared.some((currentEntry) => currentEntry.path === entry.path) || entry.digest === 'missing',
  );
}

export const TYPING_RECOVERY_ENV = 'GOAL_WORKER_CHECK_TYPING_RECOVERY';
type TypingRecoveryGrant = {
  version: 1;
  token: string;
  taskId: string;
  attempt: number;
  worktree: string;
  stateDirectory: string;
  database: string;
  command: string[];
  identity: string;
  actor: AuthenticatedManager;
  checkId: string;
  physicalRunId: string;
  stamp?: string;
  replacementOf?: string;
  recoveryKind?: 'withdrawn-budget-stop';
};
const recoveryPath = (directory: string, token: string) => {
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('Invalid typing recovery token');
  return join(directory, 'typing-recovery', `${token}.json`);
};
function recoveryIdentity(worktree: string, command: readonly string[]): string {
  if (!isKnownTypingCompiler(worktree, command))
    throw new Error('Typing recovery requires an installed owning compiler command');
  return createHash('sha256')
    .update(
      JSON.stringify({
        head: git(worktree, ['rev-parse', 'HEAD']).trim(),
        inputs: captureTypingInputs(worktree, command),
      }),
    )
    .digest('hex');
}

type CheckEvidence = {
  [key: string]: unknown;
  version?: unknown;
  id?: unknown;
  checkId?: unknown;
  cwd?: unknown;
  argv?: unknown;
  remoteArgv?: unknown;
  status?: unknown;
  exitCode?: unknown;
  physicalRunId?: unknown;
  runnerHost?: unknown;
  runnerPid?: unknown;
  runnerIdentity?: unknown;
  disposition?: unknown;
  recordSha256?: unknown;
  receiptReference?: unknown;
  receiptSha256?: unknown;
  ownership?: { taskId?: unknown; attempt?: unknown };
  physicalRun?: {
    exitCode?: unknown;
    resources?: { commandStartedMonoMs?: unknown } | null;
  };
  binding?: {
    checkId?: unknown;
    ownership?: { taskId?: unknown; attempt?: unknown };
    argv?: unknown;
    remoteArgv?: unknown;
  };
  attempts?: unknown;
  host?: unknown;
  native?: unknown;
  remoteExpected?: unknown;
  terminalProof?: { local?: unknown; resultKnown?: unknown; remote?: unknown };
  signal?: unknown;
  schema?: unknown;
  remoteRun?: { host?: unknown; id?: unknown };
  physicalCleanup?: unknown;
  resultTerminal?: unknown;
  localTerminal?: unknown;
  remoteTerminal?: unknown;
  receiptId?: unknown;
  physicalRunReference?: unknown;
};

function readCheckEvidence(path: string): CheckEvidence | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as CheckEvidence) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

type OptionalCheckEvidence = { state: 'absent' } | { state: 'invalid' } | { state: 'present'; value: CheckEvidence };

/** Distinguish a missing legacy file from a present but unreadable newer record. */
function readOptionalCheckEvidence(path: string): OptionalCheckEvidence {
  try {
    if (!lstatSync(path).isFile()) return { state: 'invalid' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent' };
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'ELOOP') return { state: 'invalid' };
    throw error;
  }

  try {
    const value = readCheckEvidence(path);
    return value ? { state: 'present', value } : { state: 'invalid' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ENOENT' ||
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'EISDIR' ||
      code === 'ENOTDIR' ||
      code === 'ELOOP'
    )
      return { state: 'invalid' };
    throw error;
  }
}

function terminalPhysicalHistory(worktree: string, checkId: string, physicalRunId: string, exitCode?: number): boolean {
  const history = readCheckEvidence(
    join(worktree, '.temp', 'goal', 'checks', 'custody', 'history', `${checkId}.${physicalRunId}.json`),
  );
  return Boolean(
    history?.version === 1 &&
    history.id === checkId &&
    history.cwd === worktree &&
    history.physicalRunId === physicalRunId &&
    history.status === 'finished' &&
    Number.isInteger(history.exitCode) &&
    (exitCode === undefined || history.exitCode === exitCode) &&
    history.terminalProof?.local === true &&
    history.terminalProof?.resultKnown === true &&
    (history.remoteExpected === true
      ? history.terminalProof?.remote === true
      : history.remoteExpected === false && history.terminalProof?.remote === null),
  );
}

function ownedRunnerIdentity(value: unknown): RunnerIdentity | undefined {
  try {
    const identity = validateRunnerIdentity(value);
    return identity.group === identity.pid ? identity : undefined;
  } catch {
    return undefined;
  }
}

function checkEvidenceArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.every((part) => typeof part === 'string' && part.length <= 4096 && !part.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value)) <= 56 * 1024
  );
}

/** Legacy finished checks may use a native result receipt when newer remote custody is genuinely absent. */
function retainedNativeExitReceiptTerminal(
  worktree: string,
  taskId: string,
  attempt: number,
  record: CheckEvidence,
): boolean {
  if (
    record.status !== 'finished' ||
    typeof record.id !== 'string' ||
    !isCheckId(record.id) ||
    typeof record.physicalRunId !== 'string' ||
    !isPhysicalRunId(record.physicalRunId) ||
    record.cwd !== worktree ||
    record.ownership?.taskId !== taskId ||
    record.ownership.attempt !== attempt ||
    !checkEvidenceArgv(record.argv) ||
    !Number.isInteger(record.exitCode)
  )
    return false;

  const root = join(worktree, '.temp', 'goal', 'checks');
  const physical = readCheckEvidence(join(root, 'custody', 'history', `${record.id}.${record.physicalRunId}.json`));
  if (
    !physical ||
    physical.version !== 1 ||
    physical.id !== record.id ||
    physical.cwd !== worktree ||
    physical.physicalRunId !== record.physicalRunId ||
    physical.status !== 'finished' ||
    physical.terminalProof !== undefined ||
    physical.remoteExpected !== true ||
    physical.ownership?.taskId !== taskId ||
    physical.ownership.attempt !== attempt ||
    physical.exitCode !== record.exitCode ||
    !checkEvidenceArgv(physical.argv) ||
    !isDeepStrictEqual(physical.argv, record.argv)
  )
    return false;

  const runner = ownedRunnerIdentity(record.runnerIdentity);
  const physicalRunner = ownedRunnerIdentity(physical.runnerIdentity);
  if (
    !runner ||
    !physicalRunner ||
    !isDeepStrictEqual(runner, physicalRunner) ||
    record.runnerPid !== runner.pid ||
    record.runnerHost !== hostname() ||
    physical.runnerHost !== record.runnerHost ||
    identityLive(runner)
  )
    return false;

  if (
    existsSync(join(root, 'cancellations', `${record.id}.json`)) ||
    existsSync(join(root, 'custody', 'cancelled', `${record.id}.json`)) ||
    existsSync(join(root, 'custody', 'stopping', `${record.id}.${record.physicalRunId}.json`))
  )
    return false;

  const resultReceipt = parseRemotePhysicalRunReceipt(record.physicalRun);
  const custodyState = readOptionalCheckEvidence(remoteRunCustodyPath(worktree, record.physicalRunId));
  if (custodyState.state === 'invalid' || !resultReceipt) return false;

  let receipt = resultReceipt;
  if (custodyState.state === 'present') {
    const custody = custodyState.value;
    const binding = custody.binding;
    const attempts = custody.attempts;
    if (
      custody.version !== 1 ||
      custody.physicalRunId !== record.physicalRunId ||
      custody.status !== 'terminal' ||
      !binding ||
      binding.checkId !== record.id ||
      binding.ownership?.taskId !== taskId ||
      binding.ownership.attempt !== attempt ||
      !checkEvidenceArgv(binding.argv) ||
      !isDeepStrictEqual(binding.argv, record.argv) ||
      !checkEvidenceArgv(physical.remoteArgv) ||
      !checkEvidenceArgv(binding.remoteArgv) ||
      !isDeepStrictEqual(binding.remoteArgv, physical.remoteArgv) ||
      !Array.isArray(attempts) ||
      attempts.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          !['terminal', 'not-started'].includes(String((item as CheckEvidence).status)),
      )
    )
      return false;

    const managedAttempts = attempts as CheckEvidence[];
    const completed = managedAttempts.filter((item) => item.status === 'terminal');
    if (completed.length !== 1) return false;
    const managed = completed[0]!;
    if (
      typeof managed.host !== 'string' ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(managed.host) ||
      typeof managed.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,96}$/.test(managed.id)
    )
      return false;
    const managedReceipt = parseRemotePhysicalRunReceipt(managed.native);
    if (!managedReceipt || managed.host !== managedReceipt.host || managed.id !== managedReceipt.run) return false;
    receipt = managedReceipt;
  }

  const historyReceipt =
    physical.physicalRun === undefined ? undefined : parseRemotePhysicalRunReceipt(physical.physicalRun);
  if (
    !isDeepStrictEqual(receipt, resultReceipt) ||
    (physical.physicalRun !== undefined && (!historyReceipt || !isDeepStrictEqual(receipt, historyReceipt))) ||
    receipt.exitCode !== record.exitCode ||
    receipt.lifetimeFailure !== null ||
    !receipt.resources ||
    receipt.resources.commandStartedMonoMs === null ||
    receipt.resources.commandStartedMonoMs <= 0 ||
    receipt.resources.terminalMonoMs <= 0
  )
    return false;

  return true;
}

/** Exact structured worker outcome needed to recover completed source after its retry was withdrawn. */
export function workerCheckHostBudgetRefusalReport(result: string | null | undefined): boolean {
  if (!result) return false;
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as {
    status?: unknown;
    checks?: unknown;
    blocker?: { kind?: unknown; detail?: unknown } | null;
  };
  return (
    report.status === 'blocked' &&
    report.blocker?.kind === 'tool' &&
    typeof report.blocker.detail === 'string' &&
    report.blocker.detail.startsWith(WORKER_CHECK_HOST_BUDGET_REFUSAL) &&
    Array.isArray(report.checks) &&
    report.checks.length === 0
  );
}

/** Recover the original report only from the native authorization event that retained its validated origin. */
function retainedWithdrawnBudgetOriginReport(input: {
  db: Database;
  grant: TypingRecoveryGrant;
  task: Task;
  attempt: Attempt;
  progress?: { endHead?: unknown };
  directory: string;
}): string | undefined {
  const { db, grant, task, attempt, progress, directory } = input;
  const sourceHead = progress?.endHead;
  if (
    grant.recoveryKind !== 'withdrawn-budget-stop' ||
    JSON.stringify(grant.command) !== JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck']) ||
    attempt.state !== 'stopped' ||
    JSON.stringify(attempt.typingEvidencePending?.command) !== JSON.stringify(grant.command) ||
    typeof attempt.result !== 'string' ||
    typeof sourceHead !== 'string'
  )
    return;

  const row = db
    .query(
      "SELECT body FROM worker_events WHERE task_id=? AND attempt=? AND kind='typing-recovery-authorized' ORDER BY sequence DESC LIMIT 1",
    )
    .get(grant.taskId, grant.attempt) as { body: string } | null;
  if (!row) return;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    body = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    Object.keys(body).sort().join(',') !== 'actor,checkId,command,identity,recoveryKind,token,withdrawnBudgetOrigin' ||
    body.recoveryKind !== grant.recoveryKind ||
    body.token !== grant.token ||
    body.identity !== grant.identity ||
    body.checkId !== grant.checkId ||
    JSON.stringify(body.command) !== JSON.stringify(grant.command)
  )
    return;
  const actor = body.actor as { id?: unknown; sessionId?: unknown } | null;
  if (
    !actor ||
    typeof actor.id !== 'string' ||
    typeof actor.sessionId !== 'string' ||
    actor.id !== grant.actor.id ||
    actor.sessionId !== grant.actor.sessionId
  )
    return;
  const failureRow = db
    .query(
      "SELECT body FROM worker_events WHERE task_id=? AND attempt=? AND kind='typing-evidence-failed' ORDER BY sequence DESC LIMIT 1",
    )
    .get(grant.taskId, grant.attempt) as { body: string } | null;
  if (!failureRow) return;
  let failureBody: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(failureRow.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    failureBody = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const failureActor = failureBody.actor as { id?: unknown; sessionId?: unknown } | null;
  if (
    Object.keys(failureBody).sort().join(',') !== 'actor,recoveryKind' ||
    failureBody.recoveryKind !== grant.recoveryKind ||
    !failureActor ||
    failureActor.id !== grant.actor.id ||
    failureActor.sessionId !== grant.actor.sessionId
  )
    return;
  const origin = body.withdrawnBudgetOrigin as
    | {
        version?: unknown;
        sourceCommit?: unknown;
        reportSha256?: unknown;
        failureSha256?: unknown;
        failureStamp?: unknown;
      }
    | undefined;
  if (
    !origin ||
    origin.version !== 1 ||
    typeof origin.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(origin.sourceCommit) ||
    origin.sourceCommit !== sourceHead ||
    typeof origin.reportSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(origin.reportSha256) ||
    typeof origin.failureSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(origin.failureSha256) ||
    origin.failureSha256 !== createHash('sha256').update(attempt.result).digest('hex') ||
    typeof origin.failureStamp !== 'string' ||
    !STAMP_NAME.test(origin.failureStamp)
  )
    return;
  const sourceCommit = origin.sourceCommit;

  const report = readMeasurement(attempt).result;
  if (
    !workerCheckHostBudgetRefusalReport(report) ||
    createHash('sha256').update(report).digest('hex') !== origin.reportSha256 ||
    !(report.match(/[0-9a-f]{10,40}/gi) ?? []).some((reference) => sourceCommit.startsWith(reference.toLowerCase()))
  )
    return;

  const selection = workerCheckHostStaleTypingFailureSelection({
    directory,
    worktree: task.worktree,
    result: attempt.result,
    stamp: origin.failureStamp,
  });
  if (
    !selection ||
    JSON.stringify(selection.command) !== JSON.stringify(grant.command) ||
    !workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt(
      task.worktree,
      task.id,
      attempt.attempt,
      selection.physicalRunId,
      selection.command,
      selection.exitCode,
    )
  )
    return;
  return report;
}

/** A withdrawn Web retry requires each listed result to agree with the terminal custody that settles it. */
function withdrawnRetryChecksHaveBoundTerminalResults(
  worktree: string,
  taskId: string,
  attempt: number,
  checkIds: readonly string[],
  currentCheck?: { id: string; physicalRunId: string },
): boolean {
  const root = join(worktree, '.temp', 'goal', 'checks');
  const resultDirectory = join(root, 'results');
  let files: string[];
  try {
    files = readdirSync(resultDirectory).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return checkIds.length === 0;
    throw error;
  }

  const found = new Set<string>();
  for (const file of files) {
    const record = readCheckEvidence(join(resultDirectory, file));
    if (!record) return false;
    if (record.ownership?.taskId !== taskId || record.ownership.attempt !== attempt) continue;
    if (typeof record.id !== 'string' || typeof record.physicalRunId !== 'string') return false;
    found.add(record.id);
    if (
      file !== `${record.id}.json` ||
      record.cwd !== worktree ||
      existsSync(join(root, 'cancellations', `${record.id}.json`))
    )
      return false;
    if (
      record.status === 'running' &&
      currentCheck?.id === record.id &&
      currentCheck.physicalRunId === record.physicalRunId
    )
      continue;
    if (
      record.status !== 'finished' ||
      typeof record.exitCode !== 'number' ||
      !Number.isInteger(record.exitCode) ||
      (!terminalPhysicalHistory(worktree, record.id, record.physicalRunId, record.exitCode) &&
        !retainedNativeExitReceiptTerminal(worktree, taskId, attempt, record))
    )
      return false;
  }
  return checkIds.every((id) => found.has(id));
}

/**
 * A completed, clean Web source attempt whose environment retry was withdrawn by an explicit post-exit stop.
 * Every recorded check must be physically terminal; the optional current check is only accepted as an idempotent
 * replay of the exact already-authorized recovery check.
 */
export function workerCheckHostWithdrawnRetryIsRecoverable(input: {
  task: Task;
  attempt: Attempt;
  retry?: RetryIntent;
  progress?: { endHead?: unknown; uncommitted?: unknown };
  currentCheck?: { id: string; physicalRunId: string };
}): boolean {
  const { task, attempt, retry, progress } = input;
  const stop = attempt.terminationIntent;
  if (
    task.state !== 'stopped' ||
    task.currentAttempt !== attempt.attempt ||
    task.brief.goal !== 'web' ||
    task.brief.kind !== 'interface' ||
    workerCheckHostBudgetLimit(task, attempt.attempt) === 'off' ||
    !isKnownTypingCompiler(task.worktree, ['bun', 'run', '--cwd', 'apps/web', 'typecheck']) ||
    (attempt.state !== 'stopped' &&
      !(
        attempt.state === 'exited' &&
        JSON.stringify(attempt.typingEvidencePending?.command) ===
          JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck'])
      )) ||
    attempt.exitCode !== 0 ||
    attempt.failureKind !== 'tool' ||
    !workerCheckHostBudgetRefusalReport(attempt.result) ||
    retry?.status !== 'abandoned' ||
    retry.taskId !== task.id ||
    retry.attempt !== attempt.attempt ||
    retry.abandonedBy !== 'stop' ||
    retry.nextAttempt !== undefined ||
    retry.options.escalation !== 'environment' ||
    !stop ||
    stop.operation !== 'stop' ||
    stop.state !== 'complete' ||
    stop.processIdentity !== 'known' ||
    !stop.settledAt ||
    !attempt.endedAt ||
    Date.parse(stop.requestedAt) <= Date.parse(attempt.endedAt) ||
    Date.parse(stop.settledAt) < Date.parse(stop.requestedAt) ||
    !stop.process ||
    !attempt.process ||
    JSON.stringify(stop.process) !== JSON.stringify(attempt.process) ||
    JSON.stringify(stop.auxiliaryProcesses) !== JSON.stringify(attempt.auxiliaryProcesses ?? [])
  )
    return false;

  const ended = Date.parse(attempt.endedAt);
  const requested = Date.parse(stop.requestedAt);
  const settled = Date.parse(stop.settledAt);
  if (![ended, requested, settled].every(Number.isFinite) || requested <= ended || settled < requested) return false;
  if (identityLive(stop.process)) return false;
  if (attempt.driver && identityLive(attempt.driver)) return false;
  for (const process of [...(attempt.auxiliaryProcesses ?? []), ...stop.auxiliaryProcesses])
    if (identityLive(process)) return false;

  if (progress?.uncommitted !== false || typeof progress.endHead !== 'string') return false;
  try {
    if (git(task.worktree, ['rev-parse', 'HEAD']).trim() !== progress.endHead) return false;
    if (git(task.worktree, ['status', '--porcelain', '--untracked-files=all']).trim() !== '') return false;
  } catch {
    return false;
  }
  return withdrawnRetryChecksHaveBoundTerminalResults(
    task.worktree,
    task.id,
    attempt.attempt,
    attempt.checks ?? [],
    input.currentCheck,
  );
}

/** No competing check is inferred from a missing, unreadable or non-terminal owned result. */
export function workerCheckHostAttemptChecksTerminal(
  worktree: string,
  taskId: string,
  attempt: number,
  checkIds: readonly string[],
  currentCheck?: { id: string; physicalRunId: string },
  allowRetainedNativeExitReceipt = false,
): boolean {
  const root = join(worktree, '.temp', 'goal', 'checks');
  const recordDirectory = join(root, 'results');
  let files: string[];
  try {
    files = readdirSync(recordDirectory).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return checkIds.length === 0;
    throw error;
  }
  const found = new Set<string>();
  for (const file of files) {
    const record = readCheckEvidence(join(recordDirectory, file));
    if (!record) return false;
    if (record.ownership?.taskId !== taskId || record.ownership.attempt !== attempt) continue;
    if (typeof record.id !== 'string' || typeof record.physicalRunId !== 'string') return false;
    found.add(record.id);
    const expectedCurrent = currentCheck?.id === record.id && currentCheck.physicalRunId === record.physicalRunId;
    if (
      record.cwd !== worktree ||
      file !== `${record.id}.json` ||
      existsSync(join(root, 'cancellations', `${record.id}.json`))
    )
      return false;
    if (expectedCurrent && record.status === 'running') continue;
    const currentTerminal =
      record.status === 'finished' && terminalPhysicalHistory(worktree, record.id, record.physicalRunId);
    if (
      !currentTerminal &&
      !(allowRetainedNativeExitReceipt && retainedNativeExitReceiptTerminal(worktree, taskId, attempt, record))
    )
      return false;
  }
  return checkIds.every((id) => found.has(id));
}

/** Match a withdrawn-Web failure by its retained physical run when legacy custody omitted it from attempt.checks. */
export function workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt(
  worktree: string,
  taskId: string,
  attempt: number,
  physicalRunId: string,
  command: readonly string[],
  exitCode: number,
): boolean {
  if (!isPhysicalRunId(physicalRunId) || !Number.isInteger(exitCode)) return false;
  const results = join(worktree, '.temp', 'goal', 'checks', 'results');
  let files: string[];
  try {
    files = readdirSync(results).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let matched = false;
  for (const file of files) {
    const record = readCheckEvidence(join(results, file));
    if (!record) return false;
    if (record.physicalRunId !== physicalRunId) continue;
    if (matched || record.ownership?.taskId !== taskId || record.ownership.attempt !== attempt) return false;
    matched = true;
    if (
      typeof record.id !== 'string' ||
      !isCheckId(record.id) ||
      file !== `${record.id}.json` ||
      record.cwd !== worktree ||
      JSON.stringify(record.argv) !== JSON.stringify(command) ||
      record.status !== 'finished' ||
      record.exitCode !== exitCode ||
      !retainedNativeExitReceiptTerminal(worktree, taskId, attempt, record)
    )
      return false;
  }
  return matched;
}

function terminalCancelledPhysicalCheck(
  worktree: string,
  taskId: string,
  attempt: number,
  resultPath: string,
  record: CheckEvidence,
): boolean {
  if (
    record.status !== 'running' ||
    typeof record.id !== 'string' ||
    typeof record.physicalRunId !== 'string' ||
    record.ownership?.taskId !== taskId ||
    record.ownership.attempt !== attempt
  )
    return false;

  const cancellation = readCheckEvidence(
    join(worktree, '.temp', 'goal', 'checks', 'custody', 'cancelled', `${record.id}.json`),
  );
  const history = readCheckEvidence(
    join(worktree, '.temp', 'goal', 'checks', 'custody', 'history', `${record.id}.${record.physicalRunId}.json`),
  );
  if (!cancellation || !history) return false;
  if (
    typeof cancellation.receiptReference !== 'string' ||
    !isAbsolute(cancellation.receiptReference) ||
    resolve(cancellation.receiptReference) !== cancellation.receiptReference ||
    cancellation.receiptReference.length > 2048 ||
    /[\0\r\n]/.test(cancellation.receiptReference) ||
    typeof cancellation.receiptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cancellation.receiptSha256)
  )
    return false;
  const receiptLocation = cancellation.receiptReference;
  const receiptRelative = relative(worktree, receiptLocation);
  if (
    receiptRelative === '' ||
    (receiptRelative !== '..' && !receiptRelative.startsWith(`..${sep}`) && !isAbsolute(receiptRelative))
  )
    return false;

  let receiptBytes: Buffer;
  let result: Buffer;
  try {
    const receiptStats = lstatSync(receiptLocation);
    const resultStats = lstatSync(resultPath);
    if (
      receiptStats.isSymbolicLink() ||
      !receiptStats.isFile() ||
      receiptStats.size > 256 * 1024 ||
      resultStats.isSymbolicLink() ||
      !resultStats.isFile()
    )
      return false;
    receiptBytes = readFileSync(receiptLocation);
    result = readFileSync(resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (receiptBytes.length > 256 * 1024) return false;
  if (createHash('sha256').update(receiptBytes).digest('hex') !== cancellation.receiptSha256) return false;
  let authorizedRecords: unknown;
  try {
    authorizedRecords = (JSON.parse(receiptBytes.toString('utf8')) as { records?: unknown }).records;
  } catch {
    return false;
  }
  if (
    !Array.isArray(authorizedRecords) ||
    !authorizedRecords.some(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).id === record.id &&
        ((item as Record<string, unknown>).task ?? (item as Record<string, unknown>).taskId) === taskId &&
        ((item as Record<string, unknown>).attempt === undefined ||
          (item as Record<string, unknown>).attempt === attempt) &&
        JSON.stringify((item as Record<string, unknown>).argv) === JSON.stringify(record.argv),
    )
  )
    return false;
  const proof = history.terminalProof;
  const physicalResultKnown =
    (history.status === 'finished' && Number.isInteger(history.exitCode) && proof?.resultKnown === true) ||
    (history.status === 'unknown' && history.exitCode === undefined && proof?.resultKnown === false);
  return Boolean(
    cancellation.version === 1 &&
    cancellation.checkId === record.id &&
    cancellation.physicalRunId === record.physicalRunId &&
    cancellation.ownership?.taskId === taskId &&
    cancellation.ownership.attempt === attempt &&
    cancellation.disposition === 'logically-cancelled-physical-cleanup-unknown' &&
    cancellation.recordSha256 === createHash('sha256').update(result).digest('hex') &&
    history.version === 1 &&
    history.id === record.id &&
    history.cwd === worktree &&
    history.physicalRunId === record.physicalRunId &&
    JSON.stringify(history.argv) === JSON.stringify(record.argv) &&
    history.ownership?.taskId === taskId &&
    history.ownership.attempt === attempt &&
    typeof history.remoteExpected === 'boolean' &&
    proof?.local === true &&
    proof.remote === (history.remoteExpected ? true : null) &&
    physicalResultKnown,
  );
}

function verifiedRemotePhysicalCleanup(value: unknown, host: string, run: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cleanup = value as Record<string, unknown>;
  return (
    cleanup.schema === 1 &&
    cleanup.host === host &&
    cleanup.run === run &&
    cleanup.status === 'verified' &&
    cleanup.supervisorStopped === true &&
    cleanup.commandGroupTerminal === true &&
    cleanup.containersRemoved === true &&
    cleanup.runDirectoryRemoved === true &&
    Array.isArray(cleanup.failures) &&
    cleanup.failures.length === 0
  );
}

/** Resultless execution cancellation is terminal only with the exact remote cleanup recorded by Dev. */
function terminalCleanedCancelledPhysicalCheck(
  worktree: string,
  taskId: string,
  attempt: number,
  resultPath: string,
  record: CheckEvidence,
): boolean {
  if (
    record.status !== 'running' ||
    typeof record.id !== 'string' ||
    !isCheckId(record.id) ||
    typeof record.physicalRunId !== 'string' ||
    !isPhysicalRunId(record.physicalRunId) ||
    record.cwd !== worktree ||
    record.ownership?.taskId !== taskId ||
    record.ownership.attempt !== attempt ||
    record.exitCode !== undefined ||
    record.physicalRun !== undefined ||
    record.physicalRunReference !== undefined ||
    !checkEvidenceArgv(record.argv)
  )
    return false;

  if (!terminalCancelledPhysicalCheck(worktree, taskId, attempt, resultPath, record)) return false;
  const historySource = readOptionalCheckEvidence(physicalHistoryPath(worktree, record.id, record.physicalRunId));
  const cleanupSource = readOptionalCheckEvidence(cleanupReceiptPath(worktree, record.id, record.physicalRunId));
  const custodySource = readOptionalCheckEvidence(remoteRunCustodyPath(worktree, record.physicalRunId));
  const history = historySource.state === 'present' ? historySource.value : undefined;
  const cleanupReceipt = cleanupSource.state === 'present' ? cleanupSource.value : undefined;
  const custody = custodySource.state === 'present' ? custodySource.value : undefined;
  const physicalRunner = history ? ownedRunnerIdentity(history.runnerIdentity) : undefined;
  const resultRunner = ownedRunnerIdentity(record.runnerIdentity);
  if (
    !history ||
    !cleanupReceipt ||
    !custody ||
    !resultRunner ||
    !physicalRunner ||
    record.runnerPid !== resultRunner.pid ||
    typeof record.runnerHost !== 'string' ||
    record.runnerHost.length === 0 ||
    history.version !== 1 ||
    history.id !== record.id ||
    history.cwd !== worktree ||
    history.physicalRunId !== record.physicalRunId ||
    history.status !== 'unknown' ||
    history.exitCode !== undefined ||
    history.ownership?.taskId !== taskId ||
    history.ownership.attempt !== attempt ||
    history.runnerHost !== record.runnerHost ||
    !isDeepStrictEqual(physicalRunner, resultRunner) ||
    history.remoteExpected !== true ||
    !history.terminalProof ||
    history.terminalProof.local !== true ||
    history.terminalProof.remote !== true ||
    history.terminalProof.resultKnown !== false ||
    !checkEvidenceArgv(history.argv) ||
    !isDeepStrictEqual(history.argv, record.argv) ||
    !checkEvidenceArgv(history.remoteArgv)
  )
    return false;

  const receiptRunner = ownedRunnerIdentity(cleanupReceipt.runnerIdentity);
  const remoteRun = cleanupReceipt.remoteRun;
  if (
    cleanupReceipt.version !== 1 ||
    typeof cleanupReceipt.receiptId !== 'string' ||
    !isCheckId(cleanupReceipt.receiptId) ||
    cleanupReceipt.checkId !== record.id ||
    cleanupReceipt.physicalRunId !== record.physicalRunId ||
    cleanupReceipt.ownership?.taskId !== taskId ||
    cleanupReceipt.ownership.attempt !== attempt ||
    cleanupReceipt.runnerHost !== record.runnerHost ||
    !receiptRunner ||
    !isDeepStrictEqual(receiptRunner, resultRunner) ||
    cleanupReceipt.disposition !== 'uncertain' ||
    cleanupReceipt.localTerminal !== true ||
    cleanupReceipt.remoteTerminal !== true ||
    cleanupReceipt.resultTerminal !== false ||
    !remoteRun ||
    typeof remoteRun.host !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(remoteRun.host) ||
    typeof remoteRun.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,96}$/.test(remoteRun.id) ||
    !verifiedRemotePhysicalCleanup(cleanupReceipt.physicalCleanup, remoteRun.host, remoteRun.id)
  )
    return false;

  const binding = custody.binding;
  const attempts = custody.attempts;
  if (
    custody.version !== 1 ||
    custody.physicalRunId !== record.physicalRunId ||
    custody.status !== 'terminal' ||
    !binding ||
    binding.checkId !== record.id ||
    binding.ownership?.taskId !== taskId ||
    binding.ownership.attempt !== attempt ||
    !checkEvidenceArgv(binding.argv) ||
    !isDeepStrictEqual(binding.argv, record.argv) ||
    !checkEvidenceArgv(binding.remoteArgv) ||
    !isDeepStrictEqual(binding.remoteArgv, history.remoteArgv) ||
    !Array.isArray(attempts)
  )
    return false;

  const managedAttempts = attempts.filter(
    (item): item is CheckEvidence => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
  if (managedAttempts.length !== attempts.length) return false;
  const completed = managedAttempts.filter((item) => item.status === 'terminal');
  if (completed.length !== 1) return false;
  const remoteAttempt = completed[0]!;
  const physicalCleanup = cleanupReceipt.physicalCleanup;
  return Boolean(
    remoteAttempt.host === remoteRun.host &&
    remoteAttempt.id === remoteRun.id &&
    remoteAttempt.physicalCleanup !== undefined &&
    remoteAttempt.native === undefined &&
    remoteAttempt.settlement === undefined &&
    verifiedRemotePhysicalCleanup(remoteAttempt.physicalCleanup, remoteRun.host, remoteRun.id) &&
    isDeepStrictEqual(remoteAttempt.physicalCleanup, physicalCleanup) &&
    managedAttempts.every(
      (item) =>
        item === remoteAttempt ||
        (item.status === 'not-started' &&
          item.physicalCleanup === undefined &&
          item.native === undefined &&
          item.settlement === undefined),
    ),
  );
}

type ExecutionCancellationEvidence =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'present'; signal: 1 | 2 | 15 };

function readExecutionCancellation(worktree: string, checkId: string): ExecutionCancellationEvidence {
  const path = join(worktree, '.temp', 'goal', 'checks', 'cancellations', `${checkId}.json`);
  const source = readOptionalCheckEvidence(path);
  if (source.state !== 'present') return { state: source.state };
  const value = source.value;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'id' ||
    keys[1] !== 'schema' ||
    keys[2] !== 'signal' ||
    value.schema !== 1 ||
    value.id !== checkId ||
    ![1, 2, 15].includes(value.signal as number)
  )
    return { state: 'invalid' };
  return { state: 'present', signal: value.signal as 1 | 2 | 15 };
}

/** Terminal custody for compiler recovery accepts a retained cancellation only with its exact physical proof. */
export function workerCheckHostAttemptCheckCustody(
  worktree: string,
  taskId: string,
  attempt: number,
  checkIds: readonly string[],
  /** When set, inspect only these result IDs and their corresponding custody records. */
  exactIdsOnly = false,
): 'terminal' | 'unknown' {
  const root = join(worktree, '.temp', 'goal', 'checks');
  const recordDirectory = join(root, 'results');
  if (exactIdsOnly && (!checkIds.length || checkIds.some((id) => !isCheckId(id)))) return 'unknown';
  let files: string[];
  if (exactIdsOnly) {
    files = [...new Set(checkIds)].map((id) => `${id}.json`);
  } else {
    try {
      files = readdirSync(recordDirectory).filter((file) => file.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return checkIds.length === 0 ? 'terminal' : 'unknown';
      throw error;
    }
  }
  const found = new Set<string>();
  for (const file of files) {
    const resultPath = join(recordDirectory, file);
    if (exactIdsOnly) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(resultPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unknown';
        throw error;
      }
      if (!stat.isFile() || stat.size > CHECK_RESULT_MAX_BYTES) return 'unknown';
    }
    const record = readCheckEvidence(resultPath);
    if (!record) return 'unknown';
    if (record.ownership?.taskId !== taskId || record.ownership.attempt !== attempt) {
      if (exactIdsOnly) return 'unknown';
      continue;
    }
    if (typeof record.id !== 'string' || typeof record.physicalRunId !== 'string') return 'unknown';
    found.add(record.id);
    const cancelled = existsSync(join(root, 'custody', 'cancelled', `${record.id}.json`));
    const executionCancellation = readExecutionCancellation(worktree, record.id);
    if (
      record.cwd !== worktree ||
      file !== `${record.id}.json` ||
      executionCancellation.state === 'invalid' ||
      (executionCancellation.state === 'present'
        ? executionCancellation.signal !== 15 ||
          !terminalCleanedCancelledPhysicalCheck(worktree, taskId, attempt, resultPath, record)
        : cancelled
          ? !terminalCancelledPhysicalCheck(worktree, taskId, attempt, resultPath, record)
          : record.status !== 'finished' || !terminalPhysicalHistory(worktree, record.id, record.physicalRunId))
    )
      return 'unknown';
  }
  return checkIds.every((id) => found.has(id)) ? 'terminal' : 'unknown';
}

/** Whether an exact compiler check needs authenticated recovery after verified resultless remote cleanup. */
export function workerCheckHostAttemptHasResultlessCleanup(
  worktree: string,
  taskId: string,
  attempt: number,
  checkIds: readonly string[],
  command: readonly string[],
): boolean {
  const resultDirectory = join(worktree, '.temp', 'goal', 'checks', 'results');
  return checkIds.some((checkId) => {
    if (!isCheckId(checkId)) return false;
    const record = readCheckEvidence(join(resultDirectory, `${checkId}.json`));
    if (
      !record ||
      record.id !== checkId ||
      record.ownership?.taskId !== taskId ||
      record.ownership.attempt !== attempt ||
      JSON.stringify(record.argv) !== JSON.stringify(command)
    )
      return false;
    const cancellation = readExecutionCancellation(worktree, checkId);
    return (
      cancellation.state === 'present' &&
      cancellation.signal === 15 &&
      terminalCleanedCancelledPhysicalCheck(worktree, taskId, attempt, join(resultDirectory, `${checkId}.json`), record)
    );
  });
}

/** A retained Kernel receipt can be earlier than the last stamp when later recovery checks were abandoned. */
export function workerCheckHostHasRetainedKernelTypingRun(directory: string, worktree: string): boolean {
  try {
    return stampNames(directory).some((name) => {
      const stamp = readWorkerCheckHostStamp(directory, name);
      return [stamp.typingRequest?.command, stamp.typingInputs?.compilerCommand].some(
        (command) => command !== undefined && isRetainedKernelTypingCompiler(worktree, command),
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Recovery stamps keep exact check identities even when their separate result records were never returned. */
export function workerCheckHostTypingCheckIds(directory: string, checkIds: readonly string[]): string[] {
  const ids = new Set(checkIds);
  try {
    for (const name of stampNames(directory)) {
      const recovery = readWorkerCheckHostStamp(directory, name).typingRecovery;
      if (recovery) ids.add(recovery.checkId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...ids];
}

export type WorkerCheckHostConsumedTypingRecovery = {
  checkId: string;
  physicalRunId: string;
  exact: boolean;
  custody: 'terminal' | 'unknown';
  resultState: 'absent' | 'running' | 'finished' | 'invalid';
  resultlessCleanup: boolean;
  replacement: boolean;
};

export type WorkerCheckHostActiveTypingRecovery = {
  token: string;
  checkId: string;
  physicalRunId: string;
  runnerHost: string;
  runnerIdentity: RunnerIdentity;
};

function isRunnerIdentity(value: unknown): value is RunnerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<RunnerIdentity>;
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid! > 0 &&
    typeof identity.start === 'string' &&
    /^\d+$/.test(identity.start) &&
    typeof identity.boot === 'string' &&
    identity.boot.length > 0 &&
    Number.isSafeInteger(identity.group) &&
    identity.group! > 0
  );
}

function sameRunnerIdentity(left: RunnerIdentity, right: RunnerIdentity): boolean {
  return left.pid === right.pid && left.start === right.start && left.boot === right.boot && left.group === right.group;
}

function authorizedTypingRecoveryEvent(db: Database, grant: TypingRecoveryGrant): boolean {
  const row = db
    .query(
      `SELECT body FROM worker_events WHERE task_id=? AND attempt=? AND kind='typing-recovery-authorized'
       AND CASE WHEN json_valid(body) THEN json_extract(body, '$.token')=? ELSE 0 END LIMIT 1`,
    )
    .get(grant.taskId, grant.attempt, grant.token) as { body: string } | null;
  if (!row) return false;
  let body: CheckEvidence;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    body = parsed as CheckEvidence;
  } catch {
    return false;
  }
  const actor = body.actor as { id?: unknown; sessionId?: unknown } | null | undefined;
  return (
    body.token === grant.token &&
    body.identity === grant.identity &&
    body.checkId === grant.checkId &&
    JSON.stringify(body.command) === JSON.stringify(grant.command) &&
    (body.recoveryKind === undefined ? grant.recoveryKind === undefined : body.recoveryKind === grant.recoveryKind) &&
    actor?.id === grant.actor.id &&
    actor?.sessionId === grant.actor.sessionId
  );
}

/**
 * Return only the runner of a current stopped-task typing recovery whose authenticated grant was consumed into an
 * exact check-host stamp and whose registered logical and physical run are still live on this host.
 */
export function workerCheckHostActiveTypingRecovery(input: {
  db: Database;
  stateDirectory: string;
  taskId: string;
  worktree: string;
  /** When supplied, inspect only the current authenticated grant's stamp. */
  token?: string;
}): WorkerCheckHostActiveTypingRecovery | undefined {
  const taskRow = input.db.query('SELECT current_attempt, body FROM worker_tasks WHERE id=?').get(input.taskId) as {
    current_attempt: number;
    body: string;
  } | null;
  if (!taskRow || !Number.isSafeInteger(taskRow.current_attempt) || taskRow.current_attempt < 1) return;
  let task: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(taskRow.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    task = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    task.id !== input.taskId ||
    task.currentAttempt !== taskRow.current_attempt ||
    task.state !== 'stopped' ||
    task.worktree !== input.worktree ||
    task.workspace
  )
    return;

  const attemptRow = input.db
    .query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?')
    .get(input.taskId, taskRow.current_attempt) as { body: string } | null;
  if (!attemptRow) return;
  let attempt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(attemptRow.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    attempt = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    attempt.taskId !== input.taskId ||
    attempt.attempt !== taskRow.current_attempt ||
    (attempt.state !== 'exited' && attempt.state !== 'stopped')
  )
    return;

  const directory = workerCheckBudgetDirectory(input.stateDirectory, input.taskId, taskRow.current_attempt);
  let names: string[];
  if (input.token !== undefined) {
    if (!/^[0-9a-f-]{36}$/.test(input.token)) return;
    const grant = readCheckEvidence(recoveryPath(directory, input.token)) as
      | (CheckEvidence & TypingRecoveryGrant)
      | undefined;
    if (!grant?.stamp || !STAMP_NAME.test(grant.stamp)) return;
    names = [grant.stamp];
  } else {
    try {
      names = stampNames(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const root = join(input.worktree, '.temp', 'goal', 'checks');
  for (const name of names.reverse()) {
    const stampSource = readOptionalCheckEvidence(join(directory, name));
    if (stampSource.state !== 'present') continue;
    const stamp = stampSource.value as WorkerCheckHostStampRecord;
    const recovery = stamp.typingRecovery;
    if (
      !recovery ||
      typeof stamp.content !== 'string' ||
      !/^[0-9a-f]{40}$/.test(stamp.content) ||
      !/^[0-9a-f-]{36}$/.test(recovery.token) ||
      (input.token !== undefined && recovery.token !== input.token) ||
      !isCheckId(recovery.checkId) ||
      !isPhysicalRunId(recovery.physicalRunId)
    )
      continue;
    const grantSource = readOptionalCheckEvidence(recoveryPath(directory, recovery.token));
    const grant =
      grantSource.state === 'present' ? (grantSource.value as CheckEvidence & TypingRecoveryGrant) : undefined;
    if (
      !grant ||
      grant.version !== 1 ||
      grant.token !== recovery.token ||
      grant.taskId !== input.taskId ||
      grant.attempt !== taskRow.current_attempt ||
      grant.worktree !== input.worktree ||
      grant.stateDirectory !== input.stateDirectory ||
      grant.database !== input.db.filename ||
      grant.stamp !== name ||
      grant.checkId !== recovery.checkId ||
      grant.physicalRunId !== recovery.physicalRunId ||
      !/^[0-9a-f]{64}$/.test(grant.identity) ||
      (grant.recoveryKind !== undefined && grant.recoveryKind !== 'withdrawn-budget-stop') ||
      !Array.isArray(grant.command) ||
      grant.command.some((part) => typeof part !== 'string') ||
      !isKnownTypingCompiler(input.worktree, grant.command) ||
      !grant.actor ||
      typeof grant.actor.id !== 'string' ||
      grant.actor.id.length === 0 ||
      typeof grant.actor.sessionId !== 'string' ||
      grant.actor.sessionId.length === 0 ||
      !authorizedTypingRecoveryEvent(input.db, grant)
    )
      continue;

    if (
      existsSync(join(root, 'cancellations', `${grant.checkId}.json`)) ||
      existsSync(join(root, 'custody', 'cancelled', `${grant.checkId}.json`)) ||
      existsSync(join(root, 'custody', 'stopping', `${grant.checkId}.${grant.physicalRunId}.json`))
    )
      continue;

    const resultSource = readOptionalCheckEvidence(join(root, 'results', `${grant.checkId}.json`));
    const physicalSource = readOptionalCheckEvidence(
      physicalHistoryPath(input.worktree, grant.checkId, grant.physicalRunId),
    );
    const result = resultSource.state === 'present' ? resultSource.value : undefined;
    const physical = physicalSource.state === 'present' ? physicalSource.value : undefined;
    const resultRunner = result && isRunnerIdentity(result.runnerIdentity) ? result.runnerIdentity : undefined;
    const physicalRunner = physical && isRunnerIdentity(physical.runnerIdentity) ? physical.runnerIdentity : undefined;
    if (
      !result ||
      result.id !== grant.checkId ||
      result.cwd !== input.worktree ||
      result.status !== 'running' ||
      result.exitCode !== undefined ||
      result.physicalRunId !== grant.physicalRunId ||
      result.ownership?.taskId !== input.taskId ||
      result.ownership.attempt !== taskRow.current_attempt ||
      JSON.stringify(result.argv) !== JSON.stringify(grant.command) ||
      typeof result.runnerHost !== 'string' ||
      result.runnerHost !== hostname() ||
      !resultRunner ||
      result.runnerPid !== resultRunner.pid ||
      !physical ||
      physical.version !== 1 ||
      physical.id !== grant.checkId ||
      physical.cwd !== input.worktree ||
      physical.status !== 'running' ||
      physical.exitCode !== undefined ||
      physical.terminalProof !== undefined ||
      physical.physicalRunId !== grant.physicalRunId ||
      physical.ownership?.taskId !== input.taskId ||
      physical.ownership.attempt !== taskRow.current_attempt ||
      JSON.stringify(physical.argv) !== JSON.stringify(grant.command) ||
      physical.runnerHost !== result.runnerHost ||
      !physicalRunner ||
      !sameRunnerIdentity(physicalRunner, resultRunner) ||
      !identityLive(resultRunner)
    )
      continue;

    return {
      token: grant.token,
      checkId: grant.checkId,
      physicalRunId: grant.physicalRunId,
      runnerHost: result.runnerHost,
      runnerIdentity: resultRunner,
    };
  }
}

/** Read only the current-input recovery whose grant is bound to a consumed budget stamp. */
export function workerCheckHostConsumedTypingRecovery(input: {
  db?: Database;
  directory: string;
  worktree: string;
  taskId: string;
  attempt: number;
  checkIds: readonly string[];
  command: readonly string[];
  /** When supplied, inspect only the stamp and grant named by the current authenticated event. */
  token?: string;
}): WorkerCheckHostConsumedTypingRecovery | undefined {
  if (!isKnownTypingCompiler(input.worktree, input.command)) return;
  const identity = recoveryIdentity(input.worktree, input.command);
  let names: string[];
  if (input.token !== undefined) {
    if (!/^[0-9a-f-]{36}$/.test(input.token)) return;
    const grant = readCheckEvidence(recoveryPath(input.directory, input.token)) as
      | (CheckEvidence & TypingRecoveryGrant)
      | undefined;
    if (!grant?.stamp || !STAMP_NAME.test(grant.stamp)) return;
    names = [grant.stamp];
  } else {
    try {
      names = stampNames(input.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    names.reverse();
  }

  for (const name of names) {
    const stamp = readWorkerCheckHostStamp(input.directory, name);
    const recovery = stamp.typingRecovery;
    if (
      !recovery ||
      !/^[0-9a-f-]{36}$/.test(recovery.token) ||
      (input.token !== undefined && recovery.token !== input.token) ||
      !isCheckId(recovery.checkId) ||
      !isPhysicalRunId(recovery.physicalRunId)
    )
      continue;
    const grant = readCheckEvidence(recoveryPath(input.directory, recovery.token)) as
      | (CheckEvidence & TypingRecoveryGrant)
      | undefined;
    if (
      !grant ||
      grant.version !== 1 ||
      grant.token !== recovery.token ||
      grant.taskId !== input.taskId ||
      grant.attempt !== input.attempt ||
      grant.worktree !== input.worktree ||
      grant.identity !== identity ||
      JSON.stringify(grant.command) !== JSON.stringify(input.command) ||
      (input.db !== undefined && !authorizedTypingRecoveryEvent(input.db, grant))
    )
      continue;

    const request = stamp.typingRequest;
    const exactStamp =
      grant.checkId === recovery.checkId &&
      grant.physicalRunId === recovery.physicalRunId &&
      (grant.stamp === undefined || grant.stamp === name);
    const exactRequest =
      !request ||
      (request.physicalRunId === grant.physicalRunId &&
        JSON.stringify(request.command) === JSON.stringify(grant.command));
    const exactRecovery = exactStamp && exactRequest;
    const checkIds =
      input.token === undefined ? [...new Set([...input.checkIds, grant.checkId])] : [grant.checkId];
    return {
      checkId: grant.checkId,
      physicalRunId: grant.physicalRunId,
      exact: exactRecovery,
      custody: exactRecovery
        ? workerCheckHostAttemptCheckCustody(
            input.worktree,
            input.taskId,
            input.attempt,
            checkIds,
            input.token !== undefined,
          )
        : 'unknown',
      resultState: consumedTypingRecoveryResultState(input.worktree, grant.checkId),
      resultlessCleanup:
        exactRecovery &&
        workerCheckHostAttemptHasResultlessCleanup(
          input.worktree,
          input.taskId,
          input.attempt,
          [grant.checkId],
          grant.command,
        ),
      replacement: grant.replacementOf !== undefined,
    };
  }
  return undefined;
}

function consumedTypingRecoveryResultState(
  worktree: string,
  checkId: string,
): WorkerCheckHostConsumedTypingRecovery['resultState'] {
  const path = join(worktree, '.temp', 'goal', 'checks', 'results', `${checkId}.json`);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    if (['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return 'invalid';
    throw error;
  }
  if (!stat.isFile() || stat.size > CHECK_RESULT_MAX_BYTES) return 'invalid';
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value as CheckEvidence).id !== checkId)
      return 'invalid';
    const result = value as CheckEvidence;
    if (result.status === 'running' && result.exitCode === undefined) return 'running';
    if (result.status === 'finished') return 'finished';
    return 'invalid';
  } catch (error) {
    if (error instanceof SyntaxError) return 'invalid';
    throw error;
  }
}

export function workerCheckHostTypingReceiptMatches(directory: string, command: readonly string[]): boolean {
  const source = stampNames(directory)
    .map((name) => readWorkerCheckHostStamp(directory, name))
    .findLast((stamp) => stamp.includedTypecheck || stamp.typingRequest);
  return Boolean(
    source?.typingRequest &&
    JSON.stringify(source.typingRequest.command) === JSON.stringify(command) &&
    source.typingInputs?.exitCode === 0 &&
    source.exitCode === 0 &&
    source.includedTypecheck === true,
  );
}

/** A replacement is safe only when the consumed exact check is terminal and its remote command never began. */
function provenPreCompilerRecoveryCancellation(grant: TypingRecoveryGrant, directory: string): boolean {
  if (!grant.stamp || !STAMP_NAME.test(grant.stamp)) return false;
  if (stampNames(directory).some((stamp) => Number(stamp) > Number(grant.stamp))) return false;
  const stamp = readWorkerCheckHostStamp(directory, grant.stamp);
  const recovery = stamp.typingRecovery;
  if (
    !recovery ||
    recovery.token !== grant.token ||
    recovery.checkId !== grant.checkId ||
    recovery.physicalRunId !== grant.physicalRunId
  )
    return false;

  const root = grant.worktree;
  const recordDirectory = join(root, '.temp', 'goal', 'checks', 'results');
  const record = readCheckEvidence(join(recordDirectory, `${grant.checkId}.json`));
  if (
    !record ||
    record.id !== grant.checkId ||
    record.cwd !== root ||
    JSON.stringify(record.argv) !== JSON.stringify(grant.command) ||
    record.status !== 'finished' ||
    record.physicalRunId !== grant.physicalRunId ||
    record.exitCode !== 143 ||
    record.physicalRun?.exitCode !== 143 ||
    record.physicalRun?.resources?.commandStartedMonoMs !== null ||
    existsSync(join(root, '.temp', 'goal', 'checks', 'cancellations', `${grant.checkId}.json`)) ||
    !terminalPhysicalHistory(root, grant.checkId, grant.physicalRunId, 143)
  )
    return false;

  let files: string[];
  try {
    files = readdirSync(recordDirectory).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let currentFound = false;
  for (const file of files) {
    const candidate = readCheckEvidence(join(recordDirectory, file));
    if (!candidate) return false;
    if (candidate.ownership?.taskId !== grant.taskId || candidate.ownership?.attempt !== grant.attempt) continue;
    if (candidate.id === grant.checkId && candidate.physicalRunId === grant.physicalRunId) {
      currentFound = true;
      continue;
    }
    if (
      candidate.status !== 'finished' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.physicalRunId !== 'string' ||
      !terminalPhysicalHistory(root, candidate.id, candidate.physicalRunId)
    )
      return false;
  }
  return currentFound;
}

/** A resultless SIGTERM grant can be replaced once only after exact cleanup and unchanged retained source. */
function provenResultlessCleanupRecoveryCancellation(grant: TypingRecoveryGrant, directory: string): boolean {
  if (!grant.stamp || !STAMP_NAME.test(grant.stamp)) return false;
  if (stampNames(directory).some((stamp) => Number(stamp) > Number(grant.stamp))) return false;
  const stamp = readWorkerCheckHostStamp(directory, grant.stamp);
  const recovery = stamp.typingRecovery;
  if (
    !recovery ||
    recovery.token !== grant.token ||
    recovery.checkId !== grant.checkId ||
    recovery.physicalRunId !== grant.physicalRunId ||
    typeof stamp.content !== 'string' ||
    workerCheckHostContentTree(grant.worktree) !== stamp.content ||
    !workerCheckHostAttemptHasResultlessCleanup(
      grant.worktree,
      grant.taskId,
      grant.attempt,
      [grant.checkId],
      grant.command,
    )
  )
    return false;
  return (
    workerCheckHostAttemptCheckCustody(grant.worktree, grant.taskId, grant.attempt, [grant.checkId]) === 'terminal'
  );
}

/** Called only after typing-recover authenticates the owner/operations manager under the current task lease. */
export function grantWorkerTypingRecovery(
  input: Omit<
    TypingRecoveryGrant,
    'version' | 'token' | 'identity' | 'checkId' | 'physicalRunId' | 'stamp' | 'replacementOf'
  >,
  options: { requireResultlessCleanupReplacement?: boolean } = {},
): TypingRecoveryGrant {
  const directory = workerCheckBudgetDirectory(input.stateDirectory, input.taskId, input.attempt);
  mkdirSync(directory, { recursive: true });
  const lease = acquireDirectoryLeaseWaiting(join(directory, 'admission.lease'));
  try {
    const identity = recoveryIdentity(input.worktree, input.command);
    const grants = join(directory, 'typing-recovery');
    mkdirSync(grants, { recursive: true });
    const matching: TypingRecoveryGrant[] = [];
    const sameAttempt: TypingRecoveryGrant[] = [];
    for (const file of readdirSync(grants)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const prior = JSON.parse(readFileSync(join(grants, file), 'utf8')) as TypingRecoveryGrant;
      if (prior.version === 1 && prior.taskId === input.taskId && prior.attempt === input.attempt)
        sameAttempt.push(prior);
      if (
        prior.version === 1 &&
        prior.taskId === input.taskId &&
        prior.attempt === input.attempt &&
        prior.worktree === input.worktree &&
        prior.identity === identity &&
        JSON.stringify(prior.command) === JSON.stringify(input.command)
      )
        matching.push(prior);
    }
    const cleanedPredecessor = sameAttempt.find((prior) =>
      workerCheckHostAttemptHasResultlessCleanup(
        prior.worktree,
        input.taskId,
        input.attempt,
        [prior.checkId],
        prior.command,
      ),
    );
    const cleanupReplacementExists =
      cleanedPredecessor !== undefined && sameAttempt.some((prior) => prior.replacementOf === cleanedPredecessor.token);
    if (options.requireResultlessCleanupReplacement && !cleanedPredecessor)
      throw new Error('Verified resultless cleanup has no consumed compiler grant to replace');
    if (
      cleanedPredecessor &&
      (cleanedPredecessor.worktree !== input.worktree ||
        cleanedPredecessor.identity !== identity ||
        JSON.stringify(cleanedPredecessor.command) !== JSON.stringify(input.command) ||
        (!cleanupReplacementExists && !provenResultlessCleanupRecoveryCancellation(cleanedPredecessor, directory)))
    )
      throw new Error('Typing recovery source or compiler command changed after resultless cleanup');
    if (input.recoveryKind === 'withdrawn-budget-stop') {
      if (
        sameAttempt.some(
          (prior) =>
            prior.recoveryKind !== 'withdrawn-budget-stop' ||
            prior.identity !== identity ||
            JSON.stringify(prior.command) !== JSON.stringify(input.command),
        )
      )
        throw new Error('Withdrawn retry recovery already has a different compiler authority for this attempt');
      const withdrawn = sameAttempt;
      if (withdrawn.length > 0) {
        const original = withdrawn.find((prior) => !prior.replacementOf);
        if (!original || withdrawn.some((prior) => prior.replacementOf && prior.replacementOf !== original.token))
          throw new Error('Withdrawn retry recovery has conflicting compiler grant history');
        const replacement = withdrawn.find((prior) => prior.replacementOf === original.token);
        if (replacement) return replacement;
        if (withdrawn.length !== 1 || !provenPreCompilerRecoveryCancellation(original, directory)) return original;
        const grant: TypingRecoveryGrant = {
          ...input,
          version: 1,
          token: randomUUID(),
          identity,
          checkId: randomUUID(),
          physicalRunId: randomUUID(),
          replacementOf: original.token,
        };
        writeAtomicJson(recoveryPath(directory, grant.token), grant);
        return grant;
      }
      const grant: TypingRecoveryGrant = {
        ...input,
        version: 1,
        token: randomUUID(),
        identity,
        checkId: randomUUID(),
        physicalRunId: randomUUID(),
      };
      writeAtomicJson(recoveryPath(directory, grant.token), grant);
      return grant;
    }
    const original = matching.find((prior) => !prior.replacementOf);
    if (matching.length > 0 && !original) return matching[0]!;
    if (original) {
      const replacement = matching.find((prior) => prior.replacementOf === original.token);
      if (replacement) return replacement;
      const mayReplace =
        matching.length === 1 &&
        (provenPreCompilerRecoveryCancellation(original, directory) ||
          (sameAttempt.length === 1 && provenResultlessCleanupRecoveryCancellation(original, directory)));
      if (!mayReplace) return original;
      const grant: TypingRecoveryGrant = {
        ...input,
        version: 1,
        token: randomUUID(),
        identity,
        checkId: randomUUID(),
        physicalRunId: randomUUID(),
        replacementOf: original.token,
      };
      writeAtomicJson(recoveryPath(directory, grant.token), grant);
      return grant;
    }
    const grant: TypingRecoveryGrant = {
      ...input,
      version: 1,
      token: randomUUID(),
      identity,
      checkId: randomUUID(),
      physicalRunId: randomUUID(),
    };
    writeAtomicJson(recoveryPath(directory, grant.token), grant);
    return grant;
  } finally {
    lease.release();
  }
}

function admitTypingRecovery(input: WorkerCheckHostAdmit, directory: string): WorkerCheckHostAdmitResult {
  const grant = JSON.parse(readFileSync(recoveryPath(directory, input.recovery!.token), 'utf8')) as TypingRecoveryGrant;
  const request = input.recovery!;
  if (
    grant.version !== 1 ||
    grant.token !== request.token ||
    grant.taskId !== request.taskId ||
    String(grant.attempt) !== request.attempt ||
    resolve(input.worktree ?? '') !== grant.worktree ||
    directory !== workerCheckBudgetDirectory(grant.stateDirectory, grant.taskId, grant.attempt) ||
    JSON.stringify(input.command) !== JSON.stringify(grant.command)
  )
    throw new Error('Typing recovery authority does not match task, attempt, source or exact compiler command');
  const taskLease = acquireDirectoryLeaseWaiting(join(grant.stateDirectory, 'leases', grant.taskId));
  try {
    const db = new Database(grant.database, { readonly: true, strict: true });
    try {
      const taskRow = db.query('SELECT body FROM worker_tasks WHERE id=?').get(grant.taskId) as { body: string } | null;
      const attemptRow = db
        .query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?')
        .get(grant.taskId, grant.attempt) as { body: string } | null;
      const retryRow = db
        .query('SELECT body FROM worker_retry_intents WHERE task_id=? AND attempt=?')
        .get(grant.taskId, grant.attempt) as { body: string } | null;
      const progressRow = db
        .query(
          "SELECT body FROM worker_events WHERE task_id=? AND attempt=? AND kind='attempt-progress' ORDER BY sequence DESC LIMIT 1",
        )
        .get(grant.taskId, grant.attempt) as { body: string } | null;
      const task = taskRow && (JSON.parse(taskRow.body) as Task | null);
      const attempt = attemptRow && (JSON.parse(attemptRow.body) as Attempt | null);
      const retry = retryRow && (JSON.parse(retryRow.body) as RetryIntent | null);
      let progress: { endHead?: unknown; uncommitted?: unknown } | undefined;
      try {
        progress = progressRow ? (JSON.parse(progressRow.body) as typeof progress) : undefined;
      } catch {
        progress = undefined;
      }
      const retainedReport =
        task && attempt
          ? retainedWithdrawnBudgetOriginReport({
              db,
              grant,
              task,
              attempt,
              ...(progress ? { progress: { endHead: progress.endHead } } : {}),
              directory,
            })
          : undefined;
      const eligibilityAttempt = retainedReport && attempt ? { ...attempt, result: retainedReport } : attempt;
      const withdrawnRetry =
        grant.recoveryKind === 'withdrawn-budget-stop' &&
        task !== null &&
        eligibilityAttempt !== null &&
        JSON.stringify(grant.command) === JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck']) &&
        workerCheckHostWithdrawnRetryIsRecoverable({
          task,
          attempt: eligibilityAttempt,
          ...(retry ? { retry } : {}),
          ...(progress ? { progress } : {}),
          currentCheck: { id: grant.checkId, physicalRunId: grant.physicalRunId },
        });
      const ordinaryPending =
        attempt?.state === 'exited' &&
        (Boolean(attempt.typingEvidencePending) || isTypingEvidenceUnavailableResult(attempt.result));
      if (
        !task ||
        task.currentAttempt !== grant.attempt ||
        task.worktree !== grant.worktree ||
        task.state !== 'stopped' ||
        task.brief.kind === 'verification' ||
        !attempt ||
        (!ordinaryPending && !withdrawnRetry)
      )
        throw new Error('Typing recovery authority is stale or source is no longer pending compiler evidence');
    } finally {
      db.close();
    }
    if (recoveryIdentity(grant.worktree, grant.command) !== grant.identity)
      throw new Error('Typing recovery compiler inputs changed; obtain fresh authenticated authority');
    const lease = acquireDirectoryLeaseWaiting(join(directory, 'admission.lease'));
    try {
      const current = JSON.parse(readFileSync(recoveryPath(directory, grant.token), 'utf8')) as TypingRecoveryGrant;
      const used = workerCheckHostRunsUsed(directory);
      const prior = stampNames(directory).find(
        (stamp) => readWorkerCheckHostStamp(directory, stamp).typingRecovery?.token === grant.token,
      );
      if (current.stamp || prior)
        return {
          ok: true,
          used,
          stamp: current.stamp ?? prior!,
          recovery: { checkId: grant.checkId, physicalRunId: grant.physicalRunId, replayed: true },
        };
      const stamp = nextWorkerCheckHostStamp(directory);
      writeStamp(
        directory,
        stamp,
        {
          content: workerCheckHostContentTree(grant.worktree),
          typingRecovery: { token: grant.token, checkId: grant.checkId, physicalRunId: grant.physicalRunId },
        },
        'wx',
      );
      writeAtomicJson(recoveryPath(directory, grant.token), { ...grant, stamp });
      return {
        ok: true,
        used: used + 1,
        stamp,
        recovery: { checkId: grant.checkId, physicalRunId: grant.physicalRunId, replayed: false },
      };
    } finally {
      lease.release();
    }
  } finally {
    taskLease.release();
  }
}

export type WorkerCheckHostAdmit = {
  directory?: string | undefined;
  limit?: string | number | null | undefined;
  worktree?: string | undefined;
  command?: readonly string[] | undefined;
  recovery?: { token: string; taskId: string | undefined; attempt: string | undefined } | undefined;
};

export type WorkerCheckHostAdmitResult =
  | { ok: true; used: number; stamp: string; recovery?: { checkId: string; physicalRunId: string; replayed: boolean } }
  | { ok: true; used: 0 }
  | { ok: false; used: number; message: string };

function budgetRefused(
  last: WorkerCheckHostStampRecord | undefined,
  used: number,
): Extract<WorkerCheckHostAdmitResult, { ok: false }> {
  return {
    ok: false,
    used,
    message:
      last?.final === true && last.typecheckFailed === true
        ? WORKER_CHECK_HOST_TYPECHECK_REFUSAL
        : WORKER_CHECK_HOST_BUDGET_REFUSAL,
  };
}

function admitsFinalVerification(last: WorkerCheckHostStampRecord | undefined, worktree: string | undefined): boolean {
  if (!last || last.final === true) return false;
  if (typeof last.exitCode !== 'number' || last.exitCode === 0) return false;
  if (!last.content || !worktree) return false;
  return workerCheckHostContentTree(worktree) !== last.content;
}

/**
 * Record one check-host wrapper request for this attempt. Missing controller state does not invent a budget.
 * A third request is the final verification run when the last counted run failed and the worktree changed; any
 * further request, or a third request on unchanged content, is refused before the caller reserves a host.
 */
export function admitWorkerCheckHostRun(input: WorkerCheckHostAdmit): WorkerCheckHostAdmitResult {
  const directory = input.directory?.trim();
  if (!directory) {
    if (input.recovery) throw new Error('Typing recovery requires its original controller budget');
    return { ok: true, used: 0 };
  }
  if (input.recovery) return admitTypingRecovery(input, directory);
  const exempt = input.limit === 'off' || input.limit === null;
  mkdirSync(directory, { recursive: true });
  const lease = acquireDirectoryLeaseWaiting(join(directory, 'admission.lease'));
  try {
    for (;;) {
      const used = workerCheckHostRunsUsed(directory);
      const last = used > 0 ? lastStamp(directory) : undefined;
      const final = !exempt && used >= WORKER_CHECK_HOST_RUN_LIMIT;
      if (final && !admitsFinalVerification(last?.record, input.worktree)) return budgetRefused(last?.record, used);
      const stamp = nextWorkerCheckHostStamp(directory);
      const record: WorkerCheckHostStampRecord = {
        ...(input.worktree ? { content: workerCheckHostContentTree(input.worktree) } : {}),
        ...(final ? { final: true } : {}),
      };
      try {
        writeStamp(directory, stamp, record, 'wx');
        return { ok: true, used: used + 1, stamp };
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    lease.release();
  }
}

/** Wrapper entry: no-op for local placement and for workers the controller did not launch. */
export function refuseExcessWorkerCheckHostRun(
  env: NodeJS.ProcessEnv,
  placesOnCheckHost: boolean,
  worktree?: string,
  command?: readonly string[],
): WorkerCheckHostAdmitResult | undefined {
  const token = env[TYPING_RECOVERY_ENV];
  if (!placesOnCheckHost && !token) return;
  const admitted = admitWorkerCheckHostRun({
    directory: env.GOAL_WORKER_CHECK_BUDGET_DIR,
    limit: env.GOAL_WORKER_CHECK_BUDGET,
    worktree,
    command,
    ...(token ? { recovery: { token, taskId: env.GOAL_TASK_ID, attempt: env.GOAL_ATTEMPT } } : {}),
  });
  if (!admitted.ok) throw new Error(admitted.message);
  if ('stamp' in admitted) env.GOAL_WORKER_CHECK_BUDGET_STAMP = admitted.stamp;
  return admitted;
}

export function workerCheckHostCommandReached(receipt: WorkerCheckHostCommandReceipt | null | undefined): boolean {
  return receipt?.resources?.commandStartedMonoMs != null;
}

export type WorkerCheckHostSettle = {
  log?: string;
  argv?: readonly string[];
  worktree?: string;
  physicalRunId?: string;
};

/** Called before handoff. It records the caller's generated inputs without changing admission or source custody. */
export function recordWorkerCheckTypingInputs(
  env: NodeJS.ProcessEnv,
  worktree: string,
  physicalRunId: string,
  command: readonly string[],
): void {
  const directory = env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim();
  const stamp = env.GOAL_WORKER_CHECK_BUDGET_STAMP?.trim();
  if (!directory || !stamp || !STAMP_NAME.test(stamp)) return;
  const record = readWorkerCheckHostStamp(directory, stamp);
  delete record.typingInputs;
  delete record.typingInputsUnavailable;
  const typingRequest = {
    physicalRunId,
    command: [...command],
    localPrepared: [] as TypingInput[],
    capture: 'physical-command' as const,
  };
  writeStamp(directory, stamp, { ...record, typingRequest });
  writeStamp(directory, stamp, {
    ...record,
    typingRequest: {
      ...typingRequest,
      localPrepared: captureTypingInputs(worktree, ['bun', 'scripts/typecheck.ts']).prepared,
    },
  });
}

/**
 * Give this wrapper run's stamp back when it died with infrastructure exit 75 before the check command ran.
 * Otherwise record the run's exit and whether its typecheck failed, so admission and settlement can see it.
 * The wrapper calls this where it records the run's final exit code.
 */
export function settleWorkerCheckHostBudget(
  env: NodeJS.ProcessEnv,
  exitCode: number,
  commandReached: boolean,
  details: WorkerCheckHostSettle = {},
): void {
  const directory = env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim();
  const stamp = env.GOAL_WORKER_CHECK_BUDGET_STAMP?.trim();
  if (!directory || !stamp || !STAMP_NAME.test(stamp)) return;
  if (exitCode === WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT && !commandReached) {
    try {
      unlinkSync(join(directory, stamp));
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    return;
  }
  let current: WorkerCheckHostStampRecord = {};
  try {
    current = readWorkerCheckHostStamp(directory, stamp);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return;
    throw error;
  }
  const log = details.log ? boundedLog(details.log) : '';
  let typingInputs: TypingInputReceipt | undefined;
  let typingInputsUnavailable: string | undefined;
  if (current.typingRequest) {
    if (!details.worktree || details.physicalRunId !== current.typingRequest.physicalRunId) {
      typingInputsUnavailable = 'Compiler input receipt has no matching physical run.';
    } else {
      try {
        typingInputs = readTypingInputReceipt(details.worktree, details.physicalRunId, current.typingRequest.command);
        if (!typingInputs) typingInputsUnavailable = 'Compiler input closure was not returned by the owning compiler.';
      } catch (error) {
        typingInputsUnavailable = String(error);
      }
    }
  }
  delete current.typingInputs;
  delete current.typingInputsUnavailable;
  writeStamp(directory, stamp, {
    ...current,
    exitCode,
    includedTypecheck: checkCommandIncludesTypecheck(details.argv, log),
    typecheckFailed: workerCheckHostTypecheckFailed(log, details.argv),
    ...(details.log ? { log: details.log } : {}),
    ...(typingInputs ? { typingInputs } : {}),
    ...(typingInputsUnavailable ? { typingInputsUnavailable } : {}),
  });
}

export type WorkerCheckHostTypingSettlement =
  | { ok: true }
  | { ok: false; kind: 'typing-failure'; result: string; command?: string[] }
  | { ok: false; kind: 'evidence-unavailable'; result: string; command?: string[] };

/** A source retry may supersede pending compiler evidence only after the exact current failure and every check settle. */
export function workerCheckHostTerminalTypingFailure(input: {
  directory?: string;
  worktree: string;
  limit?: string | number | null;
  taskId: string;
  attempt: number;
  checkIds: readonly string[];
  pendingCommand?: readonly string[];
}): Extract<WorkerCheckHostTypingSettlement, { ok: false; kind: 'typing-failure' }> | undefined {
  const settled = workerCheckHostTypingSettlement(input);
  if (
    settled.ok ||
    settled.kind !== 'typing-failure' ||
    (input.pendingCommand !== undefined && JSON.stringify(input.pendingCommand) !== JSON.stringify(settled.command)) ||
    workerCheckHostAttemptCheckCustody(input.worktree, input.taskId, input.attempt, input.checkIds) !== 'terminal'
  )
    return;
  return settled;
}

const TYPING_SETTLEMENT_FAILED = 'Last check-host run failed its typecheck.';
const TYPING_SETTLEMENT_CHANGED = 'Worktree content changed after the last check-host typecheck.';
const TYPING_SETTLEMENT_UNAVAILABLE = 'Compiler input closure is unavailable for the last check-host typecheck.';

export function workerCheckHostHasTypecheckRun(directory: string): boolean {
  let names: string[];
  try {
    names = stampNames(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return names.some((name) => {
    const stamp = readWorkerCheckHostStamp(directory, name);
    return stamp.includedTypecheck === true || stamp.typingRequest !== undefined;
  });
}

/** Controller typing settlements do not establish a shared tool incident. */
export function isTypingSettlementResult(result: string | null | undefined): boolean {
  return Boolean(result?.startsWith(TYPING_SETTLEMENT_FAILED) || isTypingEvidenceUnavailableResult(result));
}

/** Historical controller output has this exact prefix; provider/CLI failures never enter this recovery path. */
export function isTypingEvidenceUnavailableResult(result: string | null | undefined): boolean {
  return Boolean(result?.startsWith(TYPING_SETTLEMENT_UNAVAILABLE) || result?.startsWith(TYPING_SETTLEMENT_CHANGED));
}

/** Return the exact old failed stamp only when its retained Web inputs are proven different from current source. */
export function workerCheckHostStaleTypingFailureSelection(input: {
  directory: string;
  worktree: string;
  result: string;
  stamp?: string;
}): { stamp: string; command: string[]; physicalRunId: string; exitCode: number } | undefined {
  let names: string[];
  try {
    names = stampNames(input.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const typechecks = names.filter((name) => {
    const stamp = readWorkerCheckHostStamp(input.directory, name);
    return stamp.includedTypecheck || stamp.typingRequest;
  });
  const selectedIndex = input.stamp === undefined ? -1 : typechecks.indexOf(input.stamp);
  if (input.stamp !== undefined && selectedIndex < 0) return;
  const candidates = input.stamp === undefined ? typechecks.slice().reverse() : [input.stamp];
  for (const name of candidates) {
    const source = readWorkerCheckHostStamp(input.directory, name);
    const failed =
      source.typecheckFailed === true || (source.typingInputs !== undefined && source.typingInputs.exitCode !== 0);
    if (!failed) continue;
    const evidence = typingStampEvidence(input.worktree, source);
    const receipt = evidence.receipt;
    if (!receipt || evidence.rejected || !source.typingRequest || !source.log) return;
    if (typingFailureInputsMatch(input.worktree, receipt, source.typingRequest.localPrepared)) return;
    const log = boundedLog(source.log);
    if (log.startsWith('(check log unavailable')) return;
    if (typingFailureResult(source, evidence.reason) !== input.result) return;
    if (
      input.stamp !== undefined &&
      typechecks.slice(selectedIndex + 1).some((later) => {
        const stamp = readWorkerCheckHostStamp(input.directory, later);
        return (
          stamp.typecheckFailed === true || (stamp.typingInputs !== undefined && stamp.typingInputs.exitCode !== 0)
        );
      })
    )
      return;
    return {
      stamp: name,
      command: [...source.typingRequest.command],
      physicalRunId: source.typingRequest.physicalRunId,
      exitCode: receipt.exitCode,
    };
  }
}

/**
 * A recorded compiler failure requires source repair. Missing or drifted compiler evidence retains the completed
 * source pending typing-only proof, without authorizing landing or a source-writing retry.
 * Failing tests alone keep today's handling. Exempt briefs skip this guard.
 */
export function workerCheckHostTypingSettlement(input: {
  directory?: string | undefined;
  worktree: string;
  limit?: string | number | null | undefined;
}): WorkerCheckHostTypingSettlement {
  try {
    const directory = input.directory?.trim();
    if (!directory || input.limit === 'off' || input.limit === null) return { ok: true };
    let names: string[];
    try {
      names = stampNames(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      throw error;
    }
    if (names.length === 0) return { ok: true };
    const records = names.map((name) => readWorkerCheckHostStamp(directory, name));
    const typechecks = records.filter((record) => record.includedTypecheck || record.typingRequest);
    if (typechecks.length === 0) return { ok: true };
    let unavailableReason: string | undefined;
    const newestIndex = typechecks.length - 1;
    const newest = typechecks[newestIndex]!;
    for (let index = newestIndex; index >= 0; index -= 1) {
      const source = typechecks[index]!;
      const evidence = typingStampEvidence(input.worktree, source);
      const receipt = evidence.receipt;
      let sourceReason = evidence.reason;
      const rejected = evidence.rejected;
      const failed = source.typecheckFailed === true || (receipt !== undefined && receipt.exitCode !== 0);
      const fullTreeMatches =
        source.content !== undefined && workerCheckHostContentTree(input.worktree) === source.content;
      const failureInputsMatch = receipt
        ? typingFailureInputsMatch(input.worktree, receipt, source.typingRequest?.localPrepared)
        : !source.typingRequest && fullTreeMatches;
      if (failed && failureInputsMatch) {
        return {
          ok: false,
          kind: 'typing-failure',
          ...(source.typingRequest ? { command: source.typingRequest.command } : {}),
          result: typingFailureResult(source, sourceReason),
        };
      }
      if (failed) {
        if (receipt)
          sourceReason ??=
            'Retained compiler input identity differs from current inputs; typing-only proof is required.';
        else if (!receipt && source.typingRequest)
          sourceReason ??= 'Compiler input closure was not returned by the owning compiler.';
        else if (!fullTreeMatches)
          sourceReason ??=
            'Legacy evidence has no retained compiler-input closure; its original full content identity is required.';
        unavailableReason ??= sourceReason;
        continue;
      }

      const retainedKernelPass =
        index !== newestIndex &&
        receipt !== undefined &&
        isRetainedKernelTypingCompiler(input.worktree, receipt.compilerCommand);
      if (index !== newestIndex && !retainedKernelPass) continue;

      const qualification = receipt
        ? qualifyTypingInputs(input.worktree, receipt, source.typingRequest?.localPrepared)
        : undefined;

      const legacyCompatible =
        !rejected &&
        !source.typingRequest?.capture &&
        source.exitCode === 0 &&
        fullTreeMatches &&
        (!source.typingRequest ||
          JSON.stringify(captureTypingInputs(input.worktree, ['bun', 'scripts/typecheck.ts']).prepared) ===
            JSON.stringify(source.typingRequest.localPrepared));
      const unavailable =
        rejected ||
        qualification === 'evidence-unavailable' ||
        Boolean(source.typingRequest && !receipt && !legacyCompatible);
      const changed = receipt ? qualification !== 'matched' : !fullTreeMatches;
      if (!failed && (legacyCompatible || (!changed && !unavailable))) return { ok: true };

      if (receipt) {
        if (qualification !== 'matched')
          sourceReason ??= `Retained compiler evidence does not match current inputs (${qualification}); typing-only proof is required.`;
      } else if (source.typingRequest) {
        sourceReason ??= 'Compiler input closure was not returned by the owning compiler.';
      } else if (!fullTreeMatches) {
        sourceReason ??=
          'Legacy evidence has no retained compiler-input closure; its original full content identity is required.';
      }
      unavailableReason ??= sourceReason;
    }

    const reason = TYPING_SETTLEMENT_UNAVAILABLE;
    return {
      ok: false,
      kind: 'evidence-unavailable',
      ...(newest.typingRequest ? { command: newest.typingRequest.command } : {}),
      result: `${reason} The completed source is retained pending only compiler evidence; no source-writing retry is required.\n${unavailableReason ?? newest.typingInputsUnavailable ?? ''}\n${newest.log ? boundedLog(newest.log) : '(check log unavailable)'}`,
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'evidence-unavailable',
      result: `${TYPING_SETTLEMENT_UNAVAILABLE} The completed source is retained pending only compiler evidence.\n${String(error)}`,
    };
  }
}

export function isMoneyPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return MONEY_DIRECTORY.test(normalized) || MONEY_FILE.test(normalized);
}

export function isTypecheckCommand(command: readonly string[]): boolean {
  return command.some((part) => TYPECHECK_ARGUMENT.test(part)) || commandIncludesTypecheckFlag(command);
}

function commandIncludesTypecheckFlag(command: readonly string[]): boolean {
  const bun = command[0] === 'env' || command[0] === 'bun' || (command[0]?.endsWith('/bun') ?? false);
  if (!bun) return command[0] === 'tsc' && command.includes('--noEmit');
  return command.includes('check') && command.includes('--no-script');
}

export function worktreeChangedPaths(cwd: string): string[] {
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) return [];
  const dev = git(['rev-parse', '--verify', 'dev^{commit}']);
  const merge = dev.status === 0 ? git(['merge-base', 'HEAD', 'dev']) : undefined;
  const from = merge?.status === 0 && merge.stdout.trim() ? merge.stdout.trim() : 'HEAD';
  const diff = git(['diff', '--name-only', '--no-renames', from]);
  const cached = git(['diff', '--name-only', '--no-renames', '--cached', from === 'HEAD' ? 'HEAD' : from]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      [
        ...(diff.status === 0 ? diff.stdout.split('\n') : []),
        ...(cached.status === 0 ? cached.stdout.split('\n') : []),
        ...(untracked.status === 0 ? untracked.stdout.split('\n') : []),
      ].filter(Boolean),
    ),
  ];
}

function wrapperExecutionArgv(argv: readonly string[]): string[] {
  let index = 0;
  while (argv[index] === '--local' || argv[index] === '--returns') index += argv[index] === '--returns' ? 2 : 1;
  if (argv[index] === '--') index += 1;
  return argv.slice(index);
}

function stripEnvironmentPrefix(argv: readonly string[]): string[] {
  if (argv[0] !== 'env') return [...argv];
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === '--' || argument === '-u' || argument === '--unset' || argument.startsWith('--unset=')) {
      if (argument === '-u' || argument === '--unset') index += 2;
      else index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (const character of statement.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function expandCheckCommands(argv: readonly string[]): string[][] {
  const command = stripEnvironmentPrefix(wrapperExecutionArgv(argv));
  const name = command[0]?.split(/[\\/]/).at(-1);
  if (name && SHELL.has(name) && (command[1] === '-c' || command[1] === '-lc') && command[2]) {
    return command[2]
      .split(/(?:;|\|\||&&)/)
      .map((part) => part.trim())
      .filter((part) => part && !SKIP_STATEMENT.test(part))
      .map(tokenize)
      .filter((tokens) => tokens.length > 0);
  }
  return command.length ? [command] : [];
}

export type OrdinaryProductCheckKind = 'typecheck' | 'money-test' | 'test' | 'native' | 'browser' | 'growth' | 'other';

function commandHas(command: readonly string[], pattern: RegExp): boolean {
  return command.some((part) => pattern.test(part));
}

function testFilesIn(command: readonly string[]): string[] {
  return command.filter((part) => TEST_FILE.test(part));
}

export function classifyOrdinaryProductCommand(command: readonly string[]): OrdinaryProductCheckKind {
  const parts = stripEnvironmentPrefix(command);
  if (isTypecheckCommand(parts)) return 'typecheck';
  const files = testFilesIn(parts);
  if (files.length && files.every(isMoneyPath)) return 'money-test';
  if (commandHas(parts, GROWTH_COMMAND) || command.some((part) => part.startsWith('GROWTH_PROFILE='))) return 'growth';
  if (commandHas(parts, BROWSER_COMMAND)) return 'browser';
  if (commandHas(parts, NATIVE_COMMAND)) return 'native';
  if (
    parts.includes('check') &&
    parts.some((part) => part.includes('services/kernel') || part.includes('services/auth'))
  )
    return 'native';
  if (files.length || parts.includes('test') || parts.some((part) => part.endsWith('focused.ts'))) return 'test';
  if (parts.includes('check')) return 'native';
  return 'other';
}

export function ordinaryProductCheckRefusal(argv: readonly string[], moneyChanged: boolean): string | undefined {
  const commands = expandCheckCommands(argv);
  if (!commands.length) return undefined;
  const kinds = commands.map(classifyOrdinaryProductCommand);
  if (kinds.every((kind) => kind === 'typecheck')) return undefined;
  if (kinds.every((kind) => kind === 'typecheck' || kind === 'money-test') && moneyChanged) return undefined;
  return WORKER_CHECK_TESTS_AFTER_LANDING;
}

/**
 * Ordinary product attempts may typecheck changed workspaces, plus money-path tests when those paths changed.
 * A test file, native, browser or growth command is refused before any upload. Exempt briefs keep declared checks.
 */
export function refuseOrdinaryProductTestCheck(env: NodeJS.ProcessEnv, argv: readonly string[], cwd: string): void {
  if (!env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim()) return;
  if (env.GOAL_WORKER_CHECK_BUDGET === 'off') return;
  const moneyChanged = worktreeChangedPaths(cwd).some(isMoneyPath);
  const message = ordinaryProductCheckRefusal(argv, moneyChanged);
  if (message) throw new Error(message);
}
