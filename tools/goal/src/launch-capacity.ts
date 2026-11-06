import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { processIdentity, sameProcess } from './process.ts';
import type { Attempt, Task } from './types.ts';

export type HostCapacity = { maxWorkers: number; minAvailableMiB: number; urgentSlots?: number };
export type CapacityRelease = () => void;
/** Store methods admission reads; callers pass the live WorkerStore. */
export type HostCapacityStore = {
  capacityAttemptsCount(urgent: boolean, taskId?: string, attempt?: number): number;
  attempts(taskId: string): ReadonlyArray<Pick<Attempt, 'attempt' | 'state'>>;
  goalInFlightCount?(goal: string, excludeTaskId?: string): number;
  taskGoal?(taskId: string): string | undefined;
  taskSequence?(taskId: string): number | undefined;
  goalReadyTaskIdsBefore?(goal: string, sequence: number): readonly string[];
};

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
  const running = store.capacityAttemptsCount(false) + admittedStarts(stateDirectory);
  return hasCapacity(running, availableMiB(), capacity);
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
    availableMiB?: () => number;
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
  writeFileSync(join(queue, ticket), JSON.stringify({ ...owner, taskId, goal: options.goal, goalSequence }));
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
          !hostCapacity || (running + admitted + ahead < limit && memory >= capacity.minAvailableMiB);
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
