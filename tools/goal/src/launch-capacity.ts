import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { inspectProcessSnapshot, processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import type { Attempt, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import { StaleAttemptError } from './contracts.ts';
import type { CheckRecord, CheckPhysicalRecord } from '../../../scripts/worker-check.ts';
import {
  isCheckId,
  isPhysicalRunId,
  physicalHistoryPath,
  validateRunnerIdentity,
} from '../../../scripts/check-custody.ts';
import {
  pressureBrake,
  readHostPressure,
  workerHeadroomMiB,
  workerReservationMiB,
  HEAVY_WORKER_MIB,
  WORKER_SLICE_ROOT,
  reclaimCleanFileCache,
  type PressureBrake,
  type PressureSample,
} from './host-pressure.ts';

export type HostCapacity = { maxWorkers: number; minAvailableMiB: number; urgentSlots?: number };
export type CapacityRelease = () => void;
export type CapacityLifecycle = {
  currentAttempt: number;
  taskState: string;
  attemptState?: string;
  attemptStartedAt?: string;
  priorityHeadStart?: boolean;
};
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
  /** Direct current-generation projection used to discard superseded starts and distinguish parked resumes. */
  capacityLifecycle?(taskId: string): CapacityLifecycle | undefined;
};

type WorkerScopes = { parked: Set<string>; writers: Set<string>; active?: Set<string> };
function attemptKey(taskId: string, attempt: number): string {
  return JSON.stringify([taskId, attempt]);
}
function matchingRunnerIdentity(value: unknown, expected: ProcessIdentity): boolean {
  const identity = validateRunnerIdentity(value);
  return (
    identity.pid === expected.pid &&
    identity.start === expected.start &&
    identity.boot === expected.boot &&
    identity.group === expected.group
  );
}
/** Require the physical generation on the command line; legacy runners keep their conservative reserve. */
function detachedCheckRunner(identity: ProcessIdentity, worktree: string, id: string, physicalRunId: string): boolean {
  const args = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  return (
    identity.pid === identity.group &&
    args.length === 6 &&
    args[1] === join(worktree, 'scripts/worker-check.ts') &&
    args[2] === '--run' &&
    args[3] === id &&
    args[4] === '--physical-run' &&
    args[5] === physicalRunId
  );
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
  )
    return undefined;
  return scope;
}
/** Read only indexed live generations; unreconciled checks and scopes retain their writing reserve. */
function workerScopes(store: HostCapacityStore): WorkerScopes {
  const result: WorkerScopes = { parked: new Set(), writers: new Set() };
  if (!store.db) return result;
  result.active = new Set();
  let rows: { task_id: string; current_attempt: number; attempt_state: string; body: string; worktree: string }[];
  try {
    rows = store.db
      .query(`
    SELECT c.task_id, c.current_attempt, c.attempt_state, a.body, json_extract(t.body, '$.worktree') AS worktree
    FROM worker_current_attempts AS c INDEXED BY worker_current_attempts_state
    JOIN worker_attempts AS a ON a.task_id=c.task_id AND a.attempt=c.current_attempt
    JOIN worker_tasks AS t ON t.id=c.task_id AND t.current_attempt=c.current_attempt
    WHERE c.attempt_state IN ('running', 'waiting') AND c.task_state='running'
    `)
      .all() as typeof rows;
  } catch {
    // An unavailable projection grants no parked exemption or ticket transfer. Every running count keeps its reserve.
    return result;
  }
  for (const row of rows) {
    try {
      const attempt = JSON.parse(row.body) as Attempt;
      if (
        attempt.taskId !== row.task_id ||
        attempt.attempt !== row.current_attempt ||
        attempt.state !== row.attempt_state
      )
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
          const record = JSON.parse(
            readFileSync(join(row.worktree, '.temp/goal/checks/results', `${id}.json`), 'utf8'),
          ) as CheckRecord;
          if (
            record.id !== id ||
            record.cwd !== row.worktree ||
            record.status !== 'running' ||
            record.ownership?.taskId !== row.task_id ||
            record.ownership.attempt !== row.current_attempt ||
            record.runnerHost !== hostname() ||
            !record.runnerIdentity ||
            !isPhysicalRunId(record.physicalRunId)
          )
            continue;
          const identity = validateRunnerIdentity(record.runnerIdentity);
          const physical = JSON.parse(
            readFileSync(physicalHistoryPath(row.worktree, id, record.physicalRunId), 'utf8'),
          ) as CheckPhysicalRecord;
          if (
            physical.version !== 1 ||
            physical.cwd !== row.worktree ||
            physical.id !== id ||
            physical.physicalRunId !== record.physicalRunId ||
            physical.status !== 'running' ||
            physical.ownership?.taskId !== row.task_id ||
            physical.ownership.attempt !== row.current_attempt ||
            physical.runnerHost !== record.runnerHost ||
            physical.remoteExpected !== true ||
            !matchingRunnerIdentity(physical.runnerIdentity, identity) ||
            !detachedCheckRunner(identity, row.worktree, id, record.physicalRunId)
          )
            continue;
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
  const tickets = capacityTickets(stateDirectory, store);
  return (
    hasCapacity(
      running + admittedTicketCount(tickets),
      availableMiB(),
      capacity,
    ) &&
    !pressureBrake(readPressureBrake(stateDirectory), readHostPressure(), Date.now()).paused &&
    workerHeadroomMiB(running, WORKER_SLICE_ROOT, scopes.parked, scopes.active) >=
      admittedMemoryMiBFromTickets(tickets, scopes.writers) + HEAVY_WORKER_MIB
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
    reclaim?: (deficitMiB: number) => number | void;
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
  const ticket = `${String((options.now?.() ?? Date.now()) - (first ? policy.criticalHeadStartMs : 0)).padStart(15, '0')}.${String(++capacityTicketSequence).padStart(8, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
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
      operation: options.resume === true ? 'resume' : 'start',
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
      let reclaimDeficitMiB: number | undefined;
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
        const tickets = capacityTickets(stateDirectory, store);
        const mine = tickets.find((value) => value.queue === queue && value.name === ticket);
        if (!mine) {
          const lifecycle = taskId ? store.capacityLifecycle?.(taskId) : undefined;
          if (lifecycle && targetAttempt !== undefined)
            throw staleCapacityOperation(taskId!, targetAttempt, options.resume === true, lifecycle);
          throw new Error(`Capacity ticket disappeared while waiting: ${ticket}`);
        }
        const isOperationLeader = ticketLeader(tickets, mine);
        const admitted = hostCapacity ? admittedTicketCount(tickets, queueName(urgent)) : 0;
        const running = hostCapacity ? store.capacityAttemptsCount(urgent, taskId, targetAttempt) : 0;
        const otherRunning = hostCapacity ? store.capacityAttemptsCount(!urgent, taskId, targetAttempt) : 0;
        const otherAdmitted = hostCapacity ? admittedTicketCount(tickets, queueName(!urgent)) : 0;
        const brake = pressureBrake(
          readPressureBrake(stateDirectory),
          (options.pressure ?? readHostPressure)(),
          options.now?.() ?? Date.now(),
        );
        if (hostCapacity) writeFileSync(join(stateDirectory, 'capacity-pressure.json'), JSON.stringify(brake));
        const scopes = workerScopes(store);
        const sliceHeadroom = (options.workerHeadroomMiB ?? workerHeadroomMiB)(
          running + otherRunning,
          WORKER_SLICE_ROOT,
          scopes.parked,
          scopes.active,
        );
        const reservedMemoryMiB = admittedMemoryMiBFromTickets(tickets, scopes.writers);
        rearmReclaimEpisode(stateDirectory, sliceHeadroom, reservedMemoryMiB);
        const requiredMemoryMiB = reservedMemoryMiB + memoryReservation;
        const sliceAvailable = sliceHeadroom >= requiredMemoryMiB;
        const ahead = hostCapacity ? ticketWaitersAhead(tickets, mine) : 0;
        const limit = urgent ? capacity.urgentSlots : capacity.maxWorkers;
        const memory = hostCapacity ? (options.availableMiB ?? availableMiB)() : Number.POSITIVE_INFINITY;
        const goalInFlight = goalCap === undefined ? 0 : inFlightForGoal(store, options.goal!, options.excludeTaskId);
        const goalReservations =
          goalCap === undefined ? new Set<string>() : admittedGoalTasks(tickets, options.goal!, store);
        const goalAdmitted = goalReservations.size;
        const goalAhead =
          goalCap === undefined
            ? 0
            : goalWaitersAhead(tickets, mine, options.goal!, goalSequence, store, goalReservations);
        const hostGatesAvailable =
          !hostCapacity ||
          (running + admitted + ahead < limit &&
            running + otherRunning + admitted + otherAdmitted + ahead < capacity.maxWorkers &&
            memory >= capacity.minAvailableMiB &&
            !brake.paused);
        const hostAvailable = hostGatesAvailable && (!hostCapacity || sliceAvailable) && isOperationLeader;
        const goalAvailable = goalCap === undefined || goalInFlight + goalAdmitted + goalAhead < goalCap;
        if (hostAvailable && goalAvailable) {
          const reservation = join(queue, `${ticket}.admitted`);
          renameSync(join(queue, ticket), reservation);
          return releaseWhenStarted(
            store,
            reservation,
            taskId,
            targetAttempt,
            options.resume === true,
            policy.reservationPollMs,
          );
        }
        if (
          hostCapacity &&
          hostGatesAvailable &&
          goalAvailable &&
          isOperationLeader &&
          !sliceAvailable &&
          Number.isFinite(sliceHeadroom) &&
          claimReclaimEpisode(stateDirectory)
        )
          reclaimDeficitMiB = Math.max(1, Math.ceil(requiredMemoryMiB - sliceHeadroom));
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
      if (reclaimDeficitMiB !== undefined) {
        const sample = (options.pressure ?? readHostPressure)();
        const brake = pressureBrake(
          readPressureBrake(stateDirectory),
          sample,
          options.now?.() ?? Date.now(),
        );
        if (brake.paused) clearReclaimEpisode(stateDirectory);
        else (options.reclaim ?? ((deficit) => reclaimCleanFileCache(deficit)))(reclaimDeficitMiB);
        capacityChanged?.();
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
type TicketOperation = 'start' | 'resume';
type TicketMetadata = ProcessIdentity & {
  taskId?: string;
  attempt?: number;
  operation?: TicketOperation;
  resume?: boolean;
  goal?: string;
  goalSequence?: number;
  memoryMiB?: number;
};
type CapacityTicket = {
  lane: 'capacity-queue' | 'urgent-capacity-queue';
  queue: string;
  name: string;
  order: string;
  admitted: boolean;
  taskId?: string;
  attempt?: number;
  operation?: TicketOperation;
  key?: string;
  goal?: string;
  goalSequence?: number;
  memoryMiB?: number;
};
const CAPACITY_LANES = ['capacity-queue', 'urgent-capacity-queue'] as const;
const STARTABLE_TASK_STATES = new Set(['ready', 'held', 'running', 'landing', 'stopped', 'integrated', 'merged']);
let capacityTicketSequence = 0;

/** Charge one live reservation per task generation and operation until its exact writer scope takes over. */
export function admittedMemoryMiB(
  stateDirectory: string,
  writers: ReadonlySet<string>,
  store?: HostCapacityStore,
): number {
  return admittedMemoryMiBFromTickets(capacityTickets(stateDirectory, store), writers);
}
function admittedMemoryMiBFromTickets(tickets: readonly CapacityTicket[], writers: ReadonlySet<string>): number {
  let total = 0;
  const counted = new Set<string>();
  for (const ticket of tickets) {
    if (!ticket.admitted) continue;
    const key = ticket.key ?? `${ticket.lane}/${ticket.name}`;
    if (counted.has(key)) continue;
    counted.add(key);
    if (ticket.taskId && ticket.attempt !== undefined && writers.has(attemptKey(ticket.taskId, ticket.attempt)))
      continue;
    total += ticket.memoryMiB === 2048 ? 2048 : HEAVY_WORKER_MIB;
  }
  return total;
}
function ticketMetadata(queue: string, name: string): TicketMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(join(queue, name), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      pid: Number.isSafeInteger(record.pid) ? (record.pid as number) : 0,
      start: typeof record.start === 'string' ? record.start : '',
      boot: typeof record.boot === 'string' ? record.boot : '',
      group: Number.isSafeInteger(record.group) ? (record.group as number) : 0,
      ...(typeof record.taskId === 'string' && record.taskId ? { taskId: record.taskId } : {}),
      ...(Number.isSafeInteger(record.attempt) && (record.attempt as number) >= 0
        ? { attempt: record.attempt as number }
        : {}),
      ...(record.operation === 'start' || record.operation === 'resume' ? { operation: record.operation } : {}),
      ...(record.resume === true ? { resume: true } : {}),
      ...(typeof record.goal === 'string' ? { goal: record.goal } : {}),
      ...(Number.isSafeInteger(record.goalSequence) ? { goalSequence: record.goalSequence as number } : {}),
      ...(Number.isSafeInteger(record.memoryMiB) ? { memoryMiB: record.memoryMiB as number } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function ticketTaskId(queue: string, name: string, metadata = ticketMetadata(queue, name)): string | undefined {
  if (metadata?.taskId) return metadata.taskId;
  const parsed = name
    .replace(/\.admitted$/, '')
    .replace(/\.ticket-\d{8}-[a-f0-9]{8}$/, '')
    .split('-')
    .slice(2)
    .join('-');
  return parsed || undefined;
}
function queueName(urgent: boolean): CapacityTicket['lane'] {
  return urgent ? 'urgent-capacity-queue' : 'capacity-queue';
}
function lifecycleFor(
  store: HostCapacityStore | undefined,
  taskId: string | undefined,
  cache: Map<string, CapacityLifecycle | undefined>,
): CapacityLifecycle | undefined {
  if (!store || !taskId || !store.capacityLifecycle) return undefined;
  if (!cache.has(taskId)) cache.set(taskId, store.capacityLifecycle(taskId));
  return cache.get(taskId);
}
function legacyTicketOperation(
  metadata: TicketMetadata | undefined,
  attempt: number | undefined,
  lifecycle: CapacityLifecycle | undefined,
  order: string,
): TicketOperation | undefined {
  if (metadata?.operation) return metadata.operation;
  if (metadata?.resume === true) return 'resume';
  if (attempt === undefined) return undefined;
  if (
    metadata?.attempt !== undefined &&
    lifecycle?.currentAttempt === metadata.attempt &&
    lifecycle.attemptState === 'waiting'
  ) {
    const timestamp = Number(order.split('-')[0]?.split('.')[0]);
    const attemptStartedAt = Date.parse(lifecycle.attemptStartedAt ?? '');
    if (Number.isFinite(timestamp) && Number.isFinite(attemptStartedAt)) {
      const issuedAt = timestamp + (lifecycle.priorityHeadStart ? defaultPolicy.capacity.criticalHeadStartMs : 0);
      return issuedAt <= attemptStartedAt ? 'start' : 'resume';
    }
    return 'resume';
  }
  return 'start';
}
function ticketIsValid(ticket: CapacityTicket, lifecycle: CapacityLifecycle | undefined): boolean {
  if (!lifecycle || !ticket.taskId || ticket.attempt === undefined || !ticket.operation) return true;
  if (ticket.operation === 'resume')
    return (
      ticket.attempt === lifecycle.currentAttempt &&
      lifecycle.taskState === 'running' &&
      lifecycle.attemptState === 'waiting'
    );
  if (ticket.attempt === lifecycle.currentAttempt + 1)
    return STARTABLE_TASK_STATES.has(lifecycle.taskState);
  return (
    ticket.attempt === lifecycle.currentAttempt &&
    lifecycle.attemptState === 'pending' &&
    STARTABLE_TASK_STATES.has(lifecycle.taskState)
  );
}
function capacityTickets(stateDirectory: string, store?: HostCapacityStore): CapacityTicket[] {
  const tickets: CapacityTicket[] = [];
  const lifecycleCache = new Map<string, CapacityLifecycle | undefined>();
  for (const lane of CAPACITY_LANES) {
    const queue = join(stateDirectory, lane);
    let names: string[];
    try {
      names = readdirSync(queue).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!liveTicket(queue, name)) continue;
      const metadata = ticketMetadata(queue, name);
      const taskId = ticketTaskId(queue, name, metadata);
      const lifecycle = lifecycleFor(store, taskId, lifecycleCache);
      // Older first-start tickets omitted the target generation. They named attempt one; the lifecycle tells us
      // whether that initial start is still actionable. For ambiguous legacy tickets, issuance time distinguishes a
      // start created before this attempt from a later wake for its parked session.
      const attempt = metadata?.attempt ?? (taskId ? 1 : undefined);
      const order = name.replace(/\.admitted$/, '');
      const operation = legacyTicketOperation(metadata, attempt, lifecycle, order);
      const ticket: CapacityTicket = {
        lane,
        queue,
        name,
        order,
        admitted: name.endsWith('.admitted'),
        ...(taskId ? { taskId } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
        ...(operation ? { operation } : {}),
        ...(typeof metadata?.goal === 'string' ? { goal: metadata.goal } : {}),
        ...(Number.isSafeInteger(metadata?.goalSequence) ? { goalSequence: metadata!.goalSequence } : {}),
        ...(Number.isSafeInteger(metadata?.memoryMiB) ? { memoryMiB: metadata!.memoryMiB } : {}),
      };
      if (!ticketIsValid(ticket, lifecycle)) {
        rmSync(join(queue, name), { force: true });
        continue;
      }
      if (ticket.taskId && ticket.attempt !== undefined && ticket.operation)
        ticket.key = JSON.stringify([ticket.taskId, ticket.attempt, ticket.operation]);
      tickets.push(ticket);
    }
  }
  return tickets;
}
function ticketGroups(tickets: readonly CapacityTicket[]): Map<string, CapacityTicket[]> {
  const groups = new Map<string, CapacityTicket[]>();
  for (const ticket of tickets) {
    const key = ticket.key ?? `${ticket.lane}/${ticket.name}`;
    const group = groups.get(key) ?? [];
    group.push(ticket);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.order.localeCompare(b.order));
  return groups;
}
function ticketLeader(tickets: readonly CapacityTicket[], mine: CapacityTicket): boolean {
  if (!mine.key) return true;
  return ticketGroups(tickets).get(mine.key)?.[0] === mine;
}
function admittedTicketCount(tickets: readonly CapacityTicket[], lane?: CapacityTicket['lane']): number {
  let count = 0;
  for (const group of ticketGroups(tickets).values()) {
    const reservation = group.find((ticket) => ticket.admitted);
    if (reservation && (!lane || reservation.lane === lane)) count += 1;
  }
  return count;
}
function ticketWaitersAhead(tickets: readonly CapacityTicket[], mine: CapacityTicket): number {
  const ahead = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.lane !== mine.lane || ticket.admitted || ticket.order >= mine.order || ticket.key === mine.key) continue;
    ahead.add(ticket.key ?? `${ticket.lane}/${ticket.name}`);
  }
  return ahead.size;
}
function ticketGoal(ticket: CapacityTicket, store: HostCapacityStore): string | undefined {
  return ticket.goal ?? (ticket.taskId ? store.taskGoal?.(ticket.taskId) : undefined);
}
function ticketSequence(ticket: CapacityTicket, store: HostCapacityStore): number | undefined {
  return ticket.goalSequence ?? (ticket.taskId ? store.taskSequence?.(ticket.taskId) : undefined);
}
function admittedGoalTasks(
  tickets: readonly CapacityTicket[],
  goal: string,
  store: HostCapacityStore,
): Set<string> {
  const tasks = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.lane !== 'capacity-queue' || !ticket.admitted || ticketGoal(ticket, store) !== goal) continue;
    tasks.add(ticket.taskId ?? ticket.name);
  }
  return tasks;
}
function goalWaitersAhead(
  tickets: readonly CapacityTicket[],
  mine: CapacityTicket,
  goal: string,
  goalSequence: number | undefined,
  store: HostCapacityStore,
  reservations: ReadonlySet<string>,
): number {
  const ahead = new Set(goalSequence === undefined ? [] : (store.goalReadyTaskIdsBefore?.(goal, goalSequence) ?? []));
  for (const reserved of reservations) ahead.delete(reserved);
  for (const ticket of tickets) {
    if (ticket.lane !== 'capacity-queue' || ticket.admitted || ticketGoal(ticket, store) !== goal) continue;
    const sequence = ticketSequence(ticket, store);
    const isEarlier =
      goalSequence !== undefined && sequence !== undefined ? sequence < goalSequence : ticket.order < mine.order;
    if (isEarlier) ahead.add(ticket.taskId ?? ticket.order);
  }
  return ahead.size;
}
function reclaimEpisodeBlocked(stateDirectory: string): boolean {
  const path = join(stateDirectory, 'capacity-reclaim.json');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { blocked?: unknown };
    return value?.blocked === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof SyntaxError) return true;
    throw error;
  }
}
function rearmReclaimEpisode(stateDirectory: string, headroomMiB: number, admittedMemoryMiB: number): void {
  if (headroomMiB - admittedMemoryMiB < HEAVY_WORKER_MIB || !reclaimEpisodeBlocked(stateDirectory)) return;
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify({ blocked: false }));
}
function claimReclaimEpisode(stateDirectory: string): boolean {
  const path = join(stateDirectory, 'capacity-reclaim.json');
  if (reclaimEpisodeBlocked(stateDirectory)) return false;
  writeFileSync(path, JSON.stringify({ blocked: true }));
  return true;
}
function clearReclaimEpisode(stateDirectory: string): void {
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify({ blocked: false }));
}
function staleCapacityOperation(
  taskId: string,
  targetAttempt: number,
  resume: boolean,
  lifecycle: CapacityLifecycle,
): StaleAttemptError {
  return new StaleAttemptError(
    { taskId, attempt: resume ? targetAttempt : Math.max(0, targetAttempt - 1) },
    lifecycle.currentAttempt,
  );
}
function liveTicket(queue: string, name: string): boolean {
  const [, rawPid] = name.replace(/\.admitted$/, '').split('-');
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    rmSync(join(queue, name), { force: true });
    return false;
  }
  let snapshot: ReturnType<typeof inspectProcessSnapshot>;
  try {
    snapshot = inspectProcessSnapshot(pid, '/proc');
  } catch {
    // An unreadable process table is not evidence that a live ticket owner died.
    return true;
  }
  if (!snapshot || snapshot.dead) {
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
    return true;
  }
  try {
    const expected = JSON.parse(contents) as { pid?: unknown; start?: unknown; boot?: unknown; group?: unknown };
    if (expected.pid === pid && typeof expected.start === 'string' && typeof expected.boot === 'string') {
      if (
        snapshot.identity.start !== expected.start ||
        snapshot.identity.boot !== expected.boot ||
        (typeof expected.group === 'number' && snapshot.identity.group !== expected.group)
      ) {
        rmSync(join(queue, name), { force: true });
        return false;
      }
    }
  } catch {
    // Older queue tickets have no identity payload; keep their PID-based liveness behavior.
  }
  return true;
}
function releaseWhenStarted(
  store: HostCapacityStore,
  reservation: string,
  taskId: string | undefined,
  targetAttempt: number | undefined,
  resume: boolean,
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
    if (!identity) {
      release();
      return;
    }
    let currentOwner: ReturnType<typeof inspectProcessSnapshot>;
    try {
      currentOwner = inspectProcessSnapshot(identity.pid, '/proc');
    } catch {
      return;
    }
    if (
      !currentOwner ||
      currentOwner.dead ||
      currentOwner.identity.start !== identity.start ||
      currentOwner.identity.boot !== identity.boot ||
      currentOwner.identity.group !== identity.group
    ) {
      release();
      return;
    }
    if (!taskId) return;
    try {
      const attempts = store.attempts(taskId);
      const current =
        targetAttempt === undefined ? attempts.at(-1) : attempts.find((attempt) => attempt.attempt === targetAttempt);
      if (current && (resume ? current.state !== 'pending' && current.state !== 'waiting' : current.state !== 'pending'))
        release();
    } catch {
      // Callers release explicitly when preparation fails; transient store errors must not admit another start early.
    }
  }, pollIntervalMs);
  timer.unref();
  return release;
}
/** Task ids that have a live start or exact parked-resume contender. */
export function capacityWaiters(stateDirectory: string, store?: HostCapacityStore): Set<string> {
  return new Set(capacityTickets(stateDirectory, store).flatMap((ticket) => (ticket.taskId ? [ticket.taskId] : [])));
}
/** Live unique operations older than `ticket`; dead owners and superseded generations are removed. */
export function waitersAhead(queue: string, ticket: string, store?: HostCapacityStore): number {
  const tickets = store
    ? capacityTickets(dirname(queue), store).filter((value) => value.queue === queue)
    : queueTickets(queue);
  const target = tickets.find((value) => value.name === ticket || value.order === ticket);
  return ticketWaitersAhead(
    tickets,
    target ?? {
      lane: 'capacity-queue',
      queue,
      name: ticket,
      order: ticket.replace(/\.admitted$/, ''),
      admitted: false,
    },
  );
}
function queueTickets(queue: string): CapacityTicket[] {
  let names: string[];
  try {
    names = readdirSync(queue).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    if (!liveTicket(queue, name)) return [];
    const metadata = ticketMetadata(queue, name);
    const taskId = ticketTaskId(queue, name, metadata);
    const attempt = metadata?.attempt;
    const operation = metadata?.operation ?? (metadata?.resume === true ? 'resume' : attempt === undefined ? undefined : 'start');
    const ticket: CapacityTicket = {
      lane: basename(queue) === 'urgent-capacity-queue' ? 'urgent-capacity-queue' : 'capacity-queue',
      queue,
      name,
      order: name.replace(/\.admitted$/, ''),
      admitted: name.endsWith('.admitted'),
      ...(taskId ? { taskId } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(operation ? { operation } : {}),
    };
    if (ticket.taskId && ticket.attempt !== undefined && ticket.operation)
      ticket.key = JSON.stringify([ticket.taskId, ticket.attempt, ticket.operation]);
    return [ticket];
  });
}
