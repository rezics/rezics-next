import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hostname } from 'node:os';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import type { Attempt, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import type { CheckRecord, CheckPhysicalRecord } from '../../../scripts/worker-check.ts';
import { isCheckId, isPhysicalRunId, physicalHistoryPath, validateRunnerIdentity } from '../../../scripts/check-custody.ts';
import {
  pressureBrake,
  readHostPressure,
  workerHeadroomMiB,
  workerReservationMiB,
  HEAVY_WORKER_MIB,
  WORKER_SLICE_ROOT,
  type PressureBrake,
  type PressureSample,
} from './host-pressure.ts';

export type HostCapacity = { maxWorkers: number; minAvailableMiB: number; urgentSlots?: number };
export type CapacityRelease = () => void;
/** Store methods admission reads; callers pass the live WorkerStore. */
export type HostCapacityStore = {
  /** The indexed current-attempt projection is optional only for older or synthetic callers. */
  db?: WorkerStore['db'];
  capacityAttemptsCount(urgent: boolean, taskId?: string, attempt?: number): number;
  attempts(taskId: string): ReadonlyArray<Pick<Attempt, 'attempt' | 'state'>>;
  goalInFlightCount?(goal: string, excludeTaskId?: string): number;
  taskGoal?(taskId: string): string | undefined;
  taskSequence?(taskId: string): number | undefined;
  goalReadyTaskIdsBefore?(goal: string, sequence: number): readonly string[];
};

type WorkerScopes = { parked: Set<string>; writers: Set<string>; active?: Set<string> };
function attemptKey(taskId: string, attempt: number): string {
  return JSON.stringify([taskId, attempt]);
}
function matchingRunnerIdentity(value: unknown, expected: ProcessIdentity): boolean {
  const identity = validateRunnerIdentity(value);
  return identity.pid === expected.pid && identity.start === expected.start &&
    identity.boot === expected.boot && identity.group === expected.group;
}
/** Require the physical generation on the command line; legacy runners keep their conservative reserve. */
function detachedCheckRunner(identity: ProcessIdentity, worktree: string, id: string, physicalRunId: string): boolean {
  const args = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  return identity.pid === identity.group && args.length === 6 &&
    args[1] === join(worktree, 'scripts/worker-check.ts') && args[2] === '--run' && args[3] === id &&
    args[4] === '--physical-run' && args[5] === physicalRunId;
}
/** Require both process identity and its exact current owned cgroup; unit-name resemblance is insufficient. */
function ownedWorkerScope(identity: ProcessIdentity, taskId: string, attempt: number): string | undefined {
  if (!sameProcess(identity)) return undefined;
  const group = /^0::(.+)$/m.exec(readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8'))?.[1];
  const safeTask = taskId.replace(/[^A-Za-z0-9:_.-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  if (!group || !sameProcess(identity)) return undefined;
  const scope = basename(group);
  if (
    join('/sys/fs/cgroup', group) !== join(WORKER_SLICE_ROOT, scope) ||
    !scope.startsWith(`rezics-worker-${safeTask}-${attempt}-`) ||
    !/^[a-z0-9]+\.scope$/.test(scope.slice(`rezics-worker-${safeTask}-${attempt}-`.length))
  ) return undefined;
  return scope;
}
/** Read only indexed live generations; unreconciled checks and scopes retain their writing reserve. */
function workerScopes(store: HostCapacityStore): WorkerScopes {
  const result: WorkerScopes = { parked: new Set(), writers: new Set() };
  if (!store.db) return result;
  result.active = new Set();
  let rows: { task_id: string; current_attempt: number; attempt_state: string; body: string; worktree: string }[];
  try {
    rows = store.db.query(`
    SELECT c.task_id, c.current_attempt, c.attempt_state, a.body, json_extract(t.body, '$.worktree') AS worktree
    FROM worker_current_attempts AS c INDEXED BY worker_current_attempts_state
    JOIN worker_attempts AS a ON a.task_id=c.task_id AND a.attempt=c.current_attempt
    JOIN worker_tasks AS t ON t.id=c.task_id AND t.current_attempt=c.current_attempt
    WHERE c.attempt_state IN ('running', 'waiting') AND c.task_state='running'
    `).all() as typeof rows;
  } catch {
    // An unavailable projection grants no parked exemption or ticket transfer. Every running count keeps its reserve.
    return result;
  }
  for (const row of rows) {
    try {
      const attempt = JSON.parse(row.body) as Attempt;
      if (attempt.taskId !== row.task_id || attempt.attempt !== row.current_attempt || attempt.state !== row.attempt_state)
        continue;
      const writer = attempt.process && ownedWorkerScope(attempt.process, row.task_id, row.current_attempt);
      if (attempt.state === 'running') {
        if (!writer) continue;
        result.writers.add(attemptKey(row.task_id, row.current_attempt));
        result.active.add(writer);
      } else if (attempt.process !== null) continue;
      for (const id of attempt.checks ?? []) {
        if (!isCheckId(id)) continue;
        try {
          const record = JSON.parse(readFileSync(join(row.worktree, '.temp/goal/checks/results', `${id}.json`), 'utf8')) as CheckRecord;
          if (record.id !== id || record.cwd !== row.worktree || record.status !== 'running' ||
              record.ownership?.taskId !== row.task_id || record.ownership.attempt !== row.current_attempt ||
              record.runnerHost !== hostname() || !record.runnerIdentity || !isPhysicalRunId(record.physicalRunId)) continue;
          const identity = validateRunnerIdentity(record.runnerIdentity);
          const physical = JSON.parse(readFileSync(physicalHistoryPath(row.worktree, id, record.physicalRunId), 'utf8')) as CheckPhysicalRecord;
          if (physical.version !== 1 || physical.cwd !== row.worktree ||
              physical.id !== id || physical.physicalRunId !== record.physicalRunId || physical.status !== 'running' ||
              physical.ownership?.taskId !== row.task_id || physical.ownership.attempt !== row.current_attempt ||
              physical.runnerHost !== record.runnerHost || physical.remoteExpected !== true ||
              !matchingRunnerIdentity(physical.runnerIdentity, identity) ||
              !detachedCheckRunner(identity, row.worktree, id, record.physicalRunId)) continue;
          const scope = ownedWorkerScope(identity, row.task_id, row.current_attempt);
          // A running session can share a scope with its check. It releases no writing reserve until parked,
          // or until a resumed writer is positively identified in a different, newly launched scope.
          if (scope && scope !== writer) result.parked.add(scope);
        } catch {
          // Missing, stale or legacy custody is deliberately conservative.
        }
      }
    } catch {
      // Unknown worker identity cannot release a reservation.
    }
  }
  // Even contradictory ownership must never exempt a scope containing a positively identified current writer.
  for (const scope of result.active) result.parked.delete(scope);
  return result;
}

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
  store: HostCapacityStore,
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
  const running = store.capacityAttemptsCount(false) + store.capacityAttemptsCount(true);
  const scopes = workerScopes(store);
  return (
    hasCapacity(
      running + admittedStarts(stateDirectory) + admittedStarts(stateDirectory, true),
      availableMiB(),
      capacity,
    ) &&
    !pressureBrake(readPressureBrake(stateDirectory), readHostPressure(), Date.now()).paused &&
    workerHeadroomMiB(running, WORKER_SLICE_ROOT, scopes.parked, scopes.active) >=
      admittedMemoryMiB(stateDirectory, scopes.writers) + HEAVY_WORKER_MIB
  );
}
/** Stabilize and critical-path starts receive a bounded queue head start while respecting host capacity. */
export function startsFirst(task: Pick<Task, 'taskClass' | 'brief'>): boolean {
  return task.taskClass === 'critical-path' || task.brief.criticalPath === true || task.brief.target === 'stabilize';
}
function inFlightForGoal(store: HostCapacityStore, goal: string, excludeTaskId?: string): number {
  if (!store.goalInFlightCount) throw new Error('Goal start admission requires a Goal in-flight counter');
  return store.goalInFlightCount(goal, excludeTaskId);
}
/**
 * A worker starts only while the host has room: at most maxWorkers running and at least minAvailableMiB of memory
 * available. Otherwise it waits; it is never refused. Fifty-two workers on this host exhausted memory and swap and
 * killed unrelated processes (2026-10-27). `<state>/capacity.json` overrides the defaults and is read on every check.
 */
export async function awaitHostCapacity(
  store: HostCapacityStore,
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
    goal?: string | undefined;
    goalSequence?: number | undefined;
    goalMaxInFlight?: number | undefined;
    excludeTaskId?: string | undefined;
    /** A check wake launches a new scope and must reserve its full active minimum before spawning. */
    resume?: boolean;
    availableMiB?: () => number;
    pressure?: () => PressureSample;
    workerHeadroomMiB?: typeof workerHeadroomMiB;
  } = {},
): Promise<CapacityRelease> {
  const policy = options.policy ?? defaultPolicy.capacity;
  const urgent = options.urgent === true;
  const goalCap =
    !urgent && options.goal && options.goal !== 'control-plane'
      ? (options.goalMaxInFlight ?? defaultPolicy.goalMaxInFlight)
      : undefined;
  // Host-wide admission opts in with <state>/capacity.json; the per-Goal rule also applies without that file.
  const file = join(stateDirectory, 'capacity.json');
  if (!existsSync(file) && !urgent && goalCap === undefined) return () => {};
  // Waiters hold tickets so the oldest starts first: polling alone let a start wait over an hour behind newer ones.
  const queue = join(stateDirectory, urgent ? 'urgent-capacity-queue' : 'capacity-queue');
  // The ticket names its task, so the host can tell a waiting start from a lost one. Critical-path starts used to skip
  // the cap and the queue; with most backend tasks critical path the running count stayed above the cap and ordinary
  // starts (most web tasks) waited for days (2026-10-29). Every start now respects the cap; critical path only dates
  // its ticket half an hour earlier, so it goes ahead of recent waiters without starving older ones.
  const ticket = `${String((options.now?.() ?? Date.now()) - (first ? policy.criticalHeadStartMs : 0)).padStart(15, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
  const goalSequence = taskId ? (options.goalSequence ?? store.taskSequence?.(taskId)) : options.goalSequence;
  mkdirSync(queue, { recursive: true });
  const owner = processIdentity();
  if (!owner) throw new Error('Cannot identify capacity ticket owner');
  const memoryReservation = options.resume
    ? HEAVY_WORKER_MIB
    : workerReservationMiB(options.goal ?? (taskId ? store.taskGoal?.(taskId) : undefined));
  writeFileSync(
    join(queue, ticket),
    JSON.stringify({
      ...owner,
      taskId,
      attempt: targetAttempt,
      goal: options.goal,
      goalSequence,
      memoryMiB: memoryReservation,
    }),
  );
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
        if (!existsSync(file) && !urgent && goalCap === undefined) return () => {};
        let capacity = policy;
        try {
          capacity = { ...policy, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<HostCapacity>) };
        } catch {
          /* Defaults. */
        }
        const hostCapacity = existsSync(file) || urgent;
        const admitted = hostCapacity ? admittedStarts(stateDirectory, urgent) : 0;
        const running = hostCapacity ? store.capacityAttemptsCount(urgent, taskId, targetAttempt) : 0;
        const otherRunning = hostCapacity ? store.capacityAttemptsCount(!urgent, taskId, targetAttempt) : 0;
        const otherAdmitted = hostCapacity ? admittedStarts(stateDirectory, !urgent) : 0;
        const brake = pressureBrake(
          readPressureBrake(stateDirectory),
          (options.pressure ?? readHostPressure)(),
          options.now?.() ?? Date.now(),
        );
        if (hostCapacity) writeFileSync(join(stateDirectory, 'capacity-pressure.json'), JSON.stringify(brake));
        const scopes = workerScopes(store);
        const sliceAvailable =
          (options.workerHeadroomMiB ?? workerHeadroomMiB)(
            running + otherRunning, WORKER_SLICE_ROOT, scopes.parked, scopes.active,
          ) >=
          admittedMemoryMiB(stateDirectory, scopes.writers) + memoryReservation;
        const ahead = hostCapacity ? waitersAhead(queue, ticket) : 0;
        const limit = urgent ? capacity.urgentSlots : capacity.maxWorkers;
        const memory = hostCapacity ? (options.availableMiB ?? availableMiB)() : Number.POSITIVE_INFINITY;
        const goalInFlight = goalCap === undefined ? 0 : inFlightForGoal(store, options.goal!, options.excludeTaskId);
        const goalReservations =
          goalCap === undefined ? new Set<string>() : admittedGoalTasks(stateDirectory, options.goal!, store);
        const goalAdmitted = goalReservations.size;
        const goalAhead =
          goalCap === undefined
            ? 0
            : goalWaitersAhead(queue, ticket, options.goal!, goalSequence, store, goalReservations);
        const hostAvailable =
          !hostCapacity ||
          (running + admitted + ahead < limit &&
            running + otherRunning + admitted + otherAdmitted + ahead < capacity.maxWorkers &&
            memory >= capacity.minAvailableMiB &&
            !brake.paused &&
            sliceAvailable);
        const goalAvailable = goalCap === undefined || goalInFlight + goalAdmitted + goalAhead < goalCap;
        if (hostAvailable && goalAvailable) {
          const reservation = join(queue, `${ticket}.admitted`);
          renameSync(join(queue, ticket), reservation);
          return releaseWhenStarted(store, reservation, taskId, targetAttempt, policy.reservationPollMs);
        }
        if (!reported)
          console.error(
            goalCap !== undefined && !goalAvailable
              ? `Waiting for Goal ${options.goal} start capacity (${goalInFlight} in flight, ${goalAdmitted + goalAhead} starts ahead, cap ${goalCap}).`
              : urgent
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
function readPressureBrake(stateDirectory: string): PressureBrake {
  try {
    const value = JSON.parse(readFileSync(join(stateDirectory, 'capacity-pressure.json'), 'utf8'));
    return {
      paused: value.paused === true,
      ...(Number.isFinite(value.healthySince) ? { healthySince: value.healthySince } : {}),
    };
  } catch {
    return { paused: false };
  }
}
function admittedMemoryMiB(stateDirectory: string, writers: ReadonlySet<string>): number {
  let total = 0;
  for (const lane of ['capacity-queue', 'urgent-capacity-queue']) {
    const queue = join(stateDirectory, lane);
    if (!existsSync(queue)) continue;
    for (const name of readdirSync(queue)) {
      if (!name.endsWith('.admitted') || !liveTicket(queue, name)) continue;
      try {
        const value = JSON.parse(readFileSync(join(queue, name), 'utf8'));
        // Once the exact current writer has a reconciled scope, headroom owns its reserve. Pending/waiting,
        // unknown identities and old tickets keep their charge until explicit release or observed start.
        if (typeof value.taskId === 'string' && Number.isSafeInteger(value.attempt) &&
            writers.has(attemptKey(value.taskId, value.attempt))) continue;
        total += value.memoryMiB === 2048 ? 2048 : HEAVY_WORKER_MIB;
      } catch {
        total += HEAVY_WORKER_MIB;
      }
    }
  }
  return total;
}
function ticketMetadata(
  queue: string,
  name: string,
): { goal?: string; taskId?: string; goalSequence?: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(queue, name), 'utf8')) as {
      goal?: unknown;
      taskId?: unknown;
      goalSequence?: unknown;
    } | null;
    if (!value || typeof value !== 'object') return undefined;
    return {
      ...(typeof value.goal === 'string' ? { goal: value.goal } : {}),
      ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
      ...(Number.isSafeInteger(value.goalSequence) ? { goalSequence: value.goalSequence as number } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function ticketGoal(queue: string, name: string, store: HostCapacityStore): string | undefined {
  const metadata = ticketMetadata(queue, name);
  if (metadata?.goal) return metadata.goal;
  const taskId = ticketTaskId(queue, name);
  return taskId ? store.taskGoal?.(taskId) : undefined;
}
function ticketSequence(queue: string, name: string, store: HostCapacityStore): number | undefined {
  const metadata = ticketMetadata(queue, name);
  if (metadata?.goalSequence !== undefined) return metadata.goalSequence;
  const taskId = ticketTaskId(queue, name);
  return taskId ? store.taskSequence?.(taskId) : undefined;
}
function ticketTaskId(queue: string, name: string): string | undefined {
  const metadata = ticketMetadata(queue, name);
  if (metadata?.taskId) return metadata.taskId;
  const parsed = name
    .replace(/\.admitted$/, '')
    .split('-')
    .slice(2)
    .join('-');
  return parsed || undefined;
}
function admittedGoalTasks(stateDirectory: string, goal: string, store: HostCapacityStore): Set<string> {
  const queue = join(stateDirectory, 'capacity-queue');
  try {
    const tasks = new Set<string>();
    for (const name of readdirSync(queue)) {
      if (!name.endsWith('.admitted') || !liveTicket(queue, name) || ticketGoal(queue, name, store) !== goal) continue;
      tasks.add(ticketTaskId(queue, name) ?? name);
    }
    return tasks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}
function goalWaitersAhead(
  queue: string,
  ticket: string,
  goal: string,
  goalSequence: number | undefined,
  store: HostCapacityStore,
  reservations: ReadonlySet<string>,
): number {
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const ahead = new Set(goalSequence === undefined ? [] : (store.goalReadyTaskIdsBefore?.(goal, goalSequence) ?? []));
  for (const reserved of reservations) ahead.delete(reserved);
  for (const name of names) {
    const baseName = name.replace(/\.admitted$/, '');
    if (name.endsWith('.admitted') || !liveTicket(queue, name) || ticketGoal(queue, name, store) !== goal) continue;
    const sequence = ticketSequence(queue, name, store);
    const isEarlier =
      goalSequence !== undefined && sequence !== undefined ? sequence < goalSequence : baseName < ticket;
    if (isEarlier) ahead.add(ticketTaskId(queue, name) ?? baseName);
  }
  return ahead.size;
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
  store: HostCapacityStore,
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
