import { defaultPolicy, type ControlPolicy } from './policy.ts';
import {
  proofSourceUnchanged,
  registeredProof,
  type ProofAuthorization,
  type ProofReservation,
} from './verification.ts';
import { type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { NO_COMPILE_CACHE, remoteCheckEnvironment } from './merge.ts';
import { temporaryEnvironment } from '../../../scripts/tmp-janitor.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  processIdentity,
  sameProcess,
  terminateProcessGroup,
  waitForWorkerExit,
  workerExitPath,
  getProcessOwnershipAdapter,
  type ProcessIdentity,
  type WorkerExit,
} from './process.ts';
import type { Attempt, Brief, Pool, Profile, Settings, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import { recordFlow } from './flow.ts';
import { launchWorkerProcess } from './worker-slice.ts';
import { agentAdapter, cleanAgentEnvironment, type McpServer } from './agents.ts';
import { type LaunchContext } from './launch-context.ts';
import { storybookServers } from './storybook.ts';
import { branchHead } from './attempt-progress.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import {
  applyRenderedPrompt,
  minimalVerification as promptMinimalVerification,
  renderCheckProtocol,
  renderWorkerPrompt,
} from './prompts.ts';
export { applyRenderedPrompt, renderWorkerPrompt };

export type LaunchOptions = {
  profile: Profile;
  pool: Pool;
  worktree: string;
  prompt: string;
  promptViaStdin?: boolean;
  logPath?: string;
  readOnly?: boolean;
  research?: boolean;
  consultation?: boolean;
  /** A fresh, bounded train editing session through an adapter that supports it. */
  resolver?: boolean;
  codex?: Settings['codex'];
  mcpServers?: readonly McpServer[];
  resumeSession?: string;
};
export function launchCommand(
  options: LaunchOptions,
  resolveAdapter: typeof agentAdapter = agentAdapter,
): [string, string[]] {
  const { profile, pool } = options;
  if (pool.cli !== profile.cli) throw new Error('profile and pool CLI disagree');
  const adapter = resolveAdapter(profile.cli);
  if (options.resolver) {
    if (options.resumeSession) throw new Error('Train resolution requires a fresh session');
    if (!adapter.supportsResolver) throw new Error('Agent adapter does not support train resolution');
  }
  if (options.resumeSession && adapter.canResume) return adapter.resume({ ...options, session: options.resumeSession });
  const { resumeSession: _session, ...fresh } = options;
  return adapter.start(fresh);
}
export function workerEnvironment(
  pool: Pool,
  extra: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
  worktree?: string,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) if (key.startsWith('GOAL_')) delete env[key];
  const result = agentAdapter(pool.cli).environment(pool, {
    ...cleanAgentEnvironment(env),
    ...NO_COMPILE_CACHE,
    ...extra,
    ...(worktree ? temporaryEnvironment(join(worktree, '.temp/worker-tmp')) : {}),
  });
  const wrapperDirectory = worktree && join(worktree, 'scripts', 'check-host');
  if (wrapperDirectory && existsSync(join(wrapperDirectory, 'docker')))
    result.PATH = [wrapperDirectory, result.PATH].filter(Boolean).join(':');
  return result;
}
type CheckProtocolBrief = Pick<Brief, 'acceptance' | 'markdown'> & Partial<Brief>;
/** Whether `<state>/verification-mode` asks for source completion and typing, with original acceptance deferred. */
export function minimalVerification(stateDirectory: string | undefined): boolean {
  return promptMinimalVerification(stateDirectory);
}
/** Current execution and result policy, repeated at every prompt boundary. */
export function workerCheckProtocol(
  worktree: string,
  briefOrContract: CheckProtocolBrief | string = '',
  stateDirectory?: string,
  proofRun?: ProofReservation,
  authorization?: ProofAuthorization,
  policy: ControlPolicy = defaultPolicy,
): string {
  return renderCheckProtocol(worktree, briefOrContract, stateDirectory, proofRun, authorization, policy);
}
export function workerPrompt(
  task: Task,
  evidence: string | undefined,
  consultation: string | undefined,
  resolutionFiles: readonly string[],
  mainCheckout: string,
  launchContext?: LaunchContext,
  stateDirectory = join(mainCheckout, '.temp', 'goal'),
  policy: ControlPolicy = defaultPolicy,
): string {
  return renderWorkerPrompt({
    task,
    evidence,
    consultation,
    resolutionFiles,
    mainCheckout,
    launchContext,
    stateDirectory,
    policy,
  }).prompt;
}
/** Per-attempt variables: the attempt's identity, and the base the kernel check selects affected tests against. */
export function attemptEnvironment(
  task: Pick<Task, 'id' | 'base'> & Partial<Pick<Task, 'proofRun'>>,
  attempt: Pick<Attempt, 'attempt'>,
  stateDirectory?: string,
): Record<string, string> {
  return {
    GOAL_TASK_ID: task.id,
    GOAL_ATTEMPT: String(attempt.attempt),
    ...(task.proofRun?.native && task.proofRun.binding.attempt === attempt.attempt
      ? { GOAL_CHECK_REGISTRY: task.proofRun.native.registry }
      : {}),
    // The check runner selects affected tests itself and refuses a caller-supplied base.
    // Fedora's /etc/profile.d/debuginfod.sh exports an absolute certificate path into every login shell unless the
    // variable is already non-empty; Web checks refuse absolute host paths, so give it an inert relative value.
    DEBUGINFOD_IMA_CERT_PATH: 'none',
    // Fedora's gmpopenh264 profile appends to this one, so a relative head keeps the whole value relative.
    MOZ_GMP_PATH: 'none',
    // Fedora's nano-default-editor profile exports an absolute EDITOR unless one is set; a command name keeps it relative.
    EDITOR: 'nano',
    ...remoteCheckEnvironment(stateDirectory),
    // The worker check wrapper appends its full wait here, in milliseconds per line; the class limit adds it back.
    ...(stateDirectory
      ? { GOAL_CHECK_WAIT_FILE: join(stateDirectory, 'runs', task.id, `${attempt.attempt}.check-wait`) }
      : {}),
  };
}
/** Milliseconds an attempt's checks spent waiting for a slot, as its check tools recorded them beside the run log. */
export function checkWaitMs(logPath: string): number {
  try {
    return readFileSync(logPath.replace(/\.jsonl$/, '.check-wait'), 'utf8')
      .split('\n')
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0);
  } catch {
    return 0;
  }
}
/** Reconstruct the current prompt's clock, including on adoption; earlier turns cannot buy this turn silence. */
export function workerActivityBaseline(store: WorkerStore, ref: Attempt, now = Date.now()) {
  const event = store.events(ref.taskId, ref.attempt).findLast((event) => event.kind === 'worker-run-started');
  let metadata: { logStartOffset?: unknown; checkWaitBaseline?: unknown } = {};
  try {
    metadata = event ? JSON.parse(event.body) : {};
    if (!metadata || typeof metadata !== 'object') metadata = {};
  } catch {
    // Imported attempts may have no prompt-boundary metadata.
  }
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const logStartOffset = nonnegative(metadata.logStartOffset) ? (metadata.logStartOffset as number) : 0;
  const checkWaitBaseline =
    typeof metadata.checkWaitBaseline === 'number' &&
    Number.isFinite(metadata.checkWaitBaseline) &&
    metadata.checkWaitBaseline >= 0
      ? metadata.checkWaitBaseline
      : 0;
  const recordedStart = event ? Date.parse(event.at) : NaN;
  const startedAt = Number.isFinite(recordedStart)
    ? Math.max(Date.parse(ref.startedAt), Math.min(now, recordedStart))
    : Date.parse(ref.startedAt);
  const stat = statSync(ref.logPath, { throwIfNoEntry: false });
  const lastLogSize = stat?.size ?? 0;
  const lastLogMtime = stat?.mtimeMs ?? 0;
  const lastLogActivityAt =
    lastLogSize > logStartOffset ? Math.max(startedAt, Math.min(now, lastLogMtime || now)) : startedAt;
  const totalWait = checkWaitMs(ref.logPath);
  // Preserve waits already recorded during the silent interval, capped to that interval and this prompt's waits.
  const creditedWait = Math.min(Math.max(0, totalWait - checkWaitBaseline), Math.max(0, now - lastLogActivityAt));
  return {
    startedAt,
    logStartOffset,
    checkWaitBaseline,
    lastLogSize,
    lastLogMtime,
    lastLogActivityAt,
    checkWaitAtLastLogActivity: totalWait - creditedWait,
  };
}
export type RunningWorker = {
  child?: ChildProcess;
  exited: Promise<WorkerExit>;
  attempt: Attempt;
  /** Byte offset in the appended run log where this process began writing. */
  logStartOffset?: number;
  /** Whether this process resumed the previous agent session. */
  resuming?: boolean;
};
/**
 * A user systemd scope is the worker's lifecycle boundary; detaching the worker from this process alone is not enough
 * to survive a manager-host restart. Inside that scope, the wrapper forks twice, so the worker is reparented away from
 * its launcher and becomes a session leader. The intermediate process publishes its pid before it exits. When the
 * CLI ends, the wrapper records its exit code or signal beside the run log.
 */
const WRAPPER = `import os,sys,json,signal,subprocess
exit_path,pid_path=sys.argv[1:3]
r,w=os.pipe()
if os.fork():
 os.close(w)
 pid=os.read(r,32)
 if not pid: sys.exit(1)
 open(pid_path,'w').write(pid.decode())
 os._exit(0)
os.close(r)
os.setsid()
os.write(w,str(os.getpid()).encode())
os.close(w)
code,sig=None,None
try:
 status=subprocess.Popen(sys.argv[3:]).wait()
 if status<0: sig=signal.Signals(-status).name
 else: code=status
except OSError:
 code=127
open(exit_path+'.tmp','w').write(json.dumps({'code':code,'signal':sig}))
os.rename(exit_path+'.tmp',exit_path)
`;
export type HostCapacity = { maxWorkers: number; minAvailableMiB: number; urgentSlots?: number };
export type CapacityRelease = () => void;

/** Whether one more worker may start: below the worker cap and above the memory floor. */
export function hasCapacity(running: number, availableMiB: number, capacity: HostCapacity): boolean {
  return running < capacity.maxWorkers && availableMiB >= capacity.minAvailableMiB;
}
function availableMiB(): number {
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  // Linux reports kB; admission settings use MiB.
  return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
}
/** Whether an ordinary start could begin now, without waiting; a host without capacity.json always has room. */
export function capacityAvailable(
  store: WorkerStore,
  stateDirectory: string,
  policy = defaultPolicy.capacity,
): boolean {
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file)) return true;
  let capacity = policy;
  try {
    capacity = { ...policy, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
  } catch {
    /* Defaults. */
  }
  const running = store.capacityAttemptsCount(false) + admittedStarts(stateDirectory);
  return hasCapacity(running, availableMiB(), capacity);
}
/** Stabilize and critical-path starts receive a bounded queue head start while respecting host capacity. */
export function startsFirst(task: Pick<Task, 'taskClass' | 'brief'>): boolean {
  return task.taskClass === 'critical-path' || task.brief.criticalPath === true || task.brief.target === 'stabilize';
}
/**
 * A worker starts only while the host has room: at most maxWorkers running and at least minAvailableMiB of memory
 * available. Otherwise it waits; it is never refused. Fifty-two workers on this host exhausted memory and swap and
 * killed unrelated processes (2026-10-27). `<state>/capacity.json` overrides the defaults and is read on every check.
 */
export async function awaitHostCapacity(
  store: WorkerStore,
  stateDirectory: string,
  first = false,
  taskId?: string,
  targetAttempt?: number,
  options: {
    pollIntervalMs?: number;
    now?: () => number;
    policy?: ControlPolicy['capacity'] | undefined;
    leasePolicy?: ControlPolicy['leases'] | undefined;
    urgent?: boolean | undefined;
    availableMiB?: () => number;
  } = {},
): Promise<CapacityRelease> {
  const policy = options.policy ?? defaultPolicy.capacity;
  const urgent = options.urgent === true;
  // A host opts in with <state>/capacity.json; without it nothing waits (tests, and hosts that pace by other means).
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file) && !urgent) return () => {};
  // Waiters hold tickets so the oldest starts first: polling alone let a start wait over an hour behind newer ones.
  const queue = join(stateDirectory, urgent ? 'urgent-capacity-queue' : 'capacity-queue');
  // The ticket names its task, so the host can tell a waiting start from a lost one. Critical-path starts used to skip
  // the cap and the queue; with most backend tasks critical path the running count stayed above the cap and ordinary
  // starts (most web tasks) waited for days (2026-10-29). Every start now respects the cap; critical path only dates
  // its ticket half an hour earlier, so it goes ahead of recent waiters without starving older ones.
  const ticket = `${String((options.now?.() ?? Date.now()) - (first ? policy.criticalHeadStartMs : 0)).padStart(15, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
  mkdirSync(queue, { recursive: true });
  const owner = processIdentity();
  if (!owner) throw new Error('Cannot identify capacity ticket owner');
  writeFileSync(join(queue, ticket), JSON.stringify(owner));
  let reported = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityChanged: (() => void) | undefined;
  try {
    // Watch the directory so atomic replacements and removal wake waiters too. Subscribe before checking capacity
    // so a policy change between the check and the wait cannot be lost. Worker/memory changes still use polling.
    watcher = watch(stateDirectory, (_event, name) => {
      if (name === null || String(name) === 'capacity.json') capacityChanged?.();
    });
    watcher.on('error', () => watcher?.close());
    for (;;) {
      const changed = new Promise<void>((resolve) => {
        capacityChanged = resolve;
      });
      let admissionLease: ReturnType<typeof acquireDirectoryLease>;
      try {
        admissionLease = acquireDirectoryLease(join(stateDirectory, 'capacity-admission-lock'), options.leasePolicy);
      } catch (error) {
        if (!(error instanceof LeaseHeldError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, policy.admissionRetryMs));
        continue;
      }
      try {
        if (!existsSync(file) && !urgent) return () => {};
        let capacity = policy;
        try {
          capacity = { ...policy, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
        } catch {
          /* Defaults. */
        }
        const admitted = admittedStarts(stateDirectory, urgent);
        const running = store.capacityAttemptsCount(urgent, taskId, targetAttempt);
        const ahead = waitersAhead(queue, ticket);
        const limit = urgent ? capacity.urgentSlots : capacity.maxWorkers;
        const memory = (options.availableMiB ?? availableMiB)();
        if (running + admitted + ahead < limit && memory >= capacity.minAvailableMiB) {
          const reservation = join(queue, `${ticket}.admitted`);
          renameSync(join(queue, ticket), reservation);
          return releaseWhenStarted(store, reservation, taskId, targetAttempt, policy.reservationPollMs);
        }
        if (!reported)
          console.error(
            urgent
              ? `Waiting for urgent host capacity (${running} urgent workers, ${ahead} urgent starts ahead, slots ${limit}; available memory ${Math.floor(memory)} MiB, floor ${capacity.minAvailableMiB} MiB).`
              : `Waiting for host capacity (${running} workers running, ${ahead} starts ahead, cap ${capacity.maxWorkers}).`,
          );
        reported = true;
      } finally {
        admissionLease.release();
      }
      await Promise.race([
        changed,
        new Promise<void>((resolve) => {
          pollTimer = setTimeout(resolve, Math.max(1, options.pollIntervalMs ?? policy.pollIntervalMs));
        }),
      ]);
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  } finally {
    watcher?.close();
    clearTimeout(pollTimer);
    rmSync(join(queue, ticket), { force: true });
  }
}
function admittedStarts(stateDirectory: string, urgent = false): number {
  const queue = join(stateDirectory, urgent ? 'urgent-capacity-queue' : 'capacity-queue');
  try {
    return readdirSync(queue).filter((name) => name.endsWith('.admitted') && liveTicket(queue, name)).length;
  } catch {
    return 0;
  }
}
function liveTicket(queue: string, name: string): boolean {
  const [, rawPid] = name.replace(/\.admitted$/, '').split('-');
  const pid = Number(rawPid);
  const identity = processIdentity(pid);
  if (!identity) {
    rmSync(join(queue, name), { force: true });
    return false;
  }
  let contents: string;
  try {
    contents = readFileSync(join(queue, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      rmSync(join(queue, name), { force: true });
      return false;
    }
    return sameProcess(identity);
  }
  try {
    const expected = JSON.parse(contents) as { pid?: unknown; start?: unknown; boot?: unknown; group?: unknown };
    if (expected.pid === pid && typeof expected.start === 'string' && typeof expected.boot === 'string') {
      if (
        identity.start !== expected.start ||
        identity.boot !== expected.boot ||
        (typeof expected.group === 'number' && identity.group !== expected.group)
      ) {
        rmSync(join(queue, name), { force: true });
        return false;
      }
    }
  } catch {
    // Older queue tickets have no identity payload; keep their PID-based liveness behavior.
  }
  if (sameProcess(identity)) return true;
  rmSync(join(queue, name), { force: true });
  return false;
}
function releaseWhenStarted(
  store: WorkerStore,
  reservation: string,
  taskId: string | undefined,
  targetAttempt: number | undefined,
  pollIntervalMs: number,
): CapacityRelease {
  const [, rawPid] = basename(reservation).split('-');
  const identity = processIdentity(Number(rawPid));
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    rmSync(reservation, { force: true });
  };
  timer = setInterval(() => {
    if (!identity || !sameProcess(identity)) {
      release();
      return;
    }
    if (!taskId) return;
    try {
      const attempts = store.attempts(taskId);
      const current =
        targetAttempt === undefined ? attempts.at(-1) : attempts.find((attempt) => attempt.attempt === targetAttempt);
      if (current && current.state !== 'pending' && current.state !== 'waiting') {
        release();
      }
    } catch {
      // Callers release explicitly when preparation fails; transient store errors must not admit another start early.
    }
  }, pollIntervalMs);
  timer.unref();
  return release;
}
/** Task ids that a live process is waiting to start, from the capacity queue's tickets. */
export function capacityWaiters(stateDirectory: string): Set<string> {
  return new Set(
    ['capacity-queue', 'urgent-capacity-queue'].flatMap((lane) => [...laneWaiters(join(stateDirectory, lane))]),
  );
}
function laneWaiters(queue: string): Set<string> {
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch {
    return new Set();
  }
  const live = new Set<string>();
  for (const name of names) {
    const [, , ...rest] = name.replace(/\.admitted$/, '').split('-');
    if (liveTicket(queue, name)) live.add(rest.join('-'));
  }
  return live;
}
/** Live waiters whose tickets are older than `ticket`; a ticket whose process has ended is removed. */
export function waitersAhead(queue: string, ticket: string): number {
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch {
    return 0;
  }
  return names.filter((name) => {
    const baseName = name.replace(/\.admitted$/, '');
    if (baseName >= ticket || name.endsWith('.admitted')) return false;
    return liveTicket(queue, name);
  }).length;
}
export async function launch(
  store: WorkerStore,
  task: Task,
  attempt: Attempt,
  pool: Pool,
  prompt: string,
  codex?: Settings['codex'],
  resumeSession?: string,
  policy: ControlPolicy = defaultPolicy,
): Promise<RunningWorker> {
  if (!agentAdapter(attempt.profile.cli).canResume) resumeSession = undefined;
  store.assertCurrent(attempt);
  if (
    task.brief.kind === 'verification' &&
    (!registeredProof(task.brief, task.proofAuthorization) ||
      !proofSourceUnchanged(task, task.proofAuthorization?.integrationBranch ?? '', policy.proof))
  )
    throw new Error('Proof execution unavailable: authenticated exact read-only source registration required');
  recordFlow(store.db, {
    taskId: attempt.taskId,
    attempt: attempt.attempt,
    stage: 'start',
    action: 'requested',
    at: new Date().toISOString(),
  });
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  const exitPath = workerExitPath(attempt.logPath),
    pidPath = `${attempt.logPath}.pid`;
  const ownership = getProcessOwnershipAdapter();
  ownership.assertWorkerLaunchAllowed(attempt.logPath);
  for (const path of [exitPath, `${exitPath}.tmp`, pidPath]) rmSync(path, { force: true });
  const resuming = Boolean(resumeSession);
  // The branch head at this prompt; the first prompt's head tells whether the attempt made a new commit.
  const startHead = branchHead(task);
  const ownerDecisionPrompt = prepareOwnerDecisionPrompt(store, task, attempt, prompt, policy);
  const logStartOffset = resuming ? (statSync(attempt.logPath, { throwIfNoEntry: false })?.size ?? 0) : 0;
  const out = openSync(attempt.logPath, resumeSession ? 'a' : 'w'),
    err = openSync(`${attempt.logPath}.err`, 'w');
  const [program, args] = launchCommand({
    profile: attempt.profile,
    pool,
    worktree: task.worktree,
    prompt: ownerDecisionPrompt.prompt,
    mcpServers: storybookServers(task.worktree, task.brief),
    ...(resumeSession ? { resumeSession } : {}),
    logPath: attempt.logPath,
    ...(codex ? { codex } : {}),
    // Research clones and reads reference projects and lands its report, so it needs the same access as other work.
    // Keyed on the brief's kind: a research brief that declares a risk area or cites sources routes as a claim.
    ...(task.brief.kind === 'research' ? { research: true } : {}),
  });
  const env = workerEnvironment(
    pool,
    attemptEnvironment(task, attempt, dirname(dirname(dirname(attempt.logPath)))),
    process.env,
    task.worktree,
  );
  let unrecordedWorker: ProcessIdentity | null = null;
  try {
    // Publication and spawn share the fence's write lock. A retry cannot miss a just-started process.
    store.write(attempt, () => {
      store.event(attempt, 'worker-run-started', {
        logStartOffset,
        resuming,
        checkWaitBaseline: checkWaitMs(attempt.logPath),
        branchHead: startHead,
      });
      const driver = processIdentity();
      if (!driver) throw new Error('Cannot identify driver process');
      // The wrapper cannot report a missing program to the launcher, so refuse it here.
      if (!Bun.which(program, { PATH: env.PATH ?? '', cwd: task.worktree }))
        throw new Error(`Worker CLI not found: ${program}`);
      const wrapperArgs = ['-c', WRAPPER, exitPath, pidPath, program, ...args];
      const startOptions: SpawnSyncOptions = {
        cwd: task.worktree,
        stdio: ['ignore', out, err],
        env,
      };
      const started = launchWorkerProcess(
        task.id,
        attempt.attempt,
        'python3',
        wrapperArgs,
        startOptions,
        () => existsSync(pidPath) || existsSync(exitPath),
        policy.workerResources,
      );
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : 0;
      const identity = processIdentity(pid);
      // A systemd-run client may fail after the wrapper published its identity. Adopt that process instead of
      // treating it as a pre-start failure and risking a second launch during recovery.
      const wrapperStarted = Boolean(identity || existsSync(exitPath));
      if (identity) {
        unrecordedWorker = identity;
        ownership.workerStarted(attempt.logPath, identity);
        unrecordedWorker = null;
      }
      if (!wrapperStarted) {
        if (started.error) throw started.error;
        throw new Error(`Worker wrapper failed to start (exit ${started.status})`);
      }
      store.updateAttempt(attempt, (current) => {
        current.driver = driver;
        current.process = identity;
        current.state = 'running';
      });
      store.updateTask(attempt, (current) => {
        current.state = 'running';
      });
      if (ownerDecisionPrompt.delivery) store.recordOwnerDecisionDelivery(attempt, ownerDecisionPrompt.delivery);
    });
  } catch (error) {
    if (unrecordedWorker) {
      try {
        await terminateProcessGroup(unrecordedWorker, policy.worker.fixtureCleanupGraceMs, policy.process);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'fixture ownership failed and its worker could not be reaped');
      }
    }
    throw error;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const saved = store.attempt(attempt);
  const exited = waitForWorkerExit(saved.process, attempt.logPath, policy.process);
  void exited.catch(() => {});
  return { exited, attempt: saved, logStartOffset, resuming };
}
