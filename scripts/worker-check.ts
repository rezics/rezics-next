#!/usr/bin/env bun
import { ownedTemporaryDirectory } from './tmp-janitor.ts';
import { spawn, spawnSync } from 'node:child_process';
import {
  encodeLifecycleSpec,
  lifecycleDirectory,
  lifecycleSpecFromArgv,
  lifecycleSpecFromBinding,
  readLifecycleChildReceipt,
} from './check-lifecycle-child.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  readlinkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  checkWaitRecorder,
  executionCancellation,
  requestExecutionCancellation,
  ownedLocalCommand,
  parseRunLifetimeFailure,
  parseRemotePhysicalRunReceipt,
  readHosts,
  RUN_LIFETIME_FAILURE_MARKER,
  type RemotePhysicalRunReceipt,
} from './remote-check.ts';
import { mainCheckout, writeLedger, type CheckLedgerEntry } from './check-ledger.ts';
import { hostsLocation } from './stack-run.ts';
import { classifyCheck, isCheckHostRun, performanceHosts, splitEnvironmentCommand } from './check-placement.ts';
import { acquireStackSlot } from './stack-lease.ts';
import {
  CHECK_RECORD_CUSTODY_VERSION,
  controllerProofReservationPath,
  controllerProofStatePath,
  sameControllerProofBinding,
  validateControllerProofBinding,
  validateControllerProofReservation,
  validControllerProofRegistration,
  type ControllerProofBindingV1,
  type ControllerProofStartV1,
  type ControllerProofState,
  cancellationPath,
  cleanupReceiptEventPath,
  cleanupReceiptHistoryDirectory,
  cleanupReceiptPath,
  isCheckId,
  isPhysicalRunId,
  ownershipFromEnvironment,
  physicalHistoryPath,
  detachedGroupTerminal,
  processGroupMembers,
  processIdentity,
  readJsonFile,
  remoteRunCustodyPath,
  stopIntentPath,
  runnerReadyPath,
  runnerCommandMatches,
  sameProcess,
  terminateDetachedGroup,
  validateOwnership,
  validateRunnerIdentity,
  validatedRegistryDirectory,
  withCheckFence,
  writeAtomicJson,
  type CheckCleanupReceipt,
  type CheckCustodyExpectation,
  type CheckOwnership,
  type CheckRegistration,
  type CheckRemoteRunCustody,
  type RunnerIdentity,
  registrationIsPresent,
  publishCheckRegistration,
} from './check-custody.ts';
export { CHECK_RECORD_CUSTODY_VERSION } from './check-custody.ts';
export type {
  CheckCleanupReceipt,
  CheckCustodyExpectation,
  CheckOwnership,
  CheckRemoteAttempt,
  CheckRemoteObservation,
  CheckRemoteRunCustody,
  RunnerIdentity,
} from './check-custody.ts';
import {
  artifactRunRelativePath,
  cleanupArtifactRun,
  clearDeclaredArtifacts,
  prepareArtifactRun,
  readArtifactCatalog,
  restoreArtifactReturns,
  validateArtifactDeclarations,
  writeArtifactCatalog,
} from './check-artifacts.ts';
import {
  checkClass,
  checkMemoryCapacity,
  checkMemoryP90,
  checkMemoryWeight,
  memoryLeaseDirectory,
  readPeaks,
  recordPeak,
  recordScopedPeak,
} from './check-memory.ts';

const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const;

/** The host receipt, rather than exit 124 or test output, establishes a terminal infrastructure timeout. */
export function remoteLifetimeInfrastructureCause(
  output: string,
  physical?: RemotePhysicalRunReceipt,
): string | undefined {
  const receipt = parseRunLifetimeFailure(output);
  return receipt &&
    physical?.lifetimeFailure &&
    physical.exitCode === 124 &&
    receipt.host === physical.host &&
    receipt.run === physical.run &&
    JSON.stringify(receipt) === JSON.stringify(physical.lifetimeFailure)
    ? RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(receipt)
    : undefined;
}

export function workerCheckCancellation(id: string, cwd = process.cwd()) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid worker check id');
  return { id, file: join(resolve(cwd), '.temp/goal/checks/cancellations', `${id}.json`) };
}

/** Publish durable logical cancellation before the controller invokes its supported owned-process stop protocol. */
export function requestWorkerCheckCancellation(id: string, cwd = process.cwd(), signal: 1 | 2 | 15 = 15): void {
  if (readRecord(resolve(cwd), id).status === 'running')
    requestExecutionCancellation(workerCheckCancellation(id, cwd), signal);
}

export type CheckRecord = {
  custodyVersion?: typeof CHECK_RECORD_CUSTODY_VERSION;
  controllerProof?: ControllerProofBindingV1;
  id: string;
  cwd: string;
  argv: string[];
  physicalArgv?: string[];
  waitForPhysicalRunId?: string;
  status: 'running' | 'finished';
  log: string;
  ownership?: CheckOwnership;
  physicalRunId?: string;
  runnerIdentity?: RunnerIdentity;
  runnerPid?: number;
  runnerHost?: string;
  exitCode?: number;
  infrastructureFailure?: string;
  reruns?: number;
  infrastructureFailureFinal?: boolean;
  physicalRun?: RemotePhysicalRunReceipt;
};

type CheckRecordRunnerFields =
  | 'runnerPid'
  | 'runnerIdentity'
  | 'runnerHost'
  | 'exitCode'
  | 'infrastructureFailureFinal'
  | 'physicalRun';

function clearRunnerHead(record: CheckRecord): Omit<CheckRecord, CheckRecordRunnerFields> {
  const {
    runnerPid: _runnerPid,
    runnerIdentity: _runnerIdentity,
    runnerHost: _runnerHost,
    exitCode: _exitCode,
    infrastructureFailureFinal: _infrastructureFailureFinal,
    physicalRun: _physicalRun,
    ...head
  } = record;
  return head;
}

export type CheckTerminalProof = { local: true; remote: boolean | null; resultKnown: boolean; observedAt: string };

export type CheckPhysicalRecord = {
  version: 1;
  controllerProof?: ControllerProofBindingV1;
  id: string;
  cwd: string;
  argv: string[];
  ownership?: CheckOwnership;
  physicalRunId: string;
  runnerHost: string;
  runnerIdentity: RunnerIdentity;
  log: string;
  status: 'running' | 'finished' | 'unknown';
  remoteExpected: boolean;
  terminalProof?: CheckTerminalProof;
  terminalHistory?: CheckTerminalProof[];
  exitCode?: number;
  createdAt: string;
  finishedAt?: string;
};

export type CheckCancellationAuthorization = {
  version: 1;
  issuer: 'rezics-root';
  checkId: string;
  ownership: CheckOwnership;
  expectedRecordPath: string;
  expectedRecordSha256: string;
  expectedArgv: string[];
  receiptReference: string;
  receiptSha256: string;
};

export type CheckCancellationReceipt = {
  version: 1;
  checkId: string;
  ownership: CheckOwnership;
  disposition: 'logically-cancelled-physical-cleanup-unknown' | 'refused';
  physicalRunId?: string;
  recordSha256: string;
  receiptReference: string;
  receiptSha256: string;
  createdAt: string;
  reason?: string;
};

type RunnerReadyReceipt = { status: 'ready' | 'failed'; physicalRunId: string; error?: string };

type CheckPhysicalStart = (start: () => ReturnType<typeof spawn>) => Promise<ReturnType<typeof spawn>>;

class CheckCancelled extends Error {
  constructor() {
    super('worker-check: logical check was cancelled before command start');
  }
}

class CheckSetupFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const LOG_STALL_MS = 10 * 60 * 1000;
const CPU_PROGRESS_INTERVAL_MS = 60_000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_POLL_MS = 25;
const priorityFileWarnings = new Set<string>();

function applyTaskPriority(root: string, env: NodeJS.ProcessEnv): void {
  if (!env.GOAL_TASK_ID) return;
  const file = join(root, '.temp', 'goal', 'task-priority');
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (value !== 'critical' && value !== 'normal')
      throw new Error(`worker-check: ${file} must contain critical or normal`);
    if (value === 'critical') env.REMOTE_CHECK_PRIORITY = 'critical';
    else delete env.REMOTE_CHECK_PRIORITY;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('worker-check:')) throw error;
    if (!priorityFileWarnings.has(file)) {
      priorityFileWarnings.add(file);
      process.stderr.write(`worker-check: ${file} unavailable; using normal priority\n`);
    }
    delete env.REMOTE_CHECK_PRIORITY;
  }
}

type CheckMonitor = {
  stallMs?: number;
  pollMs?: number;
  rerunStallMs?: number;
  write?: (text: string) => void;
};

/** Sum Linux process CPU ticks for a command and all descendants, or return undefined when procfs is unavailable. */
export function processTreeCpuTicks(rootPid: number, procRoot = '/proc'): number | undefined {
  try {
    const children = new Map<number, number[]>();
    const ticks = new Map<number, number>();
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = readFileSync(join(procRoot, entry, 'stat'), 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) continue;
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        const parent = Number(fields[1]);
        const cpuTicks = Number(fields[11]) + Number(fields[12]);
        if (!Number.isInteger(parent) || !Number.isFinite(cpuTicks)) continue;
        ticks.set(pid, cpuTicks);
        const siblings = children.get(parent) ?? [];
        siblings.push(pid);
        children.set(parent, siblings);
      } catch {
        // Processes can disappear between listing procfs and reading their stat file.
      }
    }
    const pending = [rootPid];
    const seen = new Set<number>();
    let total = 0;
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += ticks.get(pid) ?? 0;
      pending.push(...(children.get(pid) ?? []));
    }
    return ticks.has(rootPid) ? total : undefined;
  } catch {
    return undefined;
  }
}

function recordPath(cwd: string, id: string): string {
  if (!isCheckId(id)) throw new Error(`Invalid check id: ${id}`);
  return join(cwd, '.temp', 'goal', 'checks', 'results', `${id}.json`);
}

function readRecord(cwd: string, id: string): CheckRecord {
  const file = recordPath(cwd, id);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CheckRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Unknown check id: ${id}`);
    throw error;
  }
}

function writeRecord(record: CheckRecord): void {
  const file = recordPath(record.cwd, record.id);
  writeAtomicJson(file, record);
}

function sameOwnership(left: CheckOwnership | undefined, right: CheckOwnership | undefined): boolean {
  return left?.taskId === right?.taskId && left?.attempt === right?.attempt;
}

function sameRunnerIdentity(left: RunnerIdentity | undefined, right: RunnerIdentity | undefined): boolean {
  return (
    left?.pid === right?.pid &&
    left?.start === right?.start &&
    left?.boot === right?.boot &&
    left?.group === right?.group
  );
}

function readPhysicalRecord(root: string, id: string, physicalRunId: string): CheckPhysicalRecord | undefined {
  return readJsonFile<CheckPhysicalRecord>(physicalHistoryPath(root, id, physicalRunId));
}

function writePhysicalRecord(record: CheckPhysicalRecord): void {
  const file = physicalHistoryPath(record.cwd, record.id, record.physicalRunId);
  const previous = readJsonFile<CheckPhysicalRecord>(file);
  if (previous) {
    if (
      previous.version !== record.version ||
      previous.id !== record.id ||
      previous.physicalRunId !== record.physicalRunId ||
      previous.cwd !== record.cwd ||
      previous.log !== record.log ||
      previous.runnerHost !== record.runnerHost ||
      !sameOwnership(previous.ownership, record.ownership) ||
      !sameRunnerIdentity(previous.runnerIdentity, record.runnerIdentity) ||
      JSON.stringify(previous.argv) !== JSON.stringify(record.argv) ||
      JSON.stringify(previous.controllerProof) !== JSON.stringify(record.controllerProof)
    ) {
      throw new Error('worker-check: physical check identity is immutable');
    }
    if (previous.status !== 'running' && record.status === 'running') {
      throw new Error('worker-check: physical check history cannot return to running');
    }
    const { exitCode: previousExitCode, finishedAt: previousFinishedAt, ...previousRecord } = previous;
    const { exitCode: currentExitCode, finishedAt: currentFinishedAt, ...currentRecord } = record;
    const exitCode = previousExitCode ?? currentExitCode;
    const finishedAt = previousFinishedAt ?? currentFinishedAt;
    record = {
      ...previousRecord,
      ...currentRecord,
      createdAt: previous.createdAt,
      remoteExpected: previous.remoteExpected || record.remoteExpected,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      terminalHistory: [
        ...new Map(
          [...(previous.terminalHistory ?? []), ...(record.terminalHistory ?? [])].map((proof) => [
            JSON.stringify(proof),
            proof,
          ]),
        ).values(),
      ],
    };
  }
  writeAtomicJson(file, record);
}

function physicalRecordFor(
  record: CheckRecord,
  identity: RunnerIdentity,
  host = hostname(),
  argv = record.physicalArgv ?? record.argv,
): CheckPhysicalRecord {
  if (!isPhysicalRunId(record.physicalRunId)) throw new Error('worker-check: check has no valid physical run identity');
  return {
    version: 1,
    id: record.id,
    cwd: record.cwd,
    argv: [...argv],
    ...(record.controllerProof === undefined ? {} : { controllerProof: record.controllerProof }),
    ...(record.ownership === undefined ? {} : { ownership: validateOwnership(record.ownership) }),
    physicalRunId: record.physicalRunId,
    runnerHost: host,
    runnerIdentity: validateRunnerIdentity(identity),
    log: record.log,
    status: 'running',
    remoteExpected: false,
    createdAt: new Date().toISOString(),
  };
}

function checkRoot(record: CheckRecord): string {
  return resolve(record.cwd);
}

function registryForStart(env: NodeJS.ProcessEnv, ownership: CheckOwnership | undefined): string | undefined {
  const registry = validatedRegistryDirectory(env.GOAL_CHECK_REGISTRY);
  if (registry && !ownership)
    throw new Error('worker-check: GOAL_CHECK_REGISTRY requires a valid task attempt identity');
  return registry;
}

function proofRegistryIdentity(registry: string): { dev: string; ino: string } {
  if (validatedRegistryDirectory(registry) !== registry) throw new Error('worker-check: proof registry changed');
  const stats = lstatSync(registry, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function proofFile<T>(file: string): T {
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) {
    throw new Error('worker-check: controller proof file is not a canonical regular file');
  }
  const value = readJsonFile<T>(file);
  if (!value) throw new Error('worker-check: controller proof file is missing or malformed');
  return value;
}

function syncProofFile(file: string, anchor: string): void {
  let path = file;
  while (true) {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (path === anchor) return;
    const parent = resolve(path, '..');
    if (parent === path || (parent !== anchor && !parent.startsWith(`${anchor}/`))) {
      throw new Error('worker-check: proof durability path escapes its anchor');
    }
    path = parent;
  }
}

function saveProofState(state: ControllerProofState): void {
  const file = controllerProofStatePath(state.binding.cwd, state.binding.checkId);
  writeAtomicJson(file, state);
  syncProofFile(file, state.binding.cwd);
}

function proofClaimPath(registry: string, token: string): string {
  return join(registry, 'proof-claims', `${token.toLowerCase()}.json`);
}

function proofCheckClaimPath(registry: string, checkId: string): string {
  return join(registry, 'proof-claims', `check-${checkId.toLowerCase()}.json`);
}

function readProofState(binding: ControllerProofBindingV1, registry: string): ControllerProofState {
  const claim = proofFile<ControllerProofBindingV1>(proofClaimPath(registry, binding.token));
  if (!sameControllerProofBinding(claim, binding)) throw new Error('worker-check: proof token is already bound');
  const check = proofFile<{ version: number; token: string }>(proofCheckClaimPath(registry, binding.checkId));
  if (check.version !== 1 || check.token !== binding.token)
    throw new Error('worker-check: proof check is already bound');
  const state = proofFile<ControllerProofState>(controllerProofStatePath(binding.cwd, binding.checkId));
  if (
    state.version !== 1 ||
    !sameControllerProofBinding(state.binding, binding) ||
    state.registry !== registry ||
    JSON.stringify(state.registryIdentity) !== JSON.stringify(proofRegistryIdentity(registry)) ||
    !['prepared', 'intent', 'refused'].includes(state.phase) ||
    !Array.isArray(state.physical) ||
    state.physical.length > 2 ||
    (state.phase === 'intent' ? state.physical.length === 0 : state.physical.length !== 0) ||
    state.physical.some(
      (physical) =>
        !isPhysicalRunId(physical.physicalRunId) ||
        !Array.isArray(physical.argv) ||
        physical.argv.length === 0 ||
        physical.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')),
    )
  ) {
    throw new Error('worker-check: controller proof custody is missing or changed');
  }
  return state;
}

function proofReservation(registry: string, token: string) {
  return validateControllerProofReservation(proofFile(controllerProofReservationPath(registry, token)));
}

/** Git's environment cannot redirect this check to a different index, object store or worktree. */
function proofGit(root: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`worker-check: proof source Git validation failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function validateProofSource(binding: ControllerProofBindingV1, initiating = false): void {
  if (
    (initiating && realpathSync(process.cwd()) !== binding.cwd) ||
    realpathSync(binding.cwd) !== binding.cwd ||
    proofGit(binding.cwd, ['rev-parse', '--show-toplevel']).trim() !== binding.cwd ||
    proofGit(binding.cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== binding.sourceCommit ||
    proofGit(binding.cwd, ['rev-parse', '--verify', 'HEAD^{tree}']).trim() !== binding.sourceTree ||
    proofGit(binding.cwd, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none']).length
  ) {
    throw new Error('worker-check: proof requires its initiating canonical cwd and clean captured HEAD commit/tree');
  }
  // Hash only captured tracked blobs. Untracked logs/returns do not change source; assume-unchanged and
  // skip-worktree flags cannot hide a changed tracked file. Do not rewrite the index or caller source.
  const algorithm = binding.sourceTree.length === 40 ? 'sha1' : 'sha256';
  for (const entry of proofGit(binding.cwd, ['ls-tree', '-rz', '--full-tree', binding.sourceTree]).split('\0')) {
    if (!entry) continue;
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('worker-check: proof source contains an unsupported tracked object');
    const path = resolve(binding.cwd, match[3]!);
    if (!path.startsWith(`${binding.cwd}/`)) throw new Error('worker-check: proof source path escapes its root');
    const stats = lstatSync(path);
    const hash = createHash(algorithm);
    if (match[1] === '120000') {
      if (!stats.isSymbolicLink()) throw new Error('worker-check: proof tracked symlink changed');
      const bytes = Buffer.from(readlinkSync(path));
      hash.update(`blob ${bytes.length}\0`).update(bytes);
    } else {
      if (!stats.isFile() || realpathSync(path) !== path || Boolean(stats.mode & 0o111) !== (match[1] === '100755')) {
        throw new Error('worker-check: proof tracked file mode changed');
      }
      hash.update(`blob ${stats.size}\0`);
      const descriptor = openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let length: number;
        while ((length = readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, length));
      } finally {
        closeSync(descriptor);
      }
    }
    if (hash.digest('hex') !== match[2]) throw new Error('worker-check: proof tracked source changed');
  }
}

function validateProofOwner(binding: ControllerProofBindingV1): void {
  if (!sameOwnership(binding, ownershipFromEnvironment(process.env))) {
    throw new Error('worker-check: controller proof task attempt does not match the initiating environment');
  }
}

/** Derive execution without changing the saved original or interpreting shell text. */
export function controllerProofExecutionArgv(binding: ControllerProofBindingV1): string[] {
  const { argv } = validateControllerProofBinding(binding);
  let index = 0;
  while (argv[index] === '--local' || argv[index] === '--returns') index += argv[index] === '--returns' ? 2 : 1;
  if (argv[index] === '--') index += 1;
  const command = splitEnvironmentCommand(argv.slice(index))?.command ?? argv.slice(index);
  const isBun = /(?:^|[/\\])bun(?:\.exe)?$/.test(command[0] ?? '');
  const namesWrapper = (arg: string) => /(?:^|[/\\\s"'=])worker-check\.ts(?:$|[^\w.-])/.test(arg);
  let entry = command[1] === 'run' ? 2 : 1;
  while (command[entry]?.startsWith('-')) {
    // Eval program text is ordinary argv, including when Bun options precede it.
    if (isBun && /^(?:-e|-p|--eval|--print)(?:=|$)/.test(command[entry]!)) return [...argv];
    entry += command[entry] === '--cwd' || command[entry] === '-C' ? 2 : 1;
  }
  if (isBun && command[entry] === 'test') return [...argv];
  const namedWrapper = isBun ? namesWrapper(command[entry] ?? '') : command.some(namesWrapper);
  const aliasedWrapper =
    isBun &&
    command.some(
      (arg, position) =>
        position >= 2 &&
        arg === '--local' &&
        command[position + 1] === '--' &&
        command[position + 2] === 'bun' &&
        command[position + 3] === 'test',
    );
  if (!namedWrapper && !aliasedWrapper) return [...argv];
  const prefix = ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test'];
  const files = argv.slice(prefix.length);
  if (
    prefix.some((arg, index) => argv[index] !== arg) ||
    files.length === 0 ||
    files.some(
      (file) =>
        !/^(?:[\w@.-]+\/)*[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
        file.split('/').some((part) => part === '.' || part === '..' || part.startsWith('-')),
    )
  ) {
    throw new Error('worker-check: unsupported controller proof wrapper original');
  }
  return argv.slice(2);
}

function validateProofExecutionSource(binding: ControllerProofBindingV1): void {
  const probe = lifecycleSpecFromArgv(binding.argv);
  if (probe) {
    lifecycleSpecFromBinding(binding);
    const file = join(binding.cwd, 'scripts/check-lifecycle-child.ts');
    if (
      !/^100(?:644|755) blob [0-9a-f]+\t/.test(
        proofGit(binding.cwd, ['ls-tree', binding.sourceTree, '--', 'scripts/check-lifecycle-child.ts']),
      ) ||
      !lstatSync(file).isFile() ||
      realpathSync(file) !== file ||
      createHash('sha256').update(readFileSync(file)).digest('hex') !== probe.childSha256
    )
      throw new Error('lifecycle: child must be the captured tracked source');
  }
  const execution = controllerProofExecutionArgv(binding);
  if (JSON.stringify(execution) === JSON.stringify(binding.argv)) return;
  // The pure derivation recognizes syntax; execution additionally requires the canonical captured files.
  const tracked = new Map(
    proofGit(binding.cwd, ['ls-tree', '-rz', '--full-tree', binding.sourceTree])
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry]),
  );
  for (const path of ['scripts/worker-check.ts', ...execution.slice(4)]) {
    const file = join(binding.cwd, path);
    if (
      !/^100(?:644|755) blob [0-9a-f]+\t/.test(tracked.get(path) ?? '') ||
      !lstatSync(file).isFile() ||
      realpathSync(file) !== file
    ) {
      throw new Error('worker-check: proof wrapper and explicit tests must be canonical tracked files');
    }
  }
}

/** Must be called under the logical fence before every physical incarnation can execute. */
function validateProofRecord(record: CheckRecord): ControllerProofState | undefined {
  if (record.controllerProof === undefined) return undefined;
  const binding = validateControllerProofBinding(record.controllerProof);
  validateProofOwner(binding);
  const registry = registryForStart(process.env, record.ownership);
  if (!registry) throw new Error('worker-check: controller proof registry is unavailable');
  const reservation = proofReservation(registry, binding.token);
  const state = readProofState(binding, registry);
  if (
    reservation.state !== 'reserved' ||
    !sameControllerProofBinding(reservation.binding, binding) ||
    record.id !== binding.checkId ||
    record.cwd !== binding.cwd ||
    !sameOwnership(record.ownership, binding) ||
    JSON.stringify(record.argv) !== JSON.stringify(binding.argv) ||
    state.phase !== 'intent' ||
    !state.physical.some(
      (physical) =>
        physical.physicalRunId === record.physicalRunId &&
        JSON.stringify(physical.argv) === JSON.stringify(record.physicalArgv ?? record.argv),
    )
  ) {
    throw new Error('worker-check: controller proof physical binding changed or was revoked');
  }
  if (record.physicalArgv && JSON.stringify(record.physicalArgv) !== JSON.stringify(binding.argv)) {
    const predecessor = record.waitForPhysicalRunId
      ? readPhysicalRecord(binding.cwd, binding.checkId, record.waitForPhysicalRunId)
      : undefined;
    if (
      record.reruns !== 1 ||
      state.physical.length !== 2 ||
      state.physical[1]?.physicalRunId !== record.physicalRunId ||
      state.physical[0]?.physicalRunId !== predecessor?.physicalRunId ||
      !predecessor ||
      predecessor.status !== 'finished' ||
      !predecessor.exitCode ||
      !sameControllerProofBinding(predecessor.controllerProof, binding) ||
      JSON.stringify(record.physicalArgv) !==
        JSON.stringify(controllerOverloadArgv({ ...record, log: predecessor.log }))
    ) {
      throw new Error('worker-check: controller proof physical argv is not an admitted original rerun');
    }
  }
  validateProofSource(binding);
  validateProofExecutionSource(binding);
  return state;
}

function addProofPhysicalIntent(record: CheckRecord): void {
  if (!record.controllerProof) return;
  const registry = registryForStart(process.env, record.ownership);
  if (!registry) throw new Error('worker-check: controller proof registry is unavailable');
  const state = readProofState(record.controllerProof, registry);
  if (
    state.phase === 'refused' ||
    (lifecycleSpecFromArgv(record.argv) && state.physical.length !== 0) ||
    state.physical.length >= 2 ||
    !isPhysicalRunId(record.physicalRunId) ||
    state.physical.some((physical) => physical.physicalRunId === record.physicalRunId)
  ) {
    throw new Error('worker-check: controller proof physical intent cannot be revived or duplicated');
  }
  state.phase = 'intent';
  state.physical.push({ physicalRunId: record.physicalRunId, argv: [...(record.physicalArgv ?? record.argv)] });
  saveProofState(state);
  validateProofRecord(record);
}

/** Consume only a controller-published reservation. This is the existing runner, not a second admission lane. */
export async function startControllerWorkerCheck(value: ControllerProofBindingV1): Promise<ControllerProofStartV1> {
  const binding = validateControllerProofBinding(value);
  const unknown = (reason: string): ControllerProofStartV1 => ({
    version: 1,
    outcome: 'unavailable',
    binding,
    custody: 'unknown',
    reason,
  });
  let launch: CheckRecord | undefined;
  try {
    const registry = registryForStart(process.env, ownershipFromEnvironment(process.env));
    if (!registry) return unknown('worker-check: controller proof registry is unavailable');
    const published = proofReservation(registry, binding.token);
    const answer = await withCheckFence(
      published.binding.cwd,
      published.binding.checkId,
      (): ControllerProofStartV1 => {
        const reservation = proofReservation(registry, binding.token);
        const reserved = reservation.binding;
        if (!sameControllerProofBinding(reserved, published.binding) || reserved.token !== binding.token) {
          return unknown('worker-check: controller reservation changed while acquiring its fence');
        }
        const claimPath = proofClaimPath(registry, binding.token);
        const checkClaimPath = proofCheckClaimPath(registry, reserved.checkId);
        const statePath = controllerProofStatePath(reserved.cwd, reserved.checkId);
        if (!existsSync(claimPath)) {
          // An old result or proof state is never evidence of a fresh, never-started reservation.
          if (
            existsSync(statePath) ||
            existsSync(checkClaimPath) ||
            existsSync(recordPath(reserved.cwd, reserved.checkId))
          ) {
            return unknown('worker-check: controller proof has prior custody without its token claim');
          }
          const directory = resolve(claimPath, '..');
          mkdirSync(directory, { recursive: true });
          if (realpathSync(directory) !== directory) throw new Error('worker-check: proof claim directory changed');
          // Exclusive creation also prevents token reuse across different check fences/worktrees.
          writeFileSync(checkClaimPath, `${JSON.stringify({ version: 1, token: reserved.token })}\n`, {
            flag: 'wx',
            mode: 0o600,
          });
          syncProofFile(checkClaimPath, registry);
          writeFileSync(claimPath, `${JSON.stringify(reserved)}\n`, { flag: 'wx', mode: 0o600 });
          syncProofFile(claimPath, registry);
          saveProofState({
            version: 1,
            binding: reserved,
            registry,
            registryIdentity: proofRegistryIdentity(registry),
            phase: 'prepared',
            physical: [],
          });
        }
        const state = readProofState(reserved, registry);
        const refuse = (reason: string): ControllerProofStartV1 => {
          if (state.phase === 'intent') return unknown(reason);
          // This positive monotonic refusal prevents every future physical incarnation under this fence.
          state.phase = 'refused';
          state.reason ??= reason;
          saveProofState(state);
          readProofState(reserved, registry);
          return { version: 1, outcome: 'refused-never-started', binding: reserved, reason: state.reason };
        };
        if (!sameControllerProofBinding(binding, reserved))
          return refuse('worker-check: controller proof binding mismatch');
        if (reservation.state === 'revoked') return refuse('worker-check: controller proof reservation was revoked');
        if (state.phase === 'refused')
          return refuse(state.reason ?? 'worker-check: controller proof was already refused');
        try {
          validateProofOwner(binding);
          validateProofSource(binding, true);
          validateProofExecutionSource(binding);
        } catch (error) {
          return refuse(String(error));
        }
        if (state.phase === 'intent') {
          const record = readRecord(binding.cwd, binding.checkId);
          validateProofRecord(record);
          if (!record.physicalRunId) return unknown('worker-check: proof physical custody is missing');
          const registration = readJsonFile(join(registry, `${binding.checkId}.${record.physicalRunId}.json`));
          if (
            !validControllerProofRegistration(registration, binding) ||
            (record.status === 'running' && (!record.runnerIdentity || !sameProcess(record.runnerIdentity)))
          ) {
            return unknown('worker-check: proof runner custody is unknown');
          }
          return { version: 1, outcome: 'replayed', binding, resultPath: recordPath(binding.cwd, binding.checkId) };
        }
        const record: CheckRecord = {
          custodyVersion: CHECK_RECORD_CUSTODY_VERSION,
          controllerProof: binding,
          id: binding.checkId,
          cwd: binding.cwd,
          argv: [...binding.argv],
          status: 'running',
          log: relative(binding.cwd, logPath(binding.cwd)),
          physicalRunId: randomUUID(),
          ownership: { taskId: binding.taskId, attempt: binding.attempt },
        };
        writeRecord(record);
        // Conservatively cross intent before launching the wrapper, including its native preparation.
        addProofPhysicalIntent(record);
        launch = record;
        return { version: 1, outcome: 'started', binding, resultPath: recordPath(binding.cwd, binding.checkId) };
      },
    );
    if (launch) launchDetachedRunner(launch, process.env);
    return answer;
  } catch (error) {
    // A failed setup handshake still owns a registered physical runner. Use the ordinary stop protocol,
    // never a refusal inferred from the exception, to establish that runner's complete terminal custody.
    if (launch) {
      try {
        const current = readRecord(binding.cwd, binding.checkId);
        const registry = registryForStart(process.env, current.ownership);
        if (
          registry &&
          current.physicalRunId === launch.physicalRunId &&
          current.status === 'finished' &&
          current.exitCode !== undefined &&
          current.runnerIdentity &&
          current.runnerHost &&
          readyReceipt(binding.cwd, binding.checkId, current.physicalRunId!)?.status === 'failed' &&
          validControllerProofRegistration(
            readJsonFile(join(registry, `${binding.checkId}.${current.physicalRunId}.json`)),
            binding,
          )
        ) {
          const cleanup = await stopWorkerCheck(binding.checkId, binding.cwd, {
            ownership: { taskId: binding.taskId, attempt: binding.attempt },
            physicalRunId: current.physicalRunId!,
            runnerIdentity: current.runnerIdentity,
            runnerHost: current.runnerHost,
          });
          if (
            (cleanup.disposition === 'stopped' || cleanup.disposition === 'already-terminal') &&
            cleanup.localTerminal &&
            cleanup.resultTerminal &&
            (cleanup.remoteTerminal === null || cleanup.remoteTerminal === true)
          ) {
            return { version: 1, outcome: 'started', binding, resultPath: recordPath(binding.cwd, binding.checkId) };
          }
        }
      } catch {
        // Intent, raw setup failure and uncertain custody remain retained below.
      }
    }
    // Missing records, sockets, PIDs and launch receipts cannot undo durable execution intent.
    return unknown(error instanceof Error ? error.message : String(error));
  }
}

function readyReceipt(root: string, id: string, physicalRunId: string): RunnerReadyReceipt | undefined {
  return readJsonFile<RunnerReadyReceipt>(runnerReadyPath(root, id, physicalRunId));
}

function writeReadyReceipt(root: string, id: string, physicalRunId: string, value: RunnerReadyReceipt): void {
  writeAtomicJson(runnerReadyPath(root, id, physicalRunId), value);
}

function waitForStartReceipt(root: string, id: string, physicalRunId: string, pid: number): RunnerReadyReceipt {
  const deadline = Date.now() + 30_000;
  const parking = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const receipt = readyReceipt(root, id, physicalRunId);
    if (receipt) return receipt;
    if (!processIdentity(pid)) {
      return { status: 'failed', physicalRunId, error: 'detached runner exited before registration' };
    }
    Atomics.wait(parking, 0, 0, 10);
  }
  return { status: 'failed', physicalRunId, error: 'detached runner did not publish registration before timeout' };
}

function terminateNewRunnerGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const parking = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processGroupMembers(pid).length > 0) Atomics.wait(parking, 0, 0, 20);
  const remaining = processGroupMembers(pid);
  for (const member of remaining) {
    if (!sameProcess(member)) continue;
    try {
      process.kill(member.pid, 'SIGKILL');
    } catch {
      // ESRCH means the just-spawned group exited during cleanup.
    }
  }
  const reapDeadline = Date.now() + 2_000;
  while (Date.now() < reapDeadline && processGroupMembers(pid).length > 0) Atomics.wait(parking, 0, 0, 20);
}

function recordBytes(root: string, id: string): Buffer {
  return readFileSync(recordPath(root, id));
}

function checkCancelled(root: string, id: string): CheckCancellationReceipt | undefined {
  const receipt = readJsonFile<CheckCancellationReceipt>(cancellationPath(root, id));
  return receipt?.checkId === id ? receipt : undefined;
}

function checkStopIntent(
  root: string,
  id: string,
  physicalRunId: string | undefined,
): { purpose?: string } | undefined {
  if (!physicalRunId) return undefined;
  const intent = readJsonFile<{ checkId?: string; physicalRunId?: string; purpose?: string }>(
    stopIntentPath(root, id, physicalRunId),
  );
  return intent?.checkId === id && intent.physicalRunId === physicalRunId ? intent : undefined;
}

function updatePhysicalRecord(
  root: string,
  id: string,
  physicalRunId: string,
  update: (record: CheckPhysicalRecord) => CheckPhysicalRecord,
): CheckPhysicalRecord | undefined {
  const current = readPhysicalRecord(root, id, physicalRunId);
  if (!current) return undefined;
  const next = update(current);
  if (next.terminalProof) {
    const previousProof = current.terminalHistory?.at(-1) ?? current.terminalProof;
    if (
      !previousProof ||
      previousProof.local !== next.terminalProof.local ||
      previousProof.remote !== next.terminalProof.remote ||
      previousProof.resultKnown !== next.terminalProof.resultKnown
    ) {
      next.terminalHistory = [...(current.terminalHistory ?? []), next.terminalProof];
    }
  }
  writePhysicalRecord(next);
  return next;
}

function logPath(cwd: string): string {
  const directory = join(cwd, '.temp', 'goal', 'checks');
  mkdirSync(directory, { recursive: true });
  return join(
    directory,
    `worker-check-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.log`,
  );
}

function failureSummary(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return '(the check produced no output)';
    const buffer = Buffer.alloc(Math.min(size, 12_000));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer
      .toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const failures = lines.filter((line) =>
      /error|fail|not ok|assert|expected|received|actual|panic|exception|deadline_exceeded|overloaded|\b503\b/i.test(
        line,
      ),
    );
    const summary = [...new Set(failures.length ? failures : lines.slice(-30))].slice(-30).join('\n');
    return summary.slice(-4_000) || '(the check produced no output)';
  } finally {
    closeSync(fd);
  }
}

type OverloadFailure = { files: string[]; reasons: string[] };

/** Classify complete Bun per-test failures; ambiguous output is never retried. */
function overloadFailure(output: string): OverloadFailure | undefined {
  const singleFailureFallback = (): OverloadFailure | undefined => {
    const count = output.match(/^\s*\(fail\)\s+/gm)?.length ?? 0;
    const errorLines = output.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
    const codes = ['deadline_exceeded', 'overloaded'].filter(
      (code) => errorLines.length === 1 && new RegExp(`\\b${code}\\b`).test(errorLines[0]!),
    );
    if (count !== 1 || errorLines.length !== 1 || !/\b503\b/.test(errorLines[0]!) || codes.length !== 1)
      return undefined;
    const names = new Map<string, string>();
    const absoluteNames = new Map<string, string>();
    for (const match of output.matchAll(
      /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/g,
    )) {
      const path = match[1]!;
      const name = path.split('/').at(-1)!;
      if (!names.has(name) || path.startsWith('/')) names.set(name, path);
      if (path.startsWith('/')) absoluteNames.set(name, path);
    }
    const candidates = absoluteNames.size ? absoluteNames : names;
    return { files: candidates.size === 1 ? [...candidates.values()] : [], reasons: [`HTTP 503 ${codes[0]}`] };
  };
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const failures: Array<{ file?: string; detail: string }> = [];
  const preamble: string[] = [];
  let currentFile: string | undefined;
  let currentFailure: { file?: string; detail: string } | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(trimmed)) {
      currentFile = trimmed.slice(0, -1).replace(/^(?:\.\.\/|\.\/)/, '');
      continue;
    }
    if (/^\s*\(fail\)\s+/.test(line)) {
      if (currentFailure) failures.push(currentFailure);
      currentFailure = {
        ...(currentFile === undefined ? {} : { file: currentFile }),
        detail: `${failures.length === 0 ? `${preamble.join('\n')}\n` : ''}${line}`,
      };
    } else if (currentFailure) currentFailure.detail += `\n${line}`;
    else preamble.push(line);
  }
  if (currentFailure) failures.push(currentFailure);
  if (failures.length === 0) return singleFailureFallback();
  const reasons: string[] = [];
  for (const failure of failures) {
    const errorLines = failure.detail.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
    const codes = ['deadline_exceeded', 'overloaded'].filter(
      (code) => errorLines.length === 1 && new RegExp(`\\b${code}\\b`).test(errorLines[0]!),
    );
    if (errorLines.length !== 1 || !/\b503\b/.test(errorLines[0]!) || codes.length !== 1)
      return singleFailureFallback();
    reasons.push(`HTTP 503 ${codes[0]}`);
  }
  let files = [
    ...new Set(
      failures
        .map((failure) => {
          if (failure.file) return failure.file;
          return failure.detail.match(
            /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/,
          )?.[1];
        })
        .filter((file): file is string => !!file),
    ),
  ];
  if (files.length !== failures.length) {
    const byName = new Map<string, string>();
    for (const match of output.matchAll(
      /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/g,
    )) {
      const path = match[1]!;
      const name = path.split('/').at(-1)!;
      if (!byName.has(name) || path.startsWith('/')) byName.set(name, path);
    }
    if (byName.size === failures.length) files = [...byName.values()];
  }
  return { files: files.length === failures.length ? files : [], reasons: [...new Set(reasons)] };
}

function overloadRerunCommand(argv: readonly string[], files: string[], cwd: string): string[] | undefined {
  const isBun = argv[0] === 'bun' || argv[0] === process.execPath || argv[0]!.endsWith('/bun');
  const isTest = isBun && argv[1] === 'test';
  const isCheckRunner = isBun && argv[1] === 'run';
  if (!files.length || (!isTest && !isCheckRunner)) return undefined;
  let testRoot = resolve(cwd);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--cwd' && argv[index + 1]) testRoot = resolve(cwd, argv[index + 1]!);
    else if (argv[index]!.startsWith('--cwd=')) testRoot = resolve(cwd, argv[index]!.slice(6));
  }
  const isTestPath = (arg: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg);
  const command = [...argv];
  const first = command.findIndex(isTestPath);
  const last = command.findLastIndex(isTestPath);
  if (first >= 0) command.splice(first, last - first + 1, ...files);
  else if (isTest) command.push(...files);
  else command.push(...files.map((file) => resolve(testRoot, file)));
  return command;
}

/** Derive a bound overload rerun from original argv and its real failure log, retaining wrapper options. */
function controllerOverloadArgv(record: CheckRecord): string[] {
  const binding = validateControllerProofBinding(record.controllerProof);
  const execution = controllerProofExecutionArgv(binding);
  let index = 0;
  while (execution[index] === '--local' || execution[index] === '--returns') {
    index += execution[index] === '--returns' ? 2 : 1;
  }
  if (execution[index] === '--') index += 1;
  const command = execution.slice(index);
  const failure = overloadFailure(checkLogContents(join(binding.cwd, record.log)));
  if (!failure?.files.length) return execution;
  let testRoot = binding.cwd;
  for (let position = 1; position < command.length; position += 1) {
    if (command[position] === '--cwd' && command[position + 1]) testRoot = resolve(binding.cwd, command[position + 1]!);
    else if (command[position]!.startsWith('--cwd=')) testRoot = resolve(binding.cwd, command[position]!.slice(6));
  }
  const tracked = new Set(proofGit(binding.cwd, ['ls-tree', '-rz', '--name-only', binding.sourceTree]).split('\0'));
  if (failure.files.some((file) => !tracked.has(relative(binding.cwd, resolve(testRoot, file))))) {
    return execution;
  }
  const subset = overloadRerunCommand(command, failure.files, binding.cwd);
  if (!subset) return execution;
  return [...validateControllerProofBinding({ ...binding, argv: [...execution.slice(0, index), ...subset] }).argv];
}

function checkLogContents(file: string): string {
  try {
    const output = readFileSync(file, 'utf8');
    return output.length <= 4_000_000 ? output : '';
  } catch {
    return '';
  }
}

export function workerCheckNeedsStack(argv: readonly string[], cwd = process.cwd()): boolean {
  return classifyCheck(argv, resolve(cwd)).placement === 'remote';
}

export async function runWorkerCheck(
  argv: readonly string[],
  cwd = process.cwd(),
  reportOutput = true,
  recordedLog?: string,
  leaseWaitRepeatMs = 60_000,
  logicalCheckId?: string,
  rerunNumber = 0,
  recordedCheckId?: string,
  allowOverloadRerun = true,
  physicalRunId: string = randomUUID(),
  startPhysical?: CheckPhysicalStart,
  prepared?: () => void,
): Promise<number> {
  if (argv.length === 0) throw new Error('A check command is required');
  ownershipFromEnvironment(process.env);
  if (!isPhysicalRunId(physicalRunId)) throw new Error('worker-check: invalid physical run identity');
  let localOnly = false;
  const returnPaths: string[] = [];
  while (argv[0]?.startsWith('--') && argv[0] !== '--') {
    if (argv[0] === '--local') {
      localOnly = true;
      argv = argv.slice(1);
    } else if (argv[0] === '--returns') {
      if (!argv[1] || argv[1] === '--') throw new Error('--returns requires a path');
      returnPaths.push(argv[1]);
      argv = argv.slice(2);
    } else break;
  }
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) throw new Error('Usage: worker-check.ts [--local] [--returns <path>...] -- <command...>');
  const declaredReturns = validateArtifactDeclarations(returnPaths);
  returnPaths.splice(0, returnPaths.length, ...declaredReturns);
  const root = resolve(cwd);
  const cancellation = workerCheckCancellation(
    recordedCheckId ?? (/^[0-9a-f-]{36}$/i.test(logicalCheckId ?? '') ? logicalCheckId! : randomUUID()),
    root,
  );
  const cancelled = () => executionCancellation(cancellation);
  const cancelFromSignal = (signal: 1 | 2 | 15): void => {
    // A verified watchdog stop ends this incarnation; external cancellation ends the logical check.
    if (logicalCheckId && checkStopIntent(root, logicalCheckId, physicalRunId)?.purpose === 'watchdog') return;
    requestExecutionCancellation(cancellation, signal);
  };
  const initialIntent = cancelled();
  if (initialIntent) return 128 + initialIntent.signal;
  const file = recordedLog ?? logPath(root);
  const descriptor = openSync(file, recordedLog ? 'a' : 'wx', 0o600);
  const wait = checkWaitRecorder(process.env.GOAL_CHECK_WAIT_FILE);
  wait.begin();
  const setup = <T>(step: () => T): T => {
    try {
      return step();
    } catch (error) {
      try {
        // Keep the native diagnostic verbatim. This is setup output, not a test verdict.
        writeSync(descriptor, `${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        wait.stop();
        closeSync(descriptor);
      }
      throw new CheckSetupFailure(error);
    }
  };
  const env = { ...process.env };
  env.REMOTE_CHECK_CANCELLATION_FILE = cancellation.file;
  env.REMOTE_CHECK_CANCELLATION_ID = cancellation.id;
  setup(() => applyTaskPriority(root, env));
  // The wrapper records the complete command duration; nested stack and remote wait recorders would double-count it.
  delete env.GOAL_CHECK_WAIT_FILE;
  if (
    logicalCheckId &&
    (checkCancelled(root, logicalCheckId) || checkStopIntent(root, logicalCheckId, physicalRunId))
  ) {
    wait.stop();
    closeSync(descriptor);
    process.stderr.write('worker-check: cancelled check was not started; physical cleanup remains unknown\n');
    process.stdout.write(`check: exit status 125\ncheck: log ${relative(root, file)}\n`);
    return 125;
  }
  if (returnPaths.length) setup(() => clearDeclaredArtifacts(root, returnPaths));
  if (logicalCheckId) {
    try {
      clearDeclaredArtifacts(root, readArtifactCatalog(root, logicalCheckId));
    } catch (error) {
      process.stderr.write(
        `worker-check: prior artifact cleanup failed: ${error instanceof Error ? error.message : error}\n`,
      );
    }
    env.REZICS_CHECK_ID = logicalCheckId;
    env.REZICS_CHECK_PHYSICAL_RUN_ID = physicalRunId;
    env.REZICS_CHECK_CANCEL_FILE = cancellationPath(root, logicalCheckId);
    env.REZICS_CHECK_STOP_FILE = stopIntentPath(root, logicalCheckId, physicalRunId);
    env.REZICS_CHECK_REMOTE_CUSTODY_FILE = remoteRunCustodyPath(root, physicalRunId);
  }
  const classification = setup(() => classifyCheck(argv, root));
  const lifecycle = setup(() => lifecycleSpecFromArgv(argv));
  if (lifecycle) {
    setup(() => {
      if (!logicalCheckId) throw new Error('lifecycle: controller-bound admission required');
      const bound = readRecord(root, logicalCheckId);
      if (!bound.controllerProof || bound.physicalRunId !== physicalRunId)
        throw new Error('lifecycle: physical admission mismatch');
      lifecycleSpecFromBinding(bound.controllerProof);
      validateProofRecord(bound);
    });
    // These are the only additional execution arguments; the reserved original stays immutable.
    argv = [...argv, '--physical', physicalRunId];
    returnPaths.push(
      ...['ready.json', 'release.json', 'terminal.json'].map((name) => `${lifecycleDirectory(physicalRunId)}/${name}`),
    );
    allowOverloadRerun = false;
  }
  const physicallyRemote = isCheckHostRun(root);
  if (lifecycle && physicallyRemote) delete env.REZICS_LIFECYCLE_REMOTE_RUN;
  const needsStack = classification.placement === 'remote' && !physicallyRemote;
  const commandClass = setup(() => checkClass(argv, root));
  argv = setup(() => scopeRootTypecheck(argv, root, env, (line) => writeSync(descriptor, `${line}\n`)));
  const command = setup(() => resolveRepositoryBun(argv, root));
  setup(() => prepared?.());
  const checkout = mainCheckout(root);
  let ledger: CheckLedgerEntry | undefined;
  let ledgerStarted = 0;
  const beginLedger = (host: string, slotWaitSeconds = 0): void => {
    ledgerStarted = performance.now();
    const revision = (() => {
      try {
        return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      } catch {
        return undefined;
      }
    })();
    ledger = {
      runId: randomUUID(),
      ...(logicalCheckId ? { logicalCheckId } : {}),
      rerunNumber,
      host,
      argv: [...argv],
      ...(revision === undefined ? {} : { revision }),
      start: new Date().toISOString(),
      terminalStatus: 'running',
      slotWaitSeconds,
    };
    writeLedger(ledger, checkout, console.warn, env);
  };
  const endLedger = (code: number, cause?: string): void => {
    if (!ledger) return;
    ledger.end = new Date().toISOString();
    ledger.exitStatus = code;
    ledger.phases = {
      ...(ledger.phases ?? {}),
      wrapperTotal: Math.max(0, performance.now() - ledgerStarted) / 1000,
    };
    ledger.terminalStatus = cause ? 'infrastructure-failure' : code === 0 ? 'passed' : 'failed';
    if (cause) ledger.infrastructureCause = cause;
    writeLedger(ledger, checkout, console.warn, env);
  };
  const directory = memoryLeaseDirectory(env);
  const capacity = checkMemoryCapacity(env);
  const weight = checkMemoryWeight(readPeaks(directory)[commandClass] ?? [], capacity);
  const p90 = checkMemoryP90(readPeaks(directory)[commandClass] ?? []);
  const noMemoryLease = weight === 0;
  if (noMemoryLease && !needsStack) {
    const line = `worker-check: ${commandClass} local p90 ${(p90! / 2 ** 20).toFixed(1)} MiB; skipping local memory lease\n`;
    process.stderr.write(line);
    writeSync(descriptor, line);
  }
  if (localOnly && needsStack) {
    const line =
      'worker-check: --local cannot place a heavy or unknown check on this host; routing to a performance-approved check host\n';
    process.stderr.write(line);
    writeSync(descriptor, line);
  }
  const locatedHosts = hostsLocation(root, env);
  const remoteHostsFile = 'file' in locatedHosts ? locatedHosts.file : undefined;
  let remoteHostFailure: string | undefined;
  if (needsStack) {
    if (!remoteHostsFile)
      remoteHostFailure =
        'remote check hosts are unavailable: ' + ('reason' in locatedHosts ? locatedHosts.reason : 'no file');
    else {
      try {
        if (performanceHosts(readHosts(remoteHostsFile)).length === 0)
          remoteHostFailure = `remote check hosts ${remoteHostsFile} contain no performance-approved host`;
      } catch (error) {
        remoteHostFailure = `remote check hosts are invalid: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const remoteEligible = needsStack;
  const relativeLogPath = relative(root, file);
  const report = (code: number): number => {
    process.stdout.write(`check: exit status ${code}\n`);
    if (code !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
    process.stdout.write(`check: log ${relativeLogPath}\n`);
    return code;
  };
  if (remoteEligible) {
    if (remoteHostFailure || !remoteHostsFile) {
      beginLedger('remote', 0);
      const detail = remoteHostFailure ?? 'remote check hosts are unavailable';
      writeSync(descriptor, `worker-check: infrastructure unavailable: ${detail}\n`);
      wait.stop();
      endLedger(75, detail);
      closeSync(descriptor);
      return report(75);
    }
    const artifactRelative = artifactRunRelativePath(physicalRunId);
    let artifactPrepared = false;
    try {
      if (!lifecycle) {
        prepareArtifactRun(root, physicalRunId);
        artifactPrepared = true;
      }
    } catch (error) {
      process.stderr.write(
        `worker-check: artifact handoff unavailable: ${error instanceof Error ? error.message : error}\n`,
      );
    }
    if (logicalCheckId) {
      try {
        await withCheckFence(root, logicalCheckId, () => {
          if (checkCancelled(root, logicalCheckId) || checkStopIntent(root, logicalCheckId, physicalRunId)) {
            throw new CheckCancelled();
          }
          updatePhysicalRecord(root, logicalCheckId, physicalRunId, (record) => ({ ...record, remoteExpected: true }));
        });
      } catch (error) {
        if (artifactPrepared) cleanupArtifactRun(root, physicalRunId);
        throw error;
      }
    }
    const growthProfile = lifecycle ? undefined : env.GROWTH_PROFILE;
    let growthProfilePath: string | undefined;
    let growthProfileRelative: string | undefined;
    let previousGrowthProfile = '';
    if (growthProfile !== undefined && growthProfile !== '') {
      growthProfilePath = resolve(root, growthProfile);
      const relativeProfile = relative(root, growthProfilePath);
      let resolvedProfile = growthProfilePath;
      try {
        resolvedProfile = realpathSync(growthProfilePath);
      } catch {
        // A profile may be created by the check; the lexical path is still validated below.
      }
      const resolvedRoot = realpathSync(root);
      const resolvedRelative = relative(resolvedRoot, resolvedProfile);
      if (
        relativeProfile === '..' ||
        relativeProfile.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        relativeProfile.startsWith('/') ||
        resolvedRelative === '..' ||
        resolvedRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        resolvedRelative.startsWith('/')
      ) {
        throw new Error(`GROWTH_PROFILE must be inside the worktree: ${growthProfilePath}`);
      }
      growthProfileRelative = relativeProfile.split('\\').join('/');
      if (existsSync(growthProfilePath)) previousGrowthProfile = readFileSync(growthProfilePath, 'utf8');
    }
    beginLedger('remote', 0);
    let remoteOutput = '';
    let physical: RemotePhysicalRunReceipt | undefined;
    let receiptContents = '';
    const receiptNonce = randomUUID();
    let remoteSlotWaitSeconds = 0;
    const remoteOutputPending = { stdout: '', stderr: '' };
    let transportFailureMarker = false;
    let transportReason: string | undefined;
    const remoteCommandPhases: Record<string, number> = {};
    const recordRemoteLine = (line: string): void => {
      const waitMatch = line.match(/^remote-check: slot wait ([0-9.]+) s(?: on [^\s]+| \([^)]+\))?$/);
      if (waitMatch) {
        const seconds = Number(waitMatch[1]);
        if (Number.isFinite(seconds) && seconds >= 0) {
          remoteSlotWaitSeconds += seconds;
          if (ledger) {
            ledger.slotWaitSeconds = remoteSlotWaitSeconds;
            writeLedger(ledger, checkout, console.warn, env);
          }
        }
      }
      const reason = line.match(/^remote-check: connection to .+ failed during .+ before a result$/)?.[0];
      if (reason) transportReason = reason;
      if (line === 'remote-check: transport failure marker') transportFailureMarker = true;
      const phase = line.match(/^remote-check: command phase ([^\s]+) ([0-9.]+) s$/);
      if (phase) remoteCommandPhases[phase[1]!] = Number(phase[2]);
      const commandDuration = line.match(/^remote-check: command ([0-9.]+) s on [^\s]+$/);
      if (commandDuration && ledger) {
        ledger.phases = { ...(ledger.phases ?? {}), command: Number(commandDuration[1]) };
        writeLedger(ledger, checkout, console.warn, env);
      }
      const peak = line.match(/peak memory (\d+) MiB on [^\r\n]+/);
      if (peak) {
        const peakBytes = Number(peak[1]) * 2 ** 20;
        recordPeak(directory, commandClass, peakBytes);
        process.stderr.write(
          `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
        );
      }
    };
    const consumeRemoteText = (stream: 'stdout' | 'stderr', text: string): void => {
      const lines = `${remoteOutputPending[stream]}${text}`.split(/\r?\n/);
      remoteOutputPending[stream] = lines.pop() ?? '';
      for (const line of lines) recordRemoteLine(line);
      remoteOutput = (remoteOutput + text).slice(-16_000);
    };
    const finishRemoteText = (): void => {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (remoteOutputPending[stream]) recordRemoteLine(remoteOutputPending[stream].replace(/\r$/, ''));
        remoteOutputPending[stream] = '';
      }
    };
    const remoteCommand =
      growthProfileRelative === undefined
        ? [...argv]
        : ['sh', '-c', 'export GROWTH_PROFILE="$PWD/$1"; shift; exec "$@"', 'sh', growthProfileRelative, ...argv];
    const handedOffCommand = artifactPrepared
      ? [
          'env',
          `REZICS_CHECK_ARTIFACTS_DIR=${artifactRelative}`,
          `REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID=${physicalRunId}`,
          'sh',
          '-c',
          'bun scripts/check-artifacts.ts prepare || printf "%s\\n" "worker-check: remote artifact staging unavailable" >&2; exec "$@"',
          'worker-check-artifacts',
          ...remoteCommand,
        ]
      : remoteCommand;
    let remote: ReturnType<typeof spawn>;
    try {
      const spawnRemote = () =>
        spawn(
          resolveRepositoryBun(['bun'], root)[0]!,
          [
            join(root, 'scripts/remote-check.ts'),
            ...(weight < 2 ? [] : ['--memory-gib', String(weight)]),
            '--allowed-hosts',
            'a,b',
            ...(lifecycle ? ['--max-ms', String(lifecycle.lifetimeMs + 60_000)] : []),
            ...(growthProfileRelative === undefined ? [] : ['--returns', growthProfileRelative]),
            ...(artifactPrepared ? ['--returns', artifactRelative] : []),
            ...returnPaths.flatMap((path) => ['--returns', path]),
            root,
            '--',
            ...handedOffCommand,
          ],
          {
            cwd: root,
            env: {
              ...env,
              KERNEL_CHECK_REMOTE: remoteHostsFile,
              REZICS_CHECK_PHYSICAL_RUN_ID: physicalRunId,
              REZICS_CHECK_REMOTE_CUSTODY_FILE: remoteRunCustodyPath(root, physicalRunId),
              REMOTE_CHECK_RECEIPT_FD: '3',
              REMOTE_CHECK_RECEIPT_NONCE: receiptNonce,
              ...(logicalCheckId === undefined
                ? {}
                : {
                    REZICS_CHECK_ID: logicalCheckId,
                    REZICS_CHECK_CANCEL_FILE: cancellationPath(root, logicalCheckId),
                    REZICS_CHECK_STOP_FILE: stopIntentPath(root, logicalCheckId, physicalRunId),
                  }),
              REZICS_CHECK_MEMORY: 'off',
              REZICS_STACK_LEASE: 'off',
            },
            stdio: ['inherit', 'pipe', 'pipe', 'pipe'],
          },
        );
      remote = startPhysical ? await startPhysical(spawnRemote) : spawnRemote();
    } catch (error) {
      finishRemoteText();
      wait.stop();
      endLedger(1, `remote runner failed: ${error instanceof Error ? error.message : String(error)}`);
      if (artifactPrepared) cleanupArtifactRun(root, physicalRunId);
      closeSync(descriptor);
      throw error;
    }
    (remote.stdio[3] as import('node:stream').Readable).on('data', (chunk: Buffer) => {
      receiptContents += chunk.toString('utf8');
      if (receiptContents.length > 512_000) {
        receiptContents = '';
        return;
      }
      let newline: number;
      while ((newline = receiptContents.indexOf('\n')) >= 0) {
        const line = receiptContents.slice(0, newline);
        receiptContents = receiptContents.slice(newline + 1);
        try {
          const envelope = JSON.parse(line);
          const candidate = parseRemotePhysicalRunReceipt(envelope.receipt);
          if (envelope.nonce === receiptNonce && candidate) physical = candidate;
          const failure = envelope.transportFailure;
          if (
            envelope.nonce === receiptNonce &&
            failure?.schema === 1 &&
            typeof failure.message === 'string' &&
            failure.message.length <= 2000 &&
            failure.message.startsWith('remote-check: connection to ')
          ) {
            transportReason = failure.message;
            transportFailureMarker = true;
          }
        } catch {
          /* A malformed channel is unavailable, never a native verdict or fabricated receipt. */
        }
      }
    });
    const saveRemote =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        writeSync(descriptor, chunk);
        consumeRemoteText(stream, chunk.toString('utf8'));
      };
    remote.stdout?.on('data', saveRemote('stdout'));
    remote.stderr?.on('data', saveRemote('stderr'));
    let remoteSignal: number | undefined;
    const remoteForwarders = Object.entries(SIGNALS).map(([signal, number]) => {
      const name = signal as keyof typeof SIGNALS;
      const forward = () => {
        remoteSignal ??= number;
        cancelFromSignal(number);
        remote.kill(name);
      };
      process.on(name, forward);
      return [name, forward] as const;
    });
    const cancellationTimer = setInterval(() => {
      const intent = cancelled();
      if (intent) {
        remoteSignal ??= intent.signal;
        remote.kill(intent.signal === 1 ? 'SIGHUP' : intent.signal === 2 ? 'SIGINT' : 'SIGTERM');
      }
    }, 25);
    let remoteCode: number;
    try {
      remoteCode = await new Promise<number>((resolveExit, reject) => {
        remote.once('error', reject);
        remote.once('close', (status, signal) => {
          const fromSignal = signal === null ? undefined : SIGNALS[signal as keyof typeof SIGNALS];
          resolveExit(status ?? 128 + (fromSignal ?? 1));
        });
      });
      finishRemoteText();
    } catch (error) {
      finishRemoteText();
      wait.stop();
      endLedger(1, `remote runner failed: ${error instanceof Error ? error.message : String(error)}`);
      closeSync(descriptor);
      throw error;
    } finally {
      clearInterval(cancellationTimer);
      for (const [name, forward] of remoteForwarders) process.off(name, forward);
    }
    const lifetimeReason = physical?.lifetimeFailure
      ? remoteLifetimeInfrastructureCause(
          RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(physical.lifetimeFailure),
          physical,
        )
      : undefined;
    remoteSignal ??= cancelled()?.signal;
    const failedTransport = transportFailureMarker
      ? (transportReason ??
        remoteOutput.match(/^remote-check: connection to .+ failed during .+ before a result$/m)?.[0])
      : undefined;
    const remoteCustody = readJsonFile<CheckRemoteRunCustody>(remoteRunCustodyPath(root, physicalRunId));
    if (artifactPrepared) {
      try {
        const restored = restoreArtifactReturns(root, artifactRelative, physicalRunId, logicalCheckId);
        for (const item of restored.restored) {
          process.stderr.write(
            `worker-check: artifact returned physical=${physicalRunId} path=${JSON.stringify(item.path)} bytes=${item.size} sha256=${item.sha256}\n`,
          );
        }
        for (const path of restored.missing) {
          process.stderr.write(
            `worker-check: declared artifact missing physical=${physicalRunId} path=${JSON.stringify(path)}\n`,
          );
        }
        for (const problem of restored.rejected) {
          process.stderr.write(`worker-check: artifact return rejected physical=${physicalRunId}: ${problem}\n`);
        }
      } catch (error) {
        process.stderr.write(
          `worker-check: artifact return failed: ${error instanceof Error ? error.message : error}\n`,
        );
      } finally {
        try {
          cleanupArtifactRun(root, physicalRunId);
          process.stderr.write(`worker-check: artifact staging cleaned physical=${physicalRunId}\n`);
        } catch (error) {
          process.stderr.write(`worker-check: artifact staging cleanup uncertain: ${String(error)}\n`);
        }
      }
    }
    if (recordedCheckId && physical) {
      const physicalReceipt = physical;
      await withCheckFence(root, recordedCheckId, () => {
        const record = readRecord(root, recordedCheckId);
        if (record.physicalRunId !== physicalRunId || record.status !== 'running') return;
        record.physicalRun = physicalReceipt;
        if (lifetimeReason) record.infrastructureFailure = lifetimeReason;
        writeRecord(record);
      });
    }
    if (growthProfilePath !== undefined && previousGrowthProfile !== '' && existsSync(growthProfilePath)) {
      const returnedProfile = readFileSync(growthProfilePath, 'utf8');
      if (returnedProfile.startsWith(previousGrowthProfile)) {
        // The remote workspace already contained the prior prefix; keep the returned append exactly once.
      } else if (returnedProfile !== previousGrowthProfile) {
        const separator = previousGrowthProfile.endsWith('\n') || returnedProfile === '' ? '' : '\n';
        writeFileSync(growthProfilePath, `${previousGrowthProfile}${separator}${returnedProfile}`);
      }
    }
    if (logicalCheckId && returnPaths.length) {
      try {
        writeArtifactCatalog(root, logicalCheckId, returnPaths);
      } catch (error) {
        process.stderr.write(
          `worker-check: could not record returned outputs: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    }
    const stopped = logicalCheckId !== undefined && Boolean(checkStopIntent(root, logicalCheckId, physicalRunId));
    const cancelledLogical = logicalCheckId !== undefined && checkCancelled(root, logicalCheckId) !== undefined;
    const remoteTerminal = remoteCustody?.physicalRunId === physicalRunId && remoteCustody.status === 'terminal';
    wait.stop();
    const exitCode = remoteSignal !== undefined ? 128 + remoteSignal : cancelledLogical || stopped ? 125 : remoteCode;
    if (ledger && Object.keys(remoteCommandPhases).length) ledger.commandPhases = remoteCommandPhases;
    const terminalityCause =
      failedTransport && !remoteTerminal
        ? `${failedTransport}; remote execution terminality is unknown`
        : (failedTransport ??
          (remoteCode === 75 && !remoteTerminal ? 'remote execution terminality is unknown' : undefined));
    endLedger(exitCode, lifetimeReason ?? terminalityCause);
    closeSync(descriptor);
    return report(exitCode);
  }
  beginLedger(hostname(), 0);
  const leaseEnv = { ...env };
  // The memory lease is independent of any stack lease held by the caller.
  delete leaseEnv.REZICS_STACK_SLOT;
  delete leaseEnv.REZICS_STACK_LEASE;
  if (env.REZICS_CHECK_MEMORY === 'off') leaseEnv.REZICS_STACK_LEASE = 'off';
  if (env.REZICS_CHECK_MEMORY_LEASE !== undefined) leaseEnv.REZICS_STACK_SLOT = env.REZICS_CHECK_MEMORY_LEASE;
  const admissionStarted = performance.now();
  const admissionAbort = new AbortController();
  let signalNumber: number | undefined;
  let signalName: keyof typeof SIGNALS | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let cancellationTimer: ReturnType<typeof setInterval> | undefined;
  if (logicalCheckId) {
    cancellationTimer = setInterval(() => {
      const executionIntent = cancelled();
      const logicalStop = checkCancelled(root, logicalCheckId) || checkStopIntent(root, logicalCheckId, physicalRunId);
      if (!child) {
        if (executionIntent || logicalStop) admissionAbort.abort();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (executionIntent) {
        signalNumber ??= executionIntent.signal;
        child.kill(executionIntent.signal === 1 ? 'SIGHUP' : executionIntent.signal === 2 ? 'SIGINT' : 'SIGTERM');
      } else if (logicalStop) {
        signalNumber ??= 15;
        child.kill('SIGTERM');
      }
    }, 25);
    cancellationTimer.unref?.();
  }
  const forwarders = Object.entries(SIGNALS).map(([signal, number]) => {
    const name = signal as keyof typeof SIGNALS;
    const forward = () => {
      signalNumber ??= number;
      signalName ??= name;
      cancelFromSignal(number);
      if (child) child.kill(name);
      else admissionAbort.abort();
    };
    process.on(name, forward);
    return [name, forward] as const;
  });
  const stopForwarders = (): void => {
    for (const [name, forward] of forwarders) process.off(name, forward);
    if (cancellationTimer) clearInterval(cancellationTimer);
    cancellationTimer = undefined;
  };
  let lease: Awaited<ReturnType<typeof acquireStackSlot>> | undefined;
  try {
    lease = noMemoryLease
      ? undefined
      : await acquireStackSlot(
          `worker-check: ${commandClass}`,
          {
            ...leaseEnv,
            REZICS_STACK_SLOTS: String(capacity),
            REZICS_STACK_LEASE_DIR: directory,
          },
          weight,
          (line) => writeSync(descriptor, `${line}\n`),
          leaseWaitRepeatMs,
          admissionAbort.signal,
        );
  } catch (error) {
    wait.stop();
    if (ledger) {
      ledger.slotWaitSeconds = Math.max(0, performance.now() - admissionStarted) / 1000;
      writeLedger(ledger, checkout, console.warn, env);
    }
    const executionIntent = cancelled();
    const logicalStop =
      logicalCheckId !== undefined &&
      (checkCancelled(root, logicalCheckId) !== undefined ||
        Boolean(checkStopIntent(root, logicalCheckId, physicalRunId)));
    const code =
      signalNumber !== undefined
        ? 128 + signalNumber
        : executionIntent
          ? 128 + executionIntent.signal
          : logicalStop
            ? 125
            : 1;
    endLedger(
      code,
      code === 1
        ? `local memory admission failed: ${error instanceof Error ? error.message : String(error)}`
        : undefined,
    );
    stopForwarders();
    closeSync(descriptor);
    if (code !== 1) return report(code);
    throw error;
  }
  if (ledger) {
    ledger.slotWaitSeconds = lease?.waitedMs === undefined ? 0 : lease.waitedMs / 1000;
    writeLedger(ledger, checkout, console.warn, env);
  }
  const admissionIntent = cancelled();
  const cancelledBeforeStart = logicalCheckId !== undefined && Boolean(checkCancelled(root, logicalCheckId));
  if (signalNumber !== undefined || admissionIntent || cancelledBeforeStart) {
    const code = signalNumber !== undefined ? 128 + signalNumber : admissionIntent ? 128 + admissionIntent.signal : 125;
    wait.stop();
    await lease?.release();
    endLedger(code);
    stopForwarders();
    closeSync(descriptor);
    return report(code);
  }

  if (lease)
    env.REZICS_CHECK_MEMORY_LEASE = lease.env.REZICS_STACK_SLOT ?? env.REZICS_CHECK_MEMORY_LEASE ?? 'inherited';
  let scoped = false;
  const peakFile = join(directory, `peak.${process.pid}.${randomUUID()}.tmp`);
  const ownedCommand = ownedLocalCommand(command);
  let temporary: ReturnType<typeof ownedTemporaryDirectory> | undefined;
  try {
    temporary = ownedTemporaryDirectory(join(root, '.temp'), 'check-tmp-');
    Object.assign(env, temporary.env);
    let callerSlice = '';
    if (env.REZICS_CHECK_SCOPE !== 'off') {
      try {
        const cgroup =
          readFileSync('/proc/self/cgroup', 'utf8')
            .split('\n')
            .find((line) => line.startsWith('0::'))
            ?.slice(3) ?? '';
        callerSlice =
          cgroup
            .split('/')
            .filter((part) => part.endsWith('.slice'))
            .at(-1) ?? '';
      } catch {
        /* scope support is optional */
      }
    }
    const scopeProbe =
      env.REZICS_CHECK_SCOPE !== 'off' && callerSlice
        ? Bun.spawnSync(
            ['systemd-run', '--user', '--scope', '--collect', `--slice=${callerSlice}`, '--quiet', 'true'],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          )
        : undefined;
    scoped = scopeProbe?.exitCode === 0;
    const scopeUnit = scoped ? `rezics-check-${process.pid}-${randomUUID().slice(0, 8)}.scope` : undefined;
    // Keep the command as argv, and have the wrapper capture memory.peak while it still belongs to the scope.
    const capture =
      '"$@"; status=$?; cgroup=$(sed -n \'s/^0:://p\' /proc/self/cgroup); if [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/memory.peak" ]; then cat "/sys/fs/cgroup$cgroup/memory.peak" > "$REZICS_CHECK_PEAK_FILE"; fi; exit "$status"';
    if (cancelled()) throw new CheckCancelled();
    if (
      logicalCheckId &&
      (checkCancelled(root, logicalCheckId) || checkStopIntent(root, logicalCheckId, physicalRunId))
    )
      throw new CheckCancelled();
    const spawnCommand = () =>
      spawn(
        scoped ? 'systemd-run' : ownedCommand[0]!,
        scoped
          ? [
              '--user',
              '--scope',
              '--collect',
              '--unit',
              scopeUnit!,
              `--slice=${callerSlice}`,
              '--quiet',
              '--',
              'sh',
              '-c',
              capture,
              'worker-check-scope',
              ...ownedCommand,
            ]
          : ownedCommand.slice(1),
        {
          cwd: root,
          env: { ...env, REZICS_CHECK_PEAK_FILE: peakFile },
          stdio: ['inherit', 'pipe', 'pipe'],
        },
      );
    // A local wrapper owns placement for the complete physical command. Nested stack runners cannot
    // reopen remote admission while this memory lease remains held.
    env.REZICS_CHECK_LOCAL_ONLY = '1';
    child = startPhysical ? await startPhysical(spawnCommand) : spawnCommand();
    if (signalNumber !== undefined && signalName !== undefined) child.kill(signalName);
  } catch (error) {
    wait.stop();
    const executionIntent = cancelled();
    temporary?.close();
    const logicalCancelled =
      error instanceof CheckCancelled ||
      (logicalCheckId !== undefined &&
        (checkCancelled(root, logicalCheckId) !== undefined ||
          Boolean(checkStopIntent(root, logicalCheckId, physicalRunId))));
    const code =
      signalNumber !== undefined
        ? 128 + signalNumber
        : executionIntent
          ? 128 + executionIntent.signal
          : logicalCancelled
            ? 125
            : 1;
    endLedger(
      code,
      code === 1 ? `local spawn failed: ${error instanceof Error ? error.message : String(error)}` : undefined,
    );
    stopForwarders();
    closeSync(descriptor);
    await lease?.release();
    if (signalNumber !== undefined) return report(code);
    if (code !== 1) return report(code);
    throw error;
  }

  const runningChild = child!;
  const save = (chunk: Buffer): void => {
    writeSync(descriptor, chunk);
  };
  runningChild.stdout?.on('data', save);
  runningChild.stderr?.on('data', save);
  wait.begin();

  let reportedCpuTicks = 0;
  const progressIntervalMs = Number(process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS) || CPU_PROGRESS_INTERVAL_MS;
  const procRoot = process.env.REZICS_CHECK_PROC_ROOT || '/proc';
  if (process.env.REZICS_CHECK_PROGRESS_PID_FILE) {
    writeFileSync(process.env.REZICS_CHECK_PROGRESS_PID_FILE, String(runningChild.pid));
  }
  const progressTimer = setInterval(() => {
    const cpuTicks = processTreeCpuTicks(runningChild.pid!, procRoot);
    if (cpuTicks === undefined || cpuTicks - reportedCpuTicks < 100) return;
    reportedCpuTicks = cpuTicks;
    writeSync(descriptor, `worker-check: running, ${Math.floor(cpuTicks / 100)} CPU seconds\n`);
  }, progressIntervalMs);

  let code: number;
  const physicalStarted = performance.now();
  try {
    code = await new Promise<number>((resolveExit, reject) => {
      runningChild.once('error', reject);
      runningChild.once('close', (status, signal) => {
        const fromSignal = signal === null ? undefined : SIGNALS[signal as keyof typeof SIGNALS];
        resolveExit(status ?? 128 + (fromSignal ?? 1));
      });
    });
  } catch (error) {
    endLedger(1, `local spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    clearInterval(progressTimer);
    temporary?.close();
    stopForwarders();
    wait.stop();
    closeSync(descriptor);
    await lease?.release();
  }

  signalNumber ??= cancelled()?.signal;

  if (scoped) {
    const peakBytes = recordScopedPeak(directory, commandClass, peakFile);
    if (peakBytes !== undefined) {
      process.stderr.write(
        `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
      );
    }
  }
  rmSync(peakFile, { force: true });
  if (ledger) {
    ledger.phases = { ...(ledger.phases ?? {}), command: (performance.now() - physicalStarted) / 1000 };
  }
  if (code !== 0 && signalNumber === undefined && allowOverloadRerun) {
    const output = checkLogContents(file);
    const overload =
      overloadFailure(output) ??
      (() => {
        const firstFailure = output.indexOf('(fail)');
        const onlyOneFailure = firstFailure >= 0 && output.indexOf('(fail)', firstFailure + 6) < 0;
        const errorLines = output.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
        const reason =
          errorLines.length === 1
            ? ['deadline_exceeded', 'overloaded'].find((code) =>
                new RegExp(`\\b503\\b.*\\b${code}\\b|\\b${code}\\b.*\\b503\\b`).test(errorLines[0]!),
              )
            : undefined;
        if (!onlyOneFailure || !reason) return undefined;
        const fileHeader = output
          .slice(0, firstFailure)
          .match(/^\s*([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/gm)
          ?.at(-1)
          ?.trim()
          .replace(/:$/, '');
        return { files: fileHeader ? [fileHeader] : [], reasons: [`HTTP 503 ${reason}`] };
      })();
    if (overload) {
      endLedger(code);
      const rerunCommand = overloadRerunCommand(command, overload.files, root);
      const filesLabel = rerunCommand
        ? overload.files.join(', ')
        : overload.files.length
          ? `whole command (could not select attributed files: ${overload.files.join(', ')})`
          : 'whole command (test files could not be attributed)';
      const reason = overload.reasons.join(', ');
      const line = `worker-check: overload rerun files ${filesLabel}; reason: ${reason}; host: ${hostname()}\n`;
      const append = openSync(file, 'a');
      try {
        writeSync(append, line);
      } finally {
        closeSync(append);
      }
      process.stderr.write(line);
      if (recordedCheckId && logicalCheckId) {
        await scheduleOverloadRerun(root, recordedCheckId, physicalRunId, rerunCommand ?? command, code, line);
        return code;
      }
      const rerunStatus = await runWorkerCheck(
        rerunCommand ?? command,
        root,
        false,
        file,
        leaseWaitRepeatMs,
        logicalCheckId ?? cancellation.id,
        rerunNumber + 1,
        recordedCheckId,
        false,
      );
      if (rerunStatus !== 0) {
        const second = overloadFailure(checkLogContents(file));
        if (second) {
          const secondLine = `worker-check: overload rerun failed; second failure reason: ${second.reasons.join(', ')}; host: ${hostname()}\n`;
          const secondAppend = openSync(file, 'a');
          try {
            writeSync(secondAppend, secondLine);
          } finally {
            closeSync(secondAppend);
          }
        }
      }
      if (reportOutput) {
        process.stdout.write(`check: exit status ${rerunStatus}\n`);
        if (rerunStatus !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
        process.stdout.write(`check: log ${relativeLogPath}\n`);
      }
      return rerunStatus;
    }
  }
  if (reportOutput) {
    process.stdout.write(`check: exit status ${signalNumber === undefined ? code : 128 + signalNumber}\n`);
    if (code !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
    process.stdout.write(`check: log ${relativeLogPath}\n`);
  }
  if (logicalCheckId && returnPaths.length) {
    try {
      writeArtifactCatalog(root, logicalCheckId, returnPaths);
    } catch (error) {
      process.stderr.write(
        `worker-check: could not record declared outputs: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
  if (ledger) ledger.phases = { ...(ledger.phases ?? {}), command: (performance.now() - physicalStarted) / 1000 };
  endLedger(signalNumber === undefined ? code : 128 + signalNumber);
  return signalNumber === undefined ? code : 128 + signalNumber;
}

/** Match landing's changed-file scope for the root typecheck before choosing local or remote placement. */
export function scopeRootTypecheck(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string[] {
  if (!argv.some((argument) => argument === 'scripts/typecheck.ts') || environment.TYPECHECK_CHANGED !== undefined)
    return [...argv];

  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const dev = git(['rev-parse', '--verify', 'dev^{commit}']);
  const base = dev.status === 0 ? git(['merge-base', 'HEAD', 'dev']) : undefined;
  if (base?.status !== 0 || !base?.stdout.trim()) {
    write('worker-check: scripts/typecheck.ts running unscoped (dev ref or merge base unavailable)');
    return [...argv];
  }

  const mergeBase = base.stdout.trim();
  const diff = git(['diff', '--name-only', '--no-renames', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (diff.status !== 0 || untracked.status !== 0) {
    write('worker-check: scripts/typecheck.ts running unscoped (could not list changed files)');
    return [...argv];
  }
  const changed = [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))];
  const changedValue = changed.join('\n');
  write(`worker-check: scripts/typecheck.ts scoped to ${changed.length} changed files from ${mergeBase}`);
  return ['env', `TYPECHECK_CHANGED=${changedValue}`, ...argv];
}

/** Use the caller only when it is the repository's pinned Bun; otherwise select the installed repository binary. */
export function resolveRepositoryBun(
  command: readonly string[],
  root: string,
  executable = process.execPath,
): string[] {
  const parsed = splitEnvironmentCommand(command);
  if (!parsed || parsed.command[0] !== 'bun') return [...command];
  const prefix = parsed.prefix;
  const args = parsed.command.slice(1);
  // Test fixtures and standalone check roots may not have a package manifest. In that case the
  // current Bun is the only available runtime; repository checks still enforce the pinned binary.
  if (!existsSync(join(root, 'package.json'))) return [...prefix, executable, ...args];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const expected = manifest.packageManager?.startsWith('bun@') ? manifest.packageManager.slice(4) : '';
  if (!expected) throw new Error('package.json packageManager must pin Bun');
  const revision = spawnSync(join(root, 'node_modules/.bin/bun'), ['--eval', 'console.log(Bun.revision)'], {
    encoding: 'utf8',
  });
  if (revision.error || revision.status !== 0) throw revision.error ?? new Error('Could not read pinned Bun revision');
  const pinned = Bun.revision === revision.stdout.trim() ? executable : join(root, 'node_modules/.bin/bun');
  return [...prefix, pinned, ...args];
}

function runnerStartArguments(id: string, physicalRunId: string): string[] {
  return [resolve(import.meta.path), '--run', id, '--physical-run', physicalRunId];
}

async function waitForPublishedRunner(root: string, id: string, physicalRunId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = readRecord(root, id);
    if (
      executionCancellation(workerCheckCancellation(id, root)) ||
      checkCancelled(root, id) ||
      checkStopIntent(root, id, physicalRunId)
    )
      throw new CheckCancelled();
    if (record.status !== 'running' || record.physicalRunId !== physicalRunId) {
      throw new Error('worker-check: detached runner was superseded before registration');
    }
    if (record.runnerPid === process.pid) return;
    await new Promise<void>((done) => setTimeout(done, 5));
  }
  throw new Error('worker-check: detached runner publication handshake timed out');
}

function launchDetachedRunner(record: CheckRecord, env: NodeJS.ProcessEnv): void {
  const root = resolve(record.cwd);
  const physicalRunId = record.physicalRunId;
  if (!physicalRunId) throw new Error('worker-check: a new runner needs a physical run identity');
  const file = join(root, record.log);
  const descriptor = openSync(file, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, runnerStartArguments(record.id, physicalRunId), {
      cwd: root,
      detached: true,
      env: { ...env, REZICS_RUNNER_HANDSHAKE_PATH: runnerReadyPath(root, record.id, physicalRunId) },
      stdio: ['ignore', descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  if (!child.pid) throw new Error('worker-check: detached runner did not receive a process id');
  record.runnerPid = child.pid;
  record.runnerHost = hostname();
  writeRecord(record);
  child.once('error', (error) => {
    try {
      const current = readRecord(root, record.id);
      if (current.physicalRunId !== physicalRunId || current.status !== 'running') return;
      current.status = 'finished';
      current.exitCode = 1;
      current.infrastructureFailure = `worker-check: could not start check ${record.id}: ${error.message}`;
      writeRecord(current);
    } catch {
      // A concurrent terminal publication owns the result now.
    }
  });
  child.unref();
  const ready = waitForStartReceipt(root, record.id, physicalRunId, child.pid);
  if (ready.status !== 'ready') {
    terminateNewRunnerGroup(child.pid);
    const current = readRecord(root, record.id);
    if (current.physicalRunId === physicalRunId && current.status === 'running') {
      current.status = 'finished';
      current.exitCode = 1;
      current.infrastructureFailure = `worker-check: runner start failed: ${ready.error ?? 'unknown registration failure'}`;
      writeRecord(current);
    }
    throw new Error(ready.error ?? 'worker-check: detached runner did not register');
  }
}

/** Wait for a predecessor generation to disappear before allowing an overload replacement to execute. */
async function waitForPriorPhysicalRun(
  root: string,
  id: string,
  priorPhysicalRunId: string,
  currentPhysicalRunId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!isPhysicalRunId(priorPhysicalRunId) || priorPhysicalRunId === currentPhysicalRunId) {
    throw new Error('worker-check: invalid predecessor physical run identity');
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      signal.aborted ||
      executionCancellation(workerCheckCancellation(id, root)) ||
      checkCancelled(root, id) ||
      checkStopIntent(root, id, currentPhysicalRunId)
    ) {
      throw new CheckCancelled();
    }
    const current = readRecord(root, id);
    const predecessor = readPhysicalRecord(root, id, priorPhysicalRunId);
    if (!predecessor) throw new Error('worker-check: predecessor physical custody is missing');
    if (current.status !== 'running' || current.physicalRunId !== currentPhysicalRunId) {
      throw new Error('worker-check: replacement was superseded before its command started');
    }
    const identity = predecessor.runnerIdentity;
    const groupAlive = processGroupMembers(identity.group).some((member) => member.boot === identity.boot);
    if (!groupAlive && !sameProcess(identity)) {
      if (predecessor.status !== 'finished' || predecessor.exitCode === undefined) {
        throw new Error('worker-check: predecessor exited without a terminal command result');
      }
      const remote = predecessor.remoteExpected ? remoteTerminalState(root, priorPhysicalRunId).terminal : null;
      if (remote === null || remote === true) {
        await withCheckFence(root, id, () => {
          if (
            executionCancellation(workerCheckCancellation(id, root)) ||
            checkCancelled(root, id) ||
            checkStopIntent(root, id, currentPhysicalRunId)
          )
            throw new CheckCancelled();
          const latestHead = readRecord(root, id);
          const latestPredecessor = readPhysicalRecord(root, id, priorPhysicalRunId);
          if (
            latestHead.status !== 'running' ||
            latestHead.physicalRunId !== currentPhysicalRunId ||
            !latestPredecessor ||
            latestPredecessor.status !== 'finished' ||
            latestPredecessor.exitCode === undefined ||
            !sameRunnerIdentity(latestPredecessor.runnerIdentity, identity)
          )
            throw new Error('worker-check: predecessor custody changed before terminal publication');
          updatePhysicalRecord(root, id, priorPhysicalRunId, (record) => ({
            ...record,
            terminalProof: {
              local: true,
              remote,
              resultKnown: true,
              observedAt: new Date().toISOString(),
            },
          }));
        });
        return;
      }
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error('worker-check: predecessor local or remote terminal custody is still unknown');
}

async function scheduleOverloadRerun(
  root: string,
  id: string,
  priorPhysicalRunId: string,
  argv: readonly string[],
  exitCode: number,
  line: string,
): Promise<void> {
  if (executionCancellation(workerCheckCancellation(id, root))) throw new CheckCancelled();
  const physicalRunId = randomUUID();
  const file = logPath(root);
  writeFileSync(file, line, { mode: 0o600, flag: 'wx' });
  const next = await withCheckFence(root, id, () => {
    if (
      executionCancellation(workerCheckCancellation(id, root)) ||
      checkCancelled(root, id) ||
      checkStopIntent(root, id, priorPhysicalRunId)
    )
      throw new CheckCancelled();
    const current = readRecord(root, id);
    validateProofRecord(current);
    if (current.physicalRunId !== priorPhysicalRunId || current.status !== 'running' || (current.reruns ?? 0) >= 1) {
      throw new Error('worker-check: overload rerun lost its logical generation');
    }
    const prior = readPhysicalRecord(root, id, priorPhysicalRunId);
    if (!prior || !current.runnerIdentity || !sameRunnerIdentity(prior.runnerIdentity, current.runnerIdentity)) {
      throw new Error('worker-check: overload rerun has no matching prior physical custody');
    }
    if (prior.remoteExpected && remoteTerminalState(root, priorPhysicalRunId).terminal !== true) {
      throw new Error('worker-check: overload rerun is waiting for remote terminal custody');
    }
    updatePhysicalRecord(root, id, priorPhysicalRunId, (record) => ({
      ...record,
      status: 'finished',
      exitCode: record.exitCode ?? exitCode,
      finishedAt: record.finishedAt ?? new Date().toISOString(),
    }));
    const updated: CheckRecord = {
      ...clearRunnerHead(current),
      status: 'running',
      reruns: 1,
      physicalRunId,
      physicalArgv: current.controllerProof ? controllerOverloadArgv(current) : [...argv],
      waitForPhysicalRunId: priorPhysicalRunId,
      log: relative(root, file),
      infrastructureFailure: `worker-check: overload rerun; prior physical run ${priorPhysicalRunId}; log ${relative(root, current.log)}`,
    };
    addProofPhysicalIntent(updated);
    writeRecord(updated);
    return updated;
  });
  try {
    launchDetachedRunner(next, process.env);
  } catch (error) {
    await withCheckFence(root, id, () => {
      const current = readRecord(root, id);
      if (current.physicalRunId === physicalRunId && current.status === 'running') {
        current.status = 'finished';
        current.exitCode = 1;
        current.infrastructureFailureFinal = true;
        current.infrastructureFailure = `worker-check: overload rerun could not start: ${String(error)}`;
        writeRecord(current);
      }
      const history = readPhysicalRecord(root, id, physicalRunId);
      if (history && history.status === 'running') {
        updatePhysicalRecord(root, id, physicalRunId, (record) => ({
          ...record,
          status: 'unknown',
          exitCode: 1,
          finishedAt: new Date().toISOString(),
        }));
      }
    });
    throw error;
  }
}

/** Start a detached check whose durable result can be retrieved by id after this process exits. */
export function startWorkerCheck(argv: readonly string[], cwd = process.cwd()): string {
  if (argv.length === 0) throw new Error('A check command is required');
  const root = resolve(cwd);
  const ownership = ownershipFromEnvironment(process.env);
  registryForStart(process.env, ownership);
  const id = randomUUID();
  const physicalRunId = randomUUID();
  const file = logPath(root);
  const record: CheckRecord = {
    custodyVersion: CHECK_RECORD_CUSTODY_VERSION,
    id,
    cwd: root,
    argv: [...argv],
    status: 'running',
    log: relative(root, file),
    physicalRunId,
    ...(ownership === undefined ? {} : { ownership }),
  };
  writeRecord(record);
  try {
    launchDetachedRunner(record, process.env);
  } catch (error) {
    try {
      const current = readRecord(root, id);
      if (current.physicalRunId === physicalRunId && current.status === 'running') {
        current.status = 'finished';
        current.exitCode = 1;
        current.infrastructureFailure = `worker-check: could not start check ${id}: ${error instanceof Error ? error.message : error}`;
        writeRecord(current);
      }
    } catch {
      // The start error remains the caller-visible failure.
    }
    throw error;
  }
  return id;
}

export function readWorkerCheckRecord(id: string, cwd = process.cwd()): CheckRecord {
  return readRecord(resolve(cwd), id);
}

/** Observe an already-finished incarnation. No signal, restart, capacity release or inferred missing-PID proof. */
export async function observeWorkerCheckTerminal(
  id: string,
  cwd: string,
  physicalRunId: string,
): Promise<CheckTerminalProof | undefined> {
  return await withCheckFence(cwd, id, () => {
    const head = readRecord(cwd, id);
    const history = readPhysicalRecord(cwd, id, physicalRunId);
    if (
      head.physicalRunId !== physicalRunId ||
      head.status !== 'finished' ||
      !history ||
      history.status !== 'finished' ||
      history.runnerHost !== hostname() ||
      head.exitCode === undefined ||
      history.exitCode !== head.exitCode
    )
      return undefined;
    if (!detachedGroupTerminal(history.runnerIdentity)) return undefined;
    const probe = head.controllerProof && lifecycleSpecFromArgv(head.controllerProof.argv);
    if (probe && !history.remoteExpected) {
      const receipt = readLifecycleChildReceipt(cwd, physicalRunId);
      if (
        !receipt ||
        encodeLifecycleSpec(receipt.evidence.gate.spec) !== encodeLifecycleSpec(probe) ||
        receipt.evidence.gate.host !== history.runnerHost ||
        !detachedGroupTerminal(receipt.evidence.gate.child)
      )
        return undefined;
    }
    const remote = history.remoteExpected ? remoteTerminalState(cwd, physicalRunId).terminal : null;
    if (history.remoteExpected && remote !== true) return undefined;
    const proof =
      history.terminalProof?.resultKnown && history.terminalProof.remote === remote
        ? history.terminalProof
        : { local: true as const, remote, resultKnown: true, observedAt: new Date().toISOString() };
    if (proof !== history.terminalProof)
      updatePhysicalRecord(cwd, id, physicalRunId, (record) => ({ ...record, terminalProof: proof }));
    return proof;
  });
}

export function readWorkerCheckHistory(
  id: string,
  physicalRunId: string,
  cwd = process.cwd(),
): CheckPhysicalRecord | undefined {
  if (!isCheckId(id)) throw new Error(`Invalid check id: ${id}`);
  if (!isPhysicalRunId(physicalRunId)) throw new Error('worker-check: invalid physical run identity');
  return readPhysicalRecord(resolve(cwd), id, physicalRunId);
}

export function readWorkerCheckCancellation(id: string, cwd = process.cwd()): CheckCancellationReceipt | undefined {
  if (!isCheckId(id)) throw new Error(`Invalid check id: ${id}`);
  return checkCancelled(resolve(cwd), id);
}

function receiptFor(
  id: string,
  expected: CheckCustodyExpectation,
  disposition: CheckCleanupReceipt['disposition'],
  localTerminal: boolean,
  remoteTerminal: boolean | null,
  reason?: string,
  remoteRun?: CheckCleanupReceipt['remoteRun'],
  resultTerminal = false,
): CheckCleanupReceipt {
  return {
    version: 1,
    receiptId: randomUUID(),
    checkId: id,
    physicalRunId: expected.physicalRunId,
    ownership: validateOwnership(expected.ownership),
    runnerHost: expected.runnerHost,
    runnerIdentity: validateRunnerIdentity(expected.runnerIdentity),
    disposition,
    localTerminal,
    remoteTerminal,
    resultTerminal,
    ...(remoteRun === undefined ? {} : { remoteRun }),
    ...(reason === undefined ? {} : { reason }),
    completedAt: new Date().toISOString(),
  };
}

function remoteTerminalState(
  root: string,
  physicalRunId: string,
): { terminal: boolean | null; run?: { host: string; id: string } } {
  const custody = readJsonFile<CheckRemoteRunCustody>(remoteRunCustodyPath(root, physicalRunId));
  if (!custody || custody.version !== 1 || custody.physicalRunId !== physicalRunId) return { terminal: false };
  const latest = custody.attempts.at(-1);
  return {
    terminal: custody.status === 'terminal' && custody.attempts.every((attempt) => attempt.status === 'terminal'),
    ...(latest ? { run: { host: latest.host, id: latest.id } } : {}),
  };
}

function persistCleanupReceipt(root: string, receipt: CheckCleanupReceipt): void {
  const historyDirectory = cleanupReceiptHistoryDirectory(root, receipt.checkId, receipt.physicalRunId);
  mkdirSync(historyDirectory, { recursive: true });
  writeAtomicJson(cleanupReceiptEventPath(root, receipt.checkId, receipt.physicalRunId, receipt.receiptId), receipt);
  writeAtomicJson(cleanupReceiptPath(root, receipt.checkId, receipt.physicalRunId), receipt);
}

export function readWorkerCheckCleanupReceipt(
  id: string,
  physicalRunId: string,
  cwd = process.cwd(),
): CheckCleanupReceipt | undefined {
  if (!isCheckId(id) || !isPhysicalRunId(physicalRunId))
    throw new Error('worker-check: invalid cleanup receipt identity');
  const receipt = readJsonFile<CheckCleanupReceipt>(cleanupReceiptPath(resolve(cwd), id, physicalRunId));
  return receipt?.checkId === id && receipt.physicalRunId === physicalRunId ? receipt : undefined;
}

export function readWorkerCheckCleanupHistory(
  id: string,
  physicalRunId: string,
  cwd = process.cwd(),
): CheckCleanupReceipt[] {
  if (!isCheckId(id) || !isPhysicalRunId(physicalRunId))
    throw new Error('worker-check: invalid cleanup history identity');
  const directory = cleanupReceiptHistoryDirectory(resolve(cwd), id, physicalRunId);
  try {
    return readdirSync(directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .slice(0, 128)
      .map((name) => readJsonFile<CheckCleanupReceipt>(join(directory, name)))
      .filter(
        (receipt): receipt is CheckCleanupReceipt =>
          receipt !== undefined && receipt.checkId === id && receipt.physicalRunId === physicalRunId,
      )
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  } catch {
    return [];
  }
}

/** Stop one immutable physical incarnation after exact task/attempt/host/boot/start/group validation. */
async function stopWorkerCheckOwned(
  id: string,
  cwd: string,
  expected: CheckCustodyExpectation,
  purpose: 'requested' | 'watchdog',
): Promise<CheckCleanupReceipt> {
  const root = resolve(cwd);
  if (!isCheckId(id) || !isPhysicalRunId(expected?.physicalRunId))
    throw new Error('worker-check: invalid cleanup expectation');
  validateOwnership(expected.ownership);
  validateRunnerIdentity(expected.runnerIdentity);
  const history = readPhysicalRecord(root, id, expected.physicalRunId);
  if (
    !history ||
    !sameOwnership(history.ownership, expected.ownership) ||
    history.runnerHost !== expected.runnerHost ||
    !sameRunnerIdentity(history.runnerIdentity, expected.runnerIdentity)
  ) {
    return receiptFor(id, expected, 'refused', false, false, 'physical custody does not match the expectation');
  }
  // The runner can observe the durable intent and exit before the stopper sends its signal.
  const watchdogOwnedRunner =
    purpose === 'watchdog' &&
    history.status === 'running' &&
    sameProcess(expected.runnerIdentity) &&
    runnerCommandMatches(expected.runnerIdentity, import.meta.path, id, expected.physicalRunId);
  const intent = {
    version: 1,
    checkId: id,
    physicalRunId: expected.physicalRunId,
    ownership: expected.ownership,
    runnerHost: expected.runnerHost,
    runnerIdentity: expected.runnerIdentity,
    purpose,
    startedAt: new Date().toISOString(),
  };
  const intentAccepted = await withCheckFence(root, id, () => {
    const currentHistory = readPhysicalRecord(root, id, expected.physicalRunId);
    if (
      !currentHistory ||
      !sameOwnership(currentHistory.ownership, expected.ownership) ||
      !sameRunnerIdentity(currentHistory.runnerIdentity, expected.runnerIdentity)
    )
      return false;
    const prior = readJsonFile<typeof intent>(stopIntentPath(root, id, expected.physicalRunId));
    if (prior) {
      const matches =
        prior.checkId === intent.checkId &&
        prior.physicalRunId === intent.physicalRunId &&
        prior.runnerHost === intent.runnerHost &&
        sameOwnership(prior.ownership, intent.ownership) &&
        sameRunnerIdentity(prior.runnerIdentity, intent.runnerIdentity);
      if (matches && purpose === 'requested' && prior.purpose === 'watchdog') {
        writeAtomicJson(stopIntentPath(root, id, expected.physicalRunId), { ...prior, purpose: 'requested' });
      }
      return matches;
    }
    writeAtomicJson(stopIntentPath(root, id, expected.physicalRunId), intent);
    return true;
  });
  if (!intentAccepted) {
    return receiptFor(
      id,
      expected,
      'refused',
      false,
      history.remoteExpected ? false : null,
      'physical custody changed before stop',
    );
  }

  const existing = readJsonFile<CheckCleanupReceipt>(cleanupReceiptPath(root, id, expected.physicalRunId));
  if (
    (existing?.disposition === 'stopped' || existing?.disposition === 'already-terminal') &&
    existing.localTerminal &&
    existing.resultTerminal &&
    (existing.remoteTerminal === null || existing.remoteTerminal)
  ) {
    return existing;
  }
  if (expected.runnerHost !== hostname()) {
    const uncertain = receiptFor(
      id,
      expected,
      'uncertain',
      false,
      history.remoteExpected ? false : null,
      'runner host is not local',
    );
    persistCleanupReceipt(root, uncertain);
    return uncertain;
  }

  const currentIdentity = processIdentity(expected.runnerIdentity.pid);
  let localTerminal = false;
  let stopped = watchdogOwnedRunner;
  if (currentIdentity && !sameProcess(expected.runnerIdentity)) {
    const refused = receiptFor(
      id,
      expected,
      'refused',
      false,
      history.remoteExpected ? false : null,
      'runner PID identity was reused',
    );
    persistCleanupReceipt(root, refused);
    return refused;
  }
  if (sameProcess(expected.runnerIdentity)) {
    if (!runnerCommandMatches(expected.runnerIdentity, import.meta.path, id, expected.physicalRunId)) {
      const refused = receiptFor(
        id,
        expected,
        'refused',
        false,
        history.remoteExpected ? false : null,
        'runner command does not match physical custody',
      );
      persistCleanupReceipt(root, refused);
      return refused;
    }
    const stoppedTree = await terminateDetachedGroup(expected.runnerIdentity);
    localTerminal = stoppedTree.terminal;
    stopped = localTerminal;
    if (!localTerminal) {
      const uncertain = receiptFor(
        id,
        expected,
        'uncertain',
        false,
        history.remoteExpected ? false : null,
        stoppedTree.reason,
      );
      persistCleanupReceipt(root, uncertain);
      return uncertain;
    }
  } else {
    const groupMembers = processGroupMembers(expected.runnerIdentity.group);
    if (groupMembers.length > 0) {
      const stoppedTree = await terminateDetachedGroup(expected.runnerIdentity);
      localTerminal = stoppedTree.terminal;
      stopped = localTerminal;
    } else localTerminal = detachedGroupTerminal(expected.runnerIdentity);
  }
  localTerminal = localTerminal && detachedGroupTerminal(expected.runnerIdentity);
  const lifecycle = history.controllerProof && lifecycleSpecFromArgv(history.controllerProof.argv);
  if (localTerminal && lifecycle && !history.remoteExpected) {
    try {
      const child = readLifecycleChildReceipt(root, expected.physicalRunId);
      if (
        !child ||
        encodeLifecycleSpec(child.evidence.gate.spec) !== encodeLifecycleSpec(lifecycle) ||
        child.evidence.gate.host !== expected.runnerHost
      ) {
        localTerminal = false;
      } else {
        // The existing subreaper uses a child session. An empty wrapper group alone cannot settle that session.
        if (!detachedGroupTerminal(child.evidence.gate.child)) await terminateDetachedGroup(child.evidence.gate.child);
        localTerminal = detachedGroupTerminal(child.evidence.gate.child);
      }
    } catch {
      localTerminal = false;
    }
  }

  let remote = history.remoteExpected
    ? remoteTerminalState(root, expected.physicalRunId)
    : { terminal: null as boolean | null };
  if (history.remoteExpected && !remote.terminal) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !remote.terminal) {
      await new Promise<void>((done) => setTimeout(done, 25));
      remote = remoteTerminalState(root, expected.physicalRunId);
    }
  }
  const remoteTerminal = remote.terminal;
  let resultTerminal = false;
  if (localTerminal) {
    const resultDeadline = Date.now() + 2_000;
    while (Date.now() < resultDeadline && !resultTerminal) {
      const latestPhysical = readPhysicalRecord(root, id, expected.physicalRunId);
      const head = readRecord(root, id);
      resultTerminal =
        (latestPhysical?.status === 'finished' && latestPhysical.exitCode !== undefined) ||
        (head.physicalRunId === expected.physicalRunId && head.status === 'finished' && head.exitCode !== undefined);
      if (!resultTerminal) await new Promise<void>((done) => setTimeout(done, 20));
    }
  }
  const terminal = localTerminal && (remoteTerminal === null || remoteTerminal === true) && resultTerminal;
  const receipt = receiptFor(
    id,
    expected,
    terminal ? (stopped ? 'stopped' : 'already-terminal') : 'uncertain',
    localTerminal,
    remoteTerminal,
    terminal ? undefined : 'local, remote, or original result terminality is unknown',
    remote.run,
    resultTerminal,
  );
  persistCleanupReceipt(root, receipt);
  if (localTerminal && (remoteTerminal === null || remoteTerminal === true)) {
    await withCheckFence(root, id, () => {
      updatePhysicalRecord(root, id, expected.physicalRunId, (record) => ({
        ...record,
        status: record.status === 'running' ? 'unknown' : record.status,
        finishedAt: record.finishedAt ?? new Date().toISOString(),
        terminalProof: {
          local: true,
          remote: remoteTerminal,
          resultKnown: resultTerminal,
          observedAt: new Date().toISOString(),
        },
      }));
    });
  }
  return receipt;
}

/** Stop one immutable physical incarnation after exact task/attempt/host/boot/start/group validation. */
export async function stopWorkerCheck(
  id: string,
  cwd: string,
  expected: CheckCustodyExpectation,
): Promise<CheckCleanupReceipt> {
  return await stopWorkerCheckOwned(id, cwd, expected, 'requested');
}

function cancellationRefusal(
  auth: CheckCancellationAuthorization,
  digest: string,
  reason: string,
): CheckCancellationReceipt {
  return {
    version: 1,
    checkId: auth.checkId,
    ownership: auth.ownership,
    disposition: 'refused',
    recordSha256: digest,
    receiptReference: auth.receiptReference,
    receiptSha256: auth.receiptSha256,
    createdAt: new Date().toISOString(),
    reason,
  };
}

/** Persist an exact Root-authorized logical cancellation without signaling or inventing physical cleanup. */
export async function cancelWorkerCheck(
  authorization: CheckCancellationAuthorization,
  cwd = process.cwd(),
): Promise<CheckCancellationReceipt> {
  const root = resolve(cwd);
  const auth = authorization;
  if (
    !auth ||
    auth.version !== 1 ||
    auth.issuer !== 'rezics-root' ||
    !isCheckId(auth.checkId) ||
    !/^[0-9a-f]{64}$/.test(auth.expectedRecordSha256) ||
    !/^[0-9a-f]{64}$/.test(auth.receiptSha256) ||
    !Array.isArray(auth.expectedArgv) ||
    auth.expectedArgv.length === 0 ||
    auth.expectedArgv.some((part) => typeof part !== 'string' || part.length > 4096 || part.includes('\0')) ||
    typeof auth.receiptReference !== 'string' ||
    !isAbsolute(auth.receiptReference) ||
    auth.receiptReference.length === 0 ||
    auth.receiptReference.length > 2048 ||
    /[\0\r\n]/.test(auth.receiptReference)
  )
    throw new Error('worker-check: invalid logical cancellation authorization');
  validateOwnership(auth.ownership);
  return await withCheckFence(root, auth.checkId, () => {
    const existing = readJsonFile<CheckCancellationReceipt>(cancellationPath(root, auth.checkId));
    if (existing) {
      if (
        existing.version === 1 &&
        existing.checkId === auth.checkId &&
        existing.recordSha256 === auth.expectedRecordSha256 &&
        existing.receiptReference === auth.receiptReference &&
        existing.receiptSha256 === auth.receiptSha256 &&
        sameOwnership(existing.ownership, auth.ownership) &&
        existing.disposition === 'logically-cancelled-physical-cleanup-unknown'
      )
        return existing;
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'a different cancellation tombstone already exists');
    }
    const expectedPath = recordPath(root, auth.checkId);
    if (!isAbsolute(auth.expectedRecordPath) || resolve(auth.expectedRecordPath) !== expectedPath) {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'result path does not match this check');
    }
    const receiptLocation = resolve(auth.receiptReference);
    const receiptRelative = relative(root, receiptLocation);
    if (
      receiptRelative === '' ||
      (receiptRelative !== '..' &&
        !receiptRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(receiptRelative))
    ) {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'Root receipt must be outside the checked workspace');
    }
    let receiptBytes: Buffer;
    try {
      const receiptStats = lstatSync(receiptLocation);
      if (receiptStats.isSymbolicLink() || !receiptStats.isFile() || receiptStats.size > 256 * 1024) {
        return cancellationRefusal(auth, auth.expectedRecordSha256, 'Root receipt is not a bounded regular file');
      }
      receiptBytes = readFileSync(receiptLocation);
    } catch {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'Root receipt is unavailable');
    }
    const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex');
    if (receiptDigest !== auth.receiptSha256) {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'Root receipt digest changed');
    }
    let receiptValue: {
      records?: Array<{ id?: unknown; task?: unknown; taskId?: unknown; attempt?: unknown; argv?: unknown }>;
    };
    try {
      if (receiptBytes.length > 256 * 1024) throw new Error('Root receipt exceeds the size bound');
      receiptValue = JSON.parse(receiptBytes.toString('utf8')) as typeof receiptValue;
    } catch {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'Root receipt is malformed');
    }
    const authorizedRow = receiptValue.records?.find((row) => row.id === auth.checkId);
    if (
      !authorizedRow ||
      (authorizedRow.task ?? authorizedRow.taskId) !== auth.ownership.taskId ||
      (authorizedRow.attempt !== undefined && authorizedRow.attempt !== auth.ownership.attempt) ||
      JSON.stringify(authorizedRow.argv) !== JSON.stringify(auth.expectedArgv)
    ) {
      return cancellationRefusal(
        auth,
        auth.expectedRecordSha256,
        'Root receipt does not authorize this task and command',
      );
    }
    let bytes: Buffer;
    try {
      const resultStats = lstatSync(expectedPath);
      if (resultStats.isSymbolicLink() || !resultStats.isFile()) {
        return cancellationRefusal(auth, auth.expectedRecordSha256, 'result record is not a regular file');
      }
      bytes = recordBytes(root, auth.checkId);
    } catch {
      return cancellationRefusal(auth, auth.expectedRecordSha256, 'result record is unavailable');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== auth.expectedRecordSha256) return cancellationRefusal(auth, digest, 'result record digest changed');
    const record = JSON.parse(bytes.toString('utf8')) as CheckRecord;
    if (record.id !== auth.checkId || JSON.stringify(record.argv) !== JSON.stringify(auth.expectedArgv)) {
      return cancellationRefusal(auth, digest, 'result identity or command changed');
    }
    if (record.status !== 'running') {
      return cancellationRefusal(auth, digest, 'only an exactly identified running check can be logically cancelled');
    }
    if (record.ownership && !sameOwnership(record.ownership, auth.ownership)) {
      return cancellationRefusal(auth, digest, 'task attempt does not match the result record');
    }
    const receipt: CheckCancellationReceipt = {
      version: 1,
      checkId: auth.checkId,
      ownership: validateOwnership(auth.ownership),
      disposition: 'logically-cancelled-physical-cleanup-unknown',
      ...(record.physicalRunId === undefined ? {} : { physicalRunId: record.physicalRunId }),
      recordSha256: digest,
      receiptReference: auth.receiptReference,
      receiptSha256: auth.receiptSha256,
      createdAt: new Date().toISOString(),
    };
    writeAtomicJson(cancellationPath(root, auth.checkId), receipt);
    return receipt;
  });
}

/** Wait for a previously started check; timeoutMs is useful to callers that need to yield and retry later. */
export async function waitWorkerCheck(
  id: string,
  cwd = process.cwd(),
  timeoutMs = WAIT_TIMEOUT_MS,
  monitor: CheckMonitor = {},
): Promise<number> {
  const root = resolve(cwd);
  const started = Date.now();
  const stallMs = monitor.stallMs ?? LOG_STALL_MS;
  const pollMs = monitor.pollMs ?? WAIT_POLL_MS;
  const write = monitor.write ?? ((text: string) => process.stdout.write(text));
  let record = readRecord(root, id);
  let lastGrowth = 0;
  while (record.status === 'running') {
    const cancellation = executionCancellation(workerCheckCancellation(id, root));
    if (cancellation) {
      write('check: cancellation requested; automatic restart is disabled\n');
      return 128 + cancellation.signal;
    }
    if (checkCancelled(root, id)) {
      write('worker-check: logically cancelled; physical cleanup remains unknown\n');
      return 125;
    }
    const stopIntent = checkStopIntent(root, id, record.physicalRunId);
    if (stopIntent && stopIntent.purpose !== 'watchdog') return unknownCustodyResult(record, write);
    if (Date.now() - started >= timeoutMs) {
      if (record.infrastructureFailure) write(`${record.infrastructureFailure}\n`);
      write('check: still running\n');
      const latest = latestLogLine(join(root, record.log));
      if (latest) write(`${latest}\n`);
      write(`check: log ${record.log}\n`);
      return 75;
    }
    const file = join(root, record.log);
    let modifiedAt = Date.now();
    try {
      modifiedAt = statSync(file).mtimeMs;
    } catch {
      // A runner can create its log just after publishing its result record.
    }
    if (lastGrowth === 0 || modifiedAt > lastGrowth) lastGrowth = modifiedAt;
    const alive = recordedRunnerAlive(record, id);
    if (alive === false) {
      if (record.controllerProof && lifecycleSpecFromArgv(record.controllerProof.argv))
        return unknownCustodyResult(record, write);
      const recoverable = await recoverablePhysicalRun(record, root, id);
      if (!recoverable) return unknownCustodyResult(record, monitor.write ?? ((text) => process.stdout.write(text)));
      return await rerunInterruptedCheck(
        record,
        root,
        id,
        'runner process exited',
        Math.max(0, timeoutMs - (Date.now() - started)),
        monitor,
      );
    }
    if (Date.now() - lastGrowth >= stallMs) {
      if (record.controllerProof && lifecycleSpecFromArgv(record.controllerProof.argv))
        return unknownCustodyResult(record, write);
      const custody = record.physicalRunId ? readPhysicalRecord(root, id, record.physicalRunId) : undefined;
      if (!custody || !record.runnerIdentity || !record.runnerHost || !record.physicalRunId) {
        return unknownCustodyResult(record, write);
      }
      const receipt = await stopPhysicalForWatchdog(record, root, id, custody);
      if (receipt.disposition === 'already-terminal') {
        record = readRecord(root, id);
        if (record.status === 'finished') return await waitWorkerCheck(id, root, 0, monitor);
        return unknownCustodyResult(record, write);
      }
      if (
        receipt.disposition !== 'stopped' ||
        !receipt.localTerminal ||
        !receipt.resultTerminal ||
        (receipt.remoteTerminal !== null && !receipt.remoteTerminal)
      ) {
        return unknownCustodyResult(record, write);
      }
      return await rerunInterruptedCheck(
        record,
        root,
        id,
        `log did not grow for ${stallMs < 60_000 ? `${stallMs} ms` : `${Math.round(stallMs / 60_000)} minutes`}`,
        Math.max(0, timeoutMs - (Date.now() - started)),
        monitor,
      );
    }
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - started)))),
    );
    record = readRecord(root, id);
  }
  if (checkCancelled(root, id)) {
    write('worker-check: logically cancelled; physical cleanup remains unknown\n');
    return 125;
  }
  if (record.infrastructureFailure) {
    write(`${record.infrastructureFailure}\n`);
    if (record.infrastructureFailureFinal) {
      write(`check: exit status 1\ncheck: log ${record.log}\n`);
      return 1;
    }
  }
  const code = record.exitCode ?? 1;
  const absoluteLog = join(root, record.log);
  write(`check: exit status ${code}\n`);
  if (code !== 0 && existsSync(absoluteLog)) write(`check: failure summary\n${failureSummary(absoluteLog)}\n`);
  write(`check: log ${record.log}\n`);
  return code;
}

function unknownCustodyResult(record: CheckRecord, write: (text: string) => void): number {
  write(`worker-check: physical custody is unknown; check remains quarantined\ncheck: log ${record.log}\n`);
  return 75;
}

function recordedRunnerAlive(record: CheckRecord, id: string): boolean | undefined {
  const physicalRunId = record.physicalRunId;
  const identity = record.runnerIdentity;
  if (!physicalRunId || !identity || record.runnerHost !== hostname()) return undefined;
  const current = processIdentity(identity.pid);
  if (!current) return processGroupMembers(identity.group).length > 0 ? undefined : false;
  if (!sameProcess(identity) || !runnerCommandMatches(identity, import.meta.path, id, physicalRunId)) return undefined;
  return true;
}

async function recoverablePhysicalRun(record: CheckRecord, root: string, id: string): Promise<boolean> {
  if (!record.physicalRunId || !record.runnerIdentity || !record.runnerHost) return false;
  const physical = readPhysicalRecord(root, id, record.physicalRunId);
  if (!physical || physical.status !== 'running' || !sameRunnerIdentity(physical.runnerIdentity, record.runnerIdentity))
    return false;
  if (!processGroupMembers(record.runnerIdentity.group).length && !sameProcess(record.runnerIdentity)) {
    const remote = physical.remoteExpected ? remoteTerminalState(root, record.physicalRunId).terminal : null;
    if (remote === null || remote === true) {
      return await withCheckFence(root, id, () => {
        const currentHead = readRecord(root, id);
        const latest = readPhysicalRecord(root, id, record.physicalRunId!);
        if (
          currentHead.physicalRunId !== record.physicalRunId ||
          currentHead.status !== 'running' ||
          !latest ||
          latest.status !== 'running' ||
          !sameRunnerIdentity(latest.runnerIdentity, record.runnerIdentity)
        )
          return false;
        updatePhysicalRecord(root, id, record.physicalRunId!, (current) => ({
          ...current,
          status: 'unknown',
          finishedAt: current.finishedAt ?? new Date().toISOString(),
          terminalProof: { local: true, remote, resultKnown: false, observedAt: new Date().toISOString() },
        }));
        return true;
      });
    }
  }
  return false;
}

type WatchdogStopReceipt = {
  disposition: 'stopped' | 'already-terminal' | 'refused' | 'uncertain';
  localTerminal: boolean;
  remoteTerminal: boolean | null;
  resultTerminal: boolean;
};

async function stopPhysicalForWatchdog(
  record: CheckRecord,
  root: string,
  id: string,
  physical: CheckPhysicalRecord,
): Promise<WatchdogStopReceipt> {
  if (record.ownership && record.physicalRunId && record.runnerIdentity && record.runnerHost) {
    return await stopWorkerCheckOwned(
      id,
      root,
      {
        ownership: record.ownership,
        physicalRunId: record.physicalRunId,
        runnerHost: record.runnerHost,
        runnerIdentity: record.runnerIdentity,
      },
      'watchdog',
    );
  }
  const identity = physical.runnerIdentity;
  if (
    physical.ownership !== undefined ||
    physical.runnerHost !== hostname() ||
    !sameRunnerIdentity(identity, record.runnerIdentity)
  )
    return { disposition: 'refused', localTerminal: false, remoteTerminal: false, resultTerminal: false };
  const existed = sameProcess(identity);
  if (existed && !runnerCommandMatches(identity, import.meta.path, id, physical.physicalRunId)) {
    return {
      disposition: 'refused',
      localTerminal: false,
      remoteTerminal: physical.remoteExpected ? false : null,
      resultTerminal: false,
    };
  }
  const intent = {
    version: 1,
    checkId: id,
    physicalRunId: physical.physicalRunId,
    ownership: undefined,
    runnerHost: physical.runnerHost,
    runnerIdentity: identity,
    purpose: 'watchdog',
    startedAt: new Date().toISOString(),
  };
  const intentAccepted = await withCheckFence(root, id, () => {
    const latest = readPhysicalRecord(root, id, physical.physicalRunId);
    if (!latest || !sameRunnerIdentity(latest.runnerIdentity, identity)) return false;
    const file = stopIntentPath(root, id, physical.physicalRunId);
    const prior = readJsonFile<typeof intent>(file);
    if (prior) {
      return (
        prior.checkId === id &&
        prior.physicalRunId === physical.physicalRunId &&
        sameRunnerIdentity(prior.runnerIdentity, identity)
      );
    }
    writeAtomicJson(file, intent);
    return true;
  });
  if (!intentAccepted)
    return {
      disposition: 'refused',
      localTerminal: false,
      remoteTerminal: physical.remoteExpected ? false : null,
      resultTerminal: false,
    };
  const groupMembers = processGroupMembers(identity.group);
  let localTerminal = !existed && groupMembers.length === 0;
  let stopped = false;
  if (existed || groupMembers.length > 0) {
    const result = await terminateDetachedGroup(identity);
    localTerminal = result.terminal;
    stopped = localTerminal && existed;
  }
  if (!localTerminal)
    return {
      disposition: 'uncertain',
      localTerminal: false,
      remoteTerminal: physical.remoteExpected ? false : null,
      resultTerminal: false,
    };
  let remoteTerminal = physical.remoteExpected ? remoteTerminalState(root, physical.physicalRunId).terminal : null;
  if (physical.remoteExpected && !remoteTerminal) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !remoteTerminal) {
      await new Promise<void>((done) => setTimeout(done, 25));
      remoteTerminal = remoteTerminalState(root, physical.physicalRunId).terminal;
    }
  }
  let resultTerminal = false;
  const resultDeadline = Date.now() + 2_000;
  while (Date.now() < resultDeadline && !resultTerminal) {
    const latestPhysical = readPhysicalRecord(root, id, physical.physicalRunId);
    const head = readRecord(root, id);
    resultTerminal =
      (latestPhysical?.status === 'finished' && latestPhysical.exitCode !== undefined) ||
      (head.physicalRunId === physical.physicalRunId && head.status === 'finished' && head.exitCode !== undefined);
    if (!resultTerminal) await new Promise<void>((done) => setTimeout(done, 20));
  }
  if (localTerminal && (remoteTerminal === null || remoteTerminal === true)) {
    await withCheckFence(root, id, () => {
      updatePhysicalRecord(root, id, physical.physicalRunId, (latest) => ({
        ...latest,
        status: latest.status === 'running' ? 'unknown' : latest.status,
        terminalProof: {
          local: true,
          remote: remoteTerminal,
          resultKnown: resultTerminal,
          observedAt: new Date().toISOString(),
        },
      }));
    });
  }
  if (remoteTerminal !== null && !remoteTerminal) {
    return { disposition: 'uncertain', localTerminal, remoteTerminal, resultTerminal };
  }
  return {
    disposition: resultTerminal ? (stopped ? 'stopped' : 'already-terminal') : 'uncertain',
    localTerminal,
    remoteTerminal,
    resultTerminal,
  };
}

function latestLogLine(file: string): string {
  try {
    return (
      readFileSync(file, 'utf8')
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) ?? ''
    );
  } catch {
    return '';
  }
}

async function rerunInterruptedCheck(
  record: CheckRecord,
  root: string,
  id: string,
  reason: string,
  remainingMs: number,
  monitor: CheckMonitor,
): Promise<number> {
  const cancellation = executionCancellation(workerCheckCancellation(id, root));
  if (cancellation) return 128 + cancellation.signal;
  if (checkCancelled(root, id)) return 125;
  const priorStop = checkStopIntent(root, id, record.physicalRunId);
  if (priorStop && priorStop.purpose !== 'watchdog') {
    return unknownCustodyResult(record, monitor.write ?? ((text) => process.stdout.write(text)));
  }
  const rerunStarted = Date.now();
  const host = record.runnerHost ?? hostname();
  const oldLog = record.log;
  if ((record.reruns ?? 0) >= 1) {
    await withCheckFence(root, id, () => {
      if (executionCancellation(workerCheckCancellation(id, root)) || checkCancelled(root, id))
        throw new CheckCancelled();
      const current = readRecord(root, id);
      if (
        current.physicalRunId !== record.physicalRunId ||
        (current.status !== 'running' && !(reason.startsWith('log did not grow') && current.status === 'finished'))
      )
        return;
      current.status = 'finished';
      current.exitCode = 1;
      current.infrastructureFailureFinal = true;
      current.infrastructureFailure = `worker-check: infrastructure failure (${reason}) on ${host}; second runner failed; log ${oldLog}`;
      writeRecord(current);
    });
    const latest = readRecord(root, id);
    (monitor.write ?? ((text: string) => process.stdout.write(text)))(
      `${latest.infrastructureFailure ?? 'worker-check: second runner failed'}\ncheck: exit status 1\ncheck: log ${latest.log}\n`,
    );
    return 1;
  }
  const newPhysicalRunId = randomUUID();
  const rerunLog = logPath(root);
  const next = await withCheckFence(root, id, () => {
    if (executionCancellation(workerCheckCancellation(id, root)) || checkCancelled(root, id))
      throw new CheckCancelled();
    const current = readRecord(root, id);
    if (
      current.physicalRunId !== record.physicalRunId ||
      (current.status !== 'running' && !(reason.startsWith('log did not grow') && current.status === 'finished'))
    )
      return current;
    validateProofRecord(current);
    if (current.physicalRunId) {
      const physical = readPhysicalRecord(root, id, current.physicalRunId);
      const terminal =
        physical?.terminalProof?.local === true &&
        (physical.terminalProof.remote === null || physical.terminalProof.remote === true);
      if (!terminal) throw new Error('worker-check: prior physical run has no terminal cleanup proof');
    }
    const updated: CheckRecord = {
      ...clearRunnerHead(current),
      status: 'running',
      reruns: 1,
      log: relative(root, rerunLog),
      physicalRunId: newPhysicalRunId,
      infrastructureFailure: `worker-check: infrastructure failure (${reason}) on ${host}; rerunning once; old log ${oldLog}`,
    };
    addProofPhysicalIntent(updated);
    writeRecord(updated);
    return updated;
  });
  if (next.physicalRunId !== newPhysicalRunId) return next.exitCode ?? 1;
  try {
    launchDetachedRunner(next, process.env);
  } catch (error) {
    await withCheckFence(root, id, () => {
      const current = readRecord(root, id);
      if (current.physicalRunId !== newPhysicalRunId || current.status !== 'running') return;
      current.status = 'finished';
      current.exitCode = 1;
      current.infrastructureFailureFinal = true;
      current.infrastructureFailure = `worker-check: infrastructure failure (could not start rerun: ${String(error)}) on ${hostname()}; old log ${oldLog}`;
      writeRecord(current);
    });
    return 1;
  }
  return waitWorkerCheck(id, root, Math.max(0, remainingMs - (Date.now() - rerunStarted)), {
    ...monitor,
    ...(monitor.rerunStallMs === undefined ? {} : { stallMs: monitor.rerunStallMs }),
  });
}

async function runRecordedCheck(id: string, cwd = process.cwd(), physicalArgument?: string): Promise<number> {
  const root = resolve(cwd);
  if (physicalArgument) await waitForPublishedRunner(root, id, physicalArgument);
  const initial = readRecord(root, id);
  const executionIntent = executionCancellation(workerCheckCancellation(id, root));
  if (executionIntent) return 128 + executionIntent.signal;
  if (checkCancelled(root, id)) return 125;
  const physicalRunId = physicalArgument ?? initial.physicalRunId;
  if (!isPhysicalRunId(physicalRunId))
    throw new Error('worker-check: detached check has no valid physical run identity');
  const executionArgv =
    initial.physicalArgv ??
    (initial.controllerProof ? controllerProofExecutionArgv(initial.controllerProof) : initial.argv);
  if (
    !Array.isArray(executionArgv) ||
    executionArgv.length === 0 ||
    executionArgv.some((argument) => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
  ) {
    throw new Error('worker-check: detached physical command is malformed');
  }
  let record!: CheckRecord;
  const identity = processIdentity();
  if (!identity) throw new Error('worker-check: detached runner identity is unavailable');
  await withCheckFence(root, id, () => {
    if (
      executionCancellation(workerCheckCancellation(id, root)) ||
      checkCancelled(root, id) ||
      checkStopIntent(root, id, physicalRunId)
    )
      throw new CheckCancelled();
    const current = readRecord(root, id);
    if (current.status !== 'running' || current.physicalRunId !== physicalRunId) {
      throw new Error('worker-check: detached runner was superseded before start');
    }
    const supplied = ownershipFromEnvironment(process.env);
    if (!sameOwnership(current.ownership, supplied))
      throw new Error('worker-check: task attempt identity changed before start');
    if (current.runnerPid !== process.pid) {
      throw new Error('worker-check: detached runner PID does not match the published head');
    }
    validateProofRecord(current);
    const updated: CheckRecord = {
      ...current,
      custodyVersion: CHECK_RECORD_CUSTODY_VERSION,
      runnerPid: process.pid,
      runnerHost: hostname(),
      runnerIdentity: identity,
    };
    const history = physicalRecordFor(updated, identity);
    writeRecord(updated);
    writePhysicalRecord(history);
    const registry = registryForStart(process.env, updated.ownership);
    if (registry) {
      const registration: CheckRegistration = {
        version: CHECK_RECORD_CUSTODY_VERSION,
        checkId: id,
        resultPath: recordPath(root, id),
        ownership: validateOwnership(updated.ownership),
        physicalRunId,
        runnerHost: hostname(),
        runnerIdentity: identity,
        registeredAt: new Date().toISOString(),
        ...(updated.controllerProof === undefined ? {} : { controllerProof: updated.controllerProof }),
      };
      publishCheckRegistration(registry, registration);
      if (!registrationIsPresent(registry, registration))
        throw new Error('worker-check: check registration could not be verified');
    }
    record = updated;
    if (!updated.controllerProof) writeReadyReceipt(root, id, physicalRunId, { status: 'ready', physicalRunId });
  });
  if (!record) throw new Error('worker-check: runner did not acquire its physical identity');
  const finish = async (exitCode: number): Promise<void> => {
    await withCheckFence(root, id, () => {
      const current = readRecord(root, id);
      const physical = readPhysicalRecord(root, id, physicalRunId);
      if (!physical || !sameRunnerIdentity(physical.runnerIdentity, identity)) return;
      updatePhysicalRecord(root, id, physicalRunId, (latest) => ({
        ...latest,
        status: 'finished',
        exitCode: latest.exitCode ?? exitCode,
        finishedAt: latest.finishedAt ?? new Date().toISOString(),
      }));
      if (current.physicalRunId !== physicalRunId || current.status !== 'running') return;
      current.status = 'finished';
      current.exitCode = exitCode;
      writeRecord(current);
    });
  };
  if (initial.waitForPhysicalRunId) {
    const controller = new AbortController();
    let startupSignal: number | undefined;
    const forwarders = Object.entries(SIGNALS).map(([name, number]) => {
      const signal = name as keyof typeof SIGNALS;
      const forward = () => {
        startupSignal ??= number;
        controller.abort();
      };
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    try {
      await waitForPriorPhysicalRun(root, id, initial.waitForPhysicalRunId, physicalRunId, controller.signal);
    } catch (error) {
      const code = startupSignal === undefined ? (error instanceof CheckCancelled ? 125 : 1) : 128 + startupSignal;
      await finish(code);
      if (startupSignal !== undefined || error instanceof CheckCancelled) return code;
      throw error;
    } finally {
      for (const [signal, forward] of forwarders) process.off(signal, forward);
    }
  }
  try {
    const exitCode = await runWorkerCheck(
      executionArgv,
      root,
      false,
      join(root, record.log),
      60_000,
      id,
      record.reruns ?? 0,
      id,
      (record.reruns ?? 0) < 1,
      physicalRunId,
      async (start) => {
        return await withCheckFence(root, id, () => {
          const current = readRecord(root, id);
          if (
            executionCancellation(workerCheckCancellation(id, root)) ||
            checkCancelled(root, id) ||
            checkStopIntent(root, id, physicalRunId)
          )
            throw new CheckCancelled();
          if (current.status !== 'running' || current.physicalRunId !== physicalRunId) {
            throw new Error('worker-check: physical run changed before local command start');
          }
          validateProofRecord(current);
          return start();
        });
      },
      record.controllerProof
        ? () => writeReadyReceipt(root, id, physicalRunId, { status: 'ready', physicalRunId })
        : undefined,
    );
    await finish(exitCode);
    return exitCode;
  } catch (error) {
    const code = error instanceof CheckCancelled || checkCancelled(root, id) ? 125 : 1;
    await finish(code);
    if (error instanceof CheckSetupFailure) {
      if (record.controllerProof) {
        writeReadyReceipt(root, id, physicalRunId, { status: 'failed', physicalRunId, error: error.message });
      }
      return code;
    }
    if (error instanceof CheckCancelled) return 125;
    throw error;
  }
}

function parse(argv: string[]): string[] {
  const command = argv[0] === '--' ? argv.slice(1) : argv;
  if (command.length === 0) throw new Error('Usage: worker-check.ts [--local] [--returns <path>...] -- <command...>');
  return command;
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] === '--controller-proof') {
      if (!isCheckId(args[1]) || args[2] !== '--' || args.length < 4) {
        throw new Error('worker-check: --controller-proof requires a UUID token and -- <exact original argv...>');
      }
      const registry = registryForStart(process.env, ownershipFromEnvironment(process.env));
      if (!registry) throw new Error('worker-check: controller proof registry is unavailable');
      const reservation = proofReservation(registry, args[1]);
      const answer = await startControllerWorkerCheck({ ...reservation.binding, token: args[1], argv: args.slice(3) });
      process.stdout.write(`${JSON.stringify(answer)}\n`);
      process.exitCode = answer.outcome === 'unavailable' ? 2 : answer.outcome === 'refused-never-started' ? 1 : 0;
    } else if (args[0] === '--wait') {
      if (!args[1]) throw new Error('worker-check: --wait requires a check id');
      process.exitCode = await waitWorkerCheck(args[1]);
    } else if (args[0] === '--run') {
      if (args[1] === '--') {
        if (args.length <= 2) throw new Error('worker-check: --run -- requires a command');
        const id = startWorkerCheck(parse(args.slice(2)));
        process.stdout.write(`check: id ${id}\n`);
      } else {
        const id = args[1];
        if (!id || !isCheckId(id)) throw new Error(`Invalid check id: ${id ?? ''}`);
        let physicalRunId: string | undefined;
        if (args[2] !== undefined) {
          if (args[2] !== '--physical-run' || !isPhysicalRunId(args[3])) {
            throw new Error('worker-check: malformed detached runner identity');
          }
          physicalRunId = args[3];
          if (args.length !== 4) throw new Error('worker-check: unexpected detached runner arguments');
        }
        process.exitCode = await runRecordedCheck(id, process.cwd(), physicalRunId);
      }
    } else {
      const id = startWorkerCheck(parse(args));
      process.stdout.write(`check: id ${id}\n`);
    }
  } catch (error) {
    const args = Bun.argv.slice(2);
    if (args[0] === '--run' && args[1] && isCheckId(args[1])) {
      const record = (() => {
        try {
          return readRecord(process.cwd(), args[1]!);
        } catch {
          return undefined;
        }
      })();
      const physicalRunId = args[3] === '--physical-run' ? args[4] : record?.physicalRunId;
      if (record && isPhysicalRunId(physicalRunId)) {
        writeReadyReceipt(record.cwd, record.id, physicalRunId, {
          status: 'failed',
          physicalRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CheckCancelled ? 125 : 1;
  }
}
