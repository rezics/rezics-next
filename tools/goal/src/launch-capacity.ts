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
  workerScopeIncarnation,
  HEAVY_WORKER_MIB,
  WORKER_SLICE_ROOT,
  reclaimCleanFileCacheEvidence,
  workerMemoryCurrentMiB,
  type CacheReclaimRequest,
  type PressureBrake,
  type PressureSample,
  type WorkerScopeIncarnation,
} from './host-pressure.ts';

export type HostCapacity = { maxWorkers: number; minAvailableMiB: number; urgentSlots?: number };
export type CapacityRelease = (() => void) & { ticketId?: string };
const RECLAIM_RETRY_COOLDOWN_MS = 1_000;
const RECLAIM_OBSERVATION_DELTA_MIB = 64;
const MAX_RECLAIM_ATTEMPTS = 3;
type ReclaimOutcome = 'pending' | 'progress' | 'no-progress' | 'eagain' | 'unavailable' | 'legacy' | 'invalid';
type ReclaimAttempt = {
  id: string;
  at: number;
  outcome: ReclaimOutcome;
  headroomBeforeMiB: number;
  headroomAfterMiB: number;
  memoryCurrentBeforeMiB: number | null;
  memoryCurrentAfterMiB: number | null;
  reservedMemoryMiB: number | null;
  runningCount: number | null;
  terminalScopes: string[];
  requestedMiB: number;
  memoryProgressMiB: number;
  errorCode?: string;
};
type ReclaimEpisode = { version: 1; history: ReclaimAttempt[] };
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

type WorkerScopes = {
  parked: Map<string, WorkerScopeIncarnation>;
  terminal: Set<string>;
  writers: Set<string>;
  waitCauses: string[];
  active?: Map<string, WorkerScopeIncarnation>;
};
type RetiredCheckProof = {
  id: string;
  physicalRunId: string;
  runnerIdentity: ProcessIdentity;
  checkStartedAt: string;
};
type RetiredWorkerScope = {
  taskId: string;
  attempt: number;
  worktree: string;
  name: string;
  incarnation: WorkerScopeIncarnation;
  checks: RetiredCheckProof[];
};
type RetiredScopeLedger = { version: 1; scopes: RetiredWorkerScope[] };
const RETIRED_SCOPE_FILE = 'capacity-retired-scopes.json';
function custodyEvidenceFailure(error: unknown): string | undefined {
  if (error instanceof SyntaxError) return 'custody record is malformed';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO'].includes(code ?? ''))
    return `custody evidence is unavailable (${code})`;
  if (error instanceof Error && error.message === 'worker-check: invalid runner identity')
    return 'runner identity is malformed';
  if (error instanceof Error && error.message.startsWith('process visibility unknown for PID '))
    return 'local runner visibility is unknown';
  return undefined;
}
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
/** A missing or changed PID incarnation proves local terminality; unreadable /proc remains unknown. */
function recordedRunnerTerminal(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  const current = inspectProcessSnapshot(identity.pid, procRoot);
  return !current || current.dead || !matchingRunnerIdentity(current.identity, identity);
}
/** Require the physical generation on the command line; legacy runners keep their conservative reserve. */
function detachedCheckRunner(
  identity: ProcessIdentity,
  worktree: string,
  id: string,
  physicalRunId: string,
  procRoot = '/proc',
): boolean {
  const args = readFileSync(`${procRoot}/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
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
function ownedWorkerScope(
  identity: ProcessIdentity,
  taskId: string,
  attempt: number,
  root = WORKER_SLICE_ROOT,
  procRoot = '/proc',
  cgroupRoot = '/sys/fs/cgroup',
): string | undefined {
  if (!sameProcess(identity, procRoot)) return undefined;
  const group = /^0::(.+)$/m.exec(readFileSync(`${procRoot}/${identity.pid}/cgroup`, 'utf8'))?.[1];
  const safeTask = taskId.replace(/[^A-Za-z0-9:_.-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  if (!group || !sameProcess(identity, procRoot)) return undefined;
  const scope = basename(group);
  if (
    join(cgroupRoot, group) !== join(root, scope) ||
    !scope.startsWith(`rezics-worker-${safeTask}-${attempt}-`) ||
    !/^[a-z0-9]+\.scope$/.test(scope.slice(`rezics-worker-${safeTask}-${attempt}-`.length))
  )
    return undefined;
  return scope;
}
/** Read only indexed live generations; unreconciled checks and scopes retain their writing reserve. */
function workerScopePrefix(taskId: string, attempt: number): string | undefined {
  const safeTask = taskId.replace(/[^A-Za-z0-9:_.-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  // Sanitized names can collide. Such legacy identities remain charged instead of claiming a neighbouring task.
  if (safeTask !== taskId) return undefined;
  return `rezics-worker-${safeTask}-${attempt}-`;
}
function historicalWorkerScopes(root: string, taskId: string, attempt: number): string[] {
  const prefix = workerScopePrefix(taskId, attempt);
  if (!prefix) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.startsWith(prefix) && /^[a-z0-9]+\.scope$/.test(name.slice(prefix.length)));
}
function sameScopeIncarnation(left: WorkerScopeIncarnation, right: WorkerScopeIncarnation): boolean {
  return left.device === right.device && left.inode === right.inode && left.ctimeNs === right.ctimeNs;
}
function retirementKey(value: Pick<RetiredWorkerScope, 'taskId' | 'attempt' | 'name'>): string {
  return JSON.stringify([value.taskId, value.attempt, value.name]);
}
function validScopeIncarnation(value: unknown): value is WorkerScopeIncarnation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['device', 'inode', 'ctimeNs'].every(
    (key) => typeof record[key] === 'string' && /^\d+$/.test(record[key] as string),
  );
}
function readRetiredScopeLedger(stateDirectory: string): { scopes: RetiredWorkerScope[]; malformed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(stateDirectory, RETIRED_SCOPE_FILE), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scopes: [], malformed: false };
    if (error instanceof SyntaxError) return { scopes: [], malformed: true };
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { scopes: [], malformed: true };
  const ledger = parsed as Record<string, unknown>;
  if (ledger.version !== 1 || !Array.isArray(ledger.scopes)) return { scopes: [], malformed: true };
  const scopes: RetiredWorkerScope[] = [];
  const seen = new Set<string>();
  for (const item of ledger.scopes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { scopes: [], malformed: true };
    const record = item as Record<string, unknown>;
    if (
      typeof record.taskId !== 'string' ||
      !record.taskId ||
      !Number.isSafeInteger(record.attempt) ||
      Number(record.attempt) < 1 ||
      typeof record.worktree !== 'string' ||
      !record.worktree ||
      typeof record.name !== 'string' ||
      !validScopeIncarnation(record.incarnation) ||
      !Array.isArray(record.checks) ||
      record.checks.length === 0
    )
      return { scopes: [], malformed: true };
    const attempt = Number(record.attempt);
    const prefix = workerScopePrefix(record.taskId, attempt);
    if (!prefix || !record.name.startsWith(prefix) || !/^[a-z0-9]+\.scope$/.test(record.name.slice(prefix.length)))
      return { scopes: [], malformed: true };
    const checks: RetiredCheckProof[] = [];
    for (const check of record.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) return { scopes: [], malformed: true };
      const proof = check as Record<string, unknown>;
      if (
        typeof proof.id !== 'string' ||
        !isCheckId(proof.id) ||
        typeof proof.physicalRunId !== 'string' ||
        !isPhysicalRunId(proof.physicalRunId) ||
        typeof proof.checkStartedAt !== 'string' ||
        !Number.isFinite(Date.parse(proof.checkStartedAt))
      )
        return { scopes: [], malformed: true };
      let runnerIdentity: ProcessIdentity;
      try {
        runnerIdentity = validateRunnerIdentity(proof.runnerIdentity);
      } catch {
        return { scopes: [], malformed: true };
      }
      checks.push({
        id: proof.id,
        physicalRunId: proof.physicalRunId,
        runnerIdentity,
        checkStartedAt: proof.checkStartedAt,
      });
    }
    const retired = {
      taskId: record.taskId,
      attempt,
      worktree: record.worktree,
      name: record.name,
      incarnation: record.incarnation,
      checks,
    } satisfies RetiredWorkerScope;
    const key = retirementKey(retired);
    if (seen.has(key)) return { scopes: [], malformed: true };
    seen.add(key);
    scopes.push(retired);
  }
  return { scopes, malformed: false };
}
function writeRetiredScopeLedger(stateDirectory: string, scopes: Iterable<RetiredWorkerScope>): void {
  const file = join(stateDirectory, RETIRED_SCOPE_FILE);
  const ordered = [...scopes].sort((left, right) => left.name.localeCompare(right.name));
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, scopes: ordered } satisfies RetiredScopeLedger));
  renameSync(temporary, file);
}
function scopePredatesChecks(incarnation: WorkerScopeIncarnation, checks: readonly RetiredCheckProof[]): boolean {
  let earliestCheckStart = Number.POSITIVE_INFINITY;
  for (const check of checks) {
    const startedAt = Date.parse(check.checkStartedAt);
    if (!Number.isFinite(startedAt)) return false;
    earliestCheckStart = Math.min(earliestCheckStart, startedAt);
  }
  if (!Number.isFinite(earliestCheckStart)) return false;
  const earliestCheckStartNs = BigInt(earliestCheckStart) * 1_000_000n;
  return BigInt(incarnation.ctimeNs) < earliestCheckStartNs;
}
type WorkerScopeOptions = {
  root?: string;
  stateDirectory?: string;
  procRoot?: string;
  cgroupRoot?: string;
  persistRetirements?: boolean;
};
function workerScopes(store: HostCapacityStore, options: WorkerScopeOptions = {}): WorkerScopes {
  const root = options.root ?? WORKER_SLICE_ROOT;
  const procRoot = options.procRoot ?? '/proc';
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  const result: WorkerScopes = {
    parked: new Map(),
    terminal: new Set(),
    writers: new Set(),
    waitCauses: [],
  };
  if (!store.db) {
    result.waitCauses.push('current worker/check projection is unavailable; scope reserves retained');
    return result;
  }
  result.active = new Map();
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
  } catch (error) {
    // An unavailable projection grants no parked exemption or ticket transfer. Every running count keeps its reserve.
    const reason = error instanceof Error ? error.message : String(error);
    result.waitCauses.push(`current worker/check projection is unavailable (${reason}); scope reserves retained`);
    return result;
  }
  const ledgerRead = options.stateDirectory
    ? readRetiredScopeLedger(options.stateDirectory)
    : { scopes: [], malformed: false };
  const retirements = new Map(ledgerRead.scopes.map((scope) => [retirementKey(scope), scope]));
  const initialLedger = JSON.stringify([...retirements.values()].sort((a, b) => a.name.localeCompare(b.name)));
  if (ledgerRead.malformed) result.waitCauses.push('retired-scope evidence is malformed; scope reserves retained');
  const unknownWriterGenerations = new Set<string>();
  const currentWorktrees = new Map<string, string>();
  for (const row of rows) {
    const generation = attemptKey(row.task_id, row.current_attempt);
    if (typeof row.worktree === 'string' && row.worktree.length > 0) currentWorktrees.set(generation, row.worktree);
    try {
      const attempt = JSON.parse(row.body) as Attempt;
      if (
        attempt.taskId !== row.task_id ||
        attempt.attempt !== row.current_attempt ||
        attempt.state !== row.attempt_state
      ) {
        unknownWriterGenerations.add(generation);
        continue;
      }
      const writer =
        attempt.process &&
        ownedWorkerScope(attempt.process, row.task_id, row.current_attempt, root, procRoot, cgroupRoot);
      if (attempt.state === 'running') {
        if (!writer) unknownWriterGenerations.add(generation);
        else {
          const incarnation = workerScopeIncarnation(root, writer);
          if (!incarnation) unknownWriterGenerations.add(generation);
          else {
            result.writers.add(generation);
            result.active.set(writer, incarnation);
          }
        }
      } else if (attempt.process !== null) {
        unknownWriterGenerations.add(generation);
        continue;
      }
      let allChecksTerminal =
        attempt.state === 'waiting' && attempt.process === null && (attempt.checks?.length ?? 0) > 0;
      const terminalChecks: RetiredCheckProof[] = [];
      for (const id of attempt.checks ?? []) {
        const note = (cause: string) => {
          const detail = `attempt ${row.task_id}/${row.current_attempt} check ${id}: ${cause}`;
          if (!result.waitCauses.includes(detail)) result.waitCauses.push(detail);
          unknownWriterGenerations.add(generation);
        };
        if (!isCheckId(id)) {
          allChecksTerminal = false;
          note('check identity is unavailable');
          continue;
        }
        if (typeof row.worktree !== 'string' || row.worktree.length === 0) {
          allChecksTerminal = false;
          note('worktree path is unavailable; scope reserve retained');
          continue;
        }
        try {
          const record = JSON.parse(
            readFileSync(join(row.worktree, '.temp/goal/checks/results', `${id}.json`), 'utf8'),
          ) as CheckRecord;
          if (
            record.id !== id ||
            record.cwd !== row.worktree ||
            record.ownership?.taskId !== row.task_id ||
            record.ownership.attempt !== row.current_attempt
          ) {
            allChecksTerminal = false;
            note('result ownership is missing or stale; scope reserve retained');
            continue;
          }
          if (record.status === 'finished') {
            if (!isPhysicalRunId(record.physicalRunId)) {
              allChecksTerminal = false;
              note('finished result has no physical run identity; scope reserve retained');
              continue;
            }
            const physical = JSON.parse(
              readFileSync(physicalHistoryPath(row.worktree, id, record.physicalRunId), 'utf8'),
            ) as CheckPhysicalRecord;
            const identity = validateRunnerIdentity(physical.runnerIdentity);
            if (
              physical.version !== 1 ||
              physical.cwd !== row.worktree ||
              physical.id !== id ||
              physical.physicalRunId !== record.physicalRunId ||
              physical.ownership?.taskId !== row.task_id ||
              physical.ownership.attempt !== row.current_attempt ||
              physical.runnerHost !== hostname() ||
              physical.remoteExpected !== true ||
              !['finished', 'unknown'].includes(physical.status) ||
              physical.terminalProof?.local !== true ||
              typeof physical.createdAt !== 'string' ||
              !Number.isFinite(Date.parse(physical.createdAt)) ||
              (record.runnerHost !== undefined && record.runnerHost !== physical.runnerHost) ||
              (record.runnerIdentity !== undefined && !matchingRunnerIdentity(record.runnerIdentity, identity)) ||
              !recordedRunnerTerminal(identity, procRoot) ||
              !Number.isSafeInteger(record.exitCode)
            ) {
              allChecksTerminal = false;
              note('local terminal proof or exact physical ownership is unavailable; scope reserve retained');
              continue;
            }
            // Remote terminality and cleanup stay independent. Local proof only retires this scope's future writer reserve.
            terminalChecks.push({
              id,
              physicalRunId: record.physicalRunId,
              runnerIdentity: identity,
              checkStartedAt: physical.createdAt,
            });
            continue;
          }
          allChecksTerminal = false;
          if (
            record.status !== 'running' ||
            record.runnerHost !== hostname() ||
            !record.runnerIdentity ||
            !isPhysicalRunId(record.physicalRunId)
          ) {
            note('live or replacement check identity is ambiguous; scope reserve retained');
            continue;
          }
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
            !detachedCheckRunner(identity, row.worktree, id, record.physicalRunId, procRoot)
          ) {
            note('live or replacement check custody is ambiguous; scope reserve retained');
            continue;
          }
          const scope = ownedWorkerScope(identity, row.task_id, row.current_attempt, root, procRoot, cgroupRoot);
          // A running session can share a scope with its check. It releases no writing reserve until parked,
          // or until a resumed writer is positively identified in a different, newly launched scope.
          if (scope && scope !== writer) {
            const incarnation = workerScopeIncarnation(root, scope);
            if (incarnation) result.parked.set(scope, incarnation);
            else note('live check scope identity is unavailable; scope reserve retained');
          } else note('live check scope ownership is unavailable; scope reserve retained');
        } catch (error) {
          const cause = custodyEvidenceFailure(error);
          if (!cause) throw error;
          allChecksTerminal = false;
          note(`${cause}; scope reserve retained`);
        }
      }
      if (allChecksTerminal) {
        if (!workerScopePrefix(row.task_id, row.current_attempt)) {
          const detail = `attempt ${row.task_id}/${row.current_attempt}: task identity cannot map to a unique worker scope; scope reserve retained`;
          if (!result.waitCauses.includes(detail)) result.waitCauses.push(detail);
        } else {
          for (const scope of historicalWorkerScopes(root, row.task_id, row.current_attempt)) {
            const incarnation = workerScopeIncarnation(root, scope);
            if (!incarnation) continue;
            if (!scopePredatesChecks(incarnation, terminalChecks)) {
              const detail = `attempt ${row.task_id}/${row.current_attempt}: scope ${scope} does not predate its finished checks; scope reserve retained`;
              if (!result.waitCauses.includes(detail)) result.waitCauses.push(detail);
              continue;
            }
            const retired: RetiredWorkerScope = {
              taskId: row.task_id,
              attempt: row.current_attempt,
              worktree: row.worktree,
              name: scope,
              incarnation,
              checks: terminalChecks,
            };
            retirements.set(retirementKey(retired), retired);
          }
        }
      }
    } catch (error) {
      const cause = custodyEvidenceFailure(error);
      if (!cause) throw error;
      // Unknown worker identity cannot release a reservation.
      const detail = `attempt ${row.task_id}/${row.current_attempt}: ${cause}; scope reserve retained`;
      if (!result.waitCauses.includes(detail)) result.waitCauses.push(detail);
      unknownWriterGenerations.add(generation);
    }
  }
  for (const [key, retired] of retirements) {
    const incarnation = workerScopeIncarnation(root, retired.name);
    if (
      !incarnation ||
      !sameScopeIncarnation(incarnation, retired.incarnation) ||
      !scopePredatesChecks(retired.incarnation, retired.checks)
    ) {
      retirements.delete(key);
      continue;
    }
    const generation = attemptKey(retired.taskId, retired.attempt);
    const currentWorktree = currentWorktrees.get(generation);
    if (currentWorktree !== undefined && currentWorktree !== retired.worktree) {
      retirements.delete(key);
      continue;
    }
    if (unknownWriterGenerations.has(generation)) continue;
    result.parked.set(retired.name, incarnation);
    result.terminal.add(retired.name);
  }
  // Even contradictory ownership must never exempt a scope containing a positively identified current writer.
  for (const scope of result.active.keys()) result.parked.delete(scope);
  if (options.persistRetirements && options.stateDirectory) {
    const nextLedger = JSON.stringify([...retirements.values()].sort((a, b) => a.name.localeCompare(b.name)));
    if (nextLedger !== initialLedger || ledgerRead.malformed)
      writeRetiredScopeLedger(options.stateDirectory, retirements.values());
  }
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
  const scopes = workerScopes(store, { stateDirectory });
  const tickets = capacityTickets(stateDirectory, store);
  return (
    hasCapacity(running + admittedTicketCount(tickets), availableMiB(), capacity) &&
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
    /** Only a terminal check for this exact waiting attempt may outrank recent fresh starts. */
    resumeReadyOperationId?: string;
    resumeTicketId?: string;
    onWaitReasons?: (reasons: readonly string[]) => void;
    availableMiB?: () => number;
    pressure?: () => PressureSample;
    workerHeadroomMiB?: typeof workerHeadroomMiB;
    /** Test and host adapter seams; no persistent capacity configuration is added. */
    workerSliceRoot?: string;
    workerProcessRoot?: string;
    workerCgroupRoot?: string;
    memoryCurrentMiB?: () => number | undefined;
    reclaim?: (deficitMiB: number) => number | void | CacheReclaimRequest;
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
  const queuedAt = options.now?.() ?? Date.now();
  const ticket = `${String(queuedAt - (first ? policy.criticalHeadStartMs : 0)).padStart(15, '0')}.${String(++capacityTicketSequence).padStart(8, '0')}-${process.pid}-${taskId ?? crypto.randomUUID()}`;
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
      queuedAt,
      priorityHeadStart: first,
      operation: options.resume === true ? 'resume' : 'start',
      ...(options.resumeReadyOperationId ? { resumeReadyOperationId: options.resumeReadyOperationId } : {}),
      ...(options.resumeTicketId ? { resumeTicketId: options.resumeTicketId } : {}),
      ...(options.resumeReadyOperationId && options.resume === true ? { resumePriority: true } : {}),
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
      let reclaimAttemptId: string | undefined;
      let reclaimMemoryCurrentBeforeMiB: number | undefined;
      let reclaimHeadroomBeforeMiB = 0;
      let reclaimHeadroomAfter: (() => number) | undefined;
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
        const now = options.now?.() ?? Date.now();
        const pressure = (options.pressure ?? readHostPressure)();
        const brake = pressureBrake(readPressureBrake(stateDirectory), pressure, now);
        if (hostCapacity) writeFileSync(join(stateDirectory, 'capacity-pressure.json'), JSON.stringify(brake));
        const sliceRoot = options.workerSliceRoot ?? WORKER_SLICE_ROOT;
        const scopes = workerScopes(store, {
          root: sliceRoot,
          stateDirectory,
          ...(options.workerProcessRoot === undefined ? {} : { procRoot: options.workerProcessRoot }),
          ...(options.workerCgroupRoot === undefined ? {} : { cgroupRoot: options.workerCgroupRoot }),
          persistRetirements: true,
        });
        const sliceHeadroom = (options.workerHeadroomMiB ?? workerHeadroomMiB)(
          running + otherRunning,
          sliceRoot,
          scopes.parked,
          scopes.active,
        );
        const reservedMemoryMiB = admittedMemoryMiBFromTickets(tickets, scopes.writers);
        const requiredMemoryMiB = reservedMemoryMiB + memoryReservation;
        const sliceAvailable = sliceHeadroom >= requiredMemoryMiB;
        const ahead = hostCapacity ? ticketWaitersAhead(tickets, mine, now, policy.criticalHeadStartMs) : 0;
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
        const memoryCurrentMiB = (options.memoryCurrentMiB ?? (() => workerMemoryCurrentMiB(sliceRoot)))();
        const reclaimSnapshot = {
          memoryCurrentMiB,
          reservedMemoryMiB,
          runningCount: running + otherRunning,
          terminalScopes: [...scopes.terminal].sort(),
          headroomMiB: sliceHeadroom,
        };
        let reclaimEpisode = hostCapacity ? readReclaimEpisode(stateDirectory) : undefined;
        if (hostCapacity && sliceHeadroom - reservedMemoryMiB >= HEAVY_WORKER_MIB)
          reclaimEpisode = rearmReclaimEpisode(stateDirectory, reclaimEpisode);
        const hostAvailable = hostGatesAvailable && (!hostCapacity || sliceAvailable) && isOperationLeader;
        const goalAvailable = goalCap === undefined || goalInFlight + goalAdmitted + goalAhead < goalCap;
        if (hostAvailable && goalAvailable) {
          const reservation = join(queue, `${ticket}.admitted`);
          renameSync(join(queue, ticket), reservation);
          const release = releaseWhenStarted(
            store,
            reservation,
            taskId,
            targetAttempt,
            options.resume === true,
            policy.reservationPollMs,
          );
          return options.resumeTicketId && options.resumeReadyOperationId
            ? Object.assign(release, { ticketId: options.resumeTicketId })
            : release;
        }
        if (
          hostCapacity &&
          hostGatesAvailable &&
          goalAvailable &&
          isOperationLeader &&
          !sliceAvailable &&
          Number.isFinite(sliceHeadroom) &&
          reclaimRetryAllowed(reclaimEpisode, reclaimSnapshot, now)
        ) {
          reclaimDeficitMiB = Math.max(1, Math.ceil(requiredMemoryMiB - sliceHeadroom));
          reclaimMemoryCurrentBeforeMiB = memoryCurrentMiB;
          reclaimHeadroomBeforeMiB = sliceHeadroom;
          reclaimAttemptId = crypto.randomUUID();
          reclaimEpisode = beginReclaimAttempt(
            stateDirectory,
            reclaimEpisode,
            reclaimSnapshot,
            sliceHeadroom,
            now,
            reclaimAttemptId,
          );
          reclaimHeadroomAfter = () =>
            (options.workerHeadroomMiB ?? workerHeadroomMiB)(
              running + otherRunning,
              sliceRoot,
              scopes.parked,
              scopes.active,
            );
        } else if (reclaimEpisode && reclaimEpisode.history.at(-1)?.outcome === 'legacy') {
          reclaimEpisode = observeLegacyReclaim(stateDirectory, reclaimEpisode, reclaimSnapshot, sliceHeadroom, now);
        }
        if (options.onWaitReasons)
          options.onWaitReasons(
            hostWaitReasons({
              hostCapacity,
              urgent,
              isOperationLeader,
              ahead,
              running,
              otherRunning,
              admitted,
              otherAdmitted,
              limit,
              maxWorkers: capacity.maxWorkers,
              memory,
              minAvailableMiB: capacity.minAvailableMiB,
              pressurePaused: brake.paused,
              sliceAvailable,
              goalAvailable,
            }),
          );
        if (!reported)
          console.error(
            goalCap !== undefined && !goalAvailable
              ? `Waiting for Goal ${options.goal} start capacity (${goalInFlight} in flight, ${goalAdmitted + goalAhead} starts ahead, cap ${goalCap}).`
              : urgent
                ? `Waiting for urgent host capacity (${running} urgent workers, ${ahead} urgent starts ahead, slots ${limit}; available memory ${Math.floor(memory)} MiB, floor ${capacity.minAvailableMiB} MiB).`
                : `Waiting for host capacity (${running} workers running, ${ahead} starts ahead, cap ${capacity.maxWorkers})${
                    sliceAvailable
                      ? ''
                      : `; worker slice short by ${Math.ceil(requiredMemoryMiB - sliceHeadroom)} MiB${
                          scopes.waitCauses.length ? `; ${scopes.waitCauses.slice(0, 2).join('; ')}` : ''
                        }`
                  }.`,
          );
        reported = true;
      } finally {
        admissionLease.release();
      }
      if (reclaimDeficitMiB !== undefined && reclaimAttemptId !== undefined) {
        const sample = (options.pressure ?? readHostPressure)();
        const brake = pressureBrake(readPressureBrake(stateDirectory), sample, options.now?.() ?? Date.now());
        if (brake.paused) clearReclaimEpisode(stateDirectory);
        else {
          const request = normalizeReclaimRequest(
            (
              options.reclaim ??
              ((deficit) => reclaimCleanFileCacheEvidence(deficit, options.workerSliceRoot ?? WORKER_SLICE_ROOT))
            )(reclaimDeficitMiB),
          );
          const memoryCurrentAfterMiB = (
            options.memoryCurrentMiB ?? (() => workerMemoryCurrentMiB(options.workerSliceRoot ?? WORKER_SLICE_ROOT))
          )();
          const memoryProgressMiB =
            reclaimMemoryCurrentBeforeMiB === undefined || memoryCurrentAfterMiB === undefined
              ? 0
              : Math.max(0, reclaimMemoryCurrentBeforeMiB - memoryCurrentAfterMiB);
          const outcome: ReclaimOutcome =
            memoryProgressMiB >= RECLAIM_OBSERVATION_DELTA_MIB
              ? 'progress'
              : request.errorCode === 'EAGAIN'
                ? 'eagain'
                : request.errorCode
                  ? 'unavailable'
                  : 'no-progress';
          completeReclaimAttempt(stateDirectory, reclaimAttemptId, {
            headroomAfterMiB: reclaimHeadroomAfter?.() ?? reclaimHeadroomBeforeMiB,
            memoryCurrentAfterMiB: memoryCurrentAfterMiB ?? null,
            requestedMiB: request.requestedMiB,
            memoryProgressMiB,
            outcome,
            ...(request.errorCode ? { errorCode: request.errorCode } : {}),
          });
        }
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
  queuedAt?: number;
  priorityHeadStart?: boolean;
  resumeReadyOperationId?: string;
  resumeTicketId?: string;
  resumePriority?: boolean;
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
  queuedAt?: number;
  priorityHeadStart?: boolean;
  resumeReadyOperationId?: string;
  resumeTicketId?: string;
  resumePriority?: boolean;
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
      ...(Number.isSafeInteger(record.queuedAt) && Number(record.queuedAt) >= 0
        ? { queuedAt: Number(record.queuedAt) }
        : {}),
      ...(typeof record.priorityHeadStart === 'boolean' ? { priorityHeadStart: record.priorityHeadStart } : {}),
      ...(typeof record.resumeReadyOperationId === 'string'
        ? { resumeReadyOperationId: record.resumeReadyOperationId }
        : {}),
      ...(typeof record.resumeTicketId === 'string' ? { resumeTicketId: record.resumeTicketId } : {}),
      ...(record.resumePriority === true ? { resumePriority: true } : {}),
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
  if (ticket.attempt === lifecycle.currentAttempt + 1) return STARTABLE_TASK_STATES.has(lifecycle.taskState);
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
        ...(metadata?.queuedAt !== undefined ? { queuedAt: metadata.queuedAt } : {}),
        ...(metadata?.priorityHeadStart !== undefined
          ? { priorityHeadStart: metadata.priorityHeadStart }
          : lifecycle?.priorityHeadStart !== undefined
            ? { priorityHeadStart: lifecycle.priorityHeadStart }
            : {}),
        ...(metadata?.resumeReadyOperationId ? { resumeReadyOperationId: metadata.resumeReadyOperationId } : {}),
        ...(metadata?.resumeTicketId ? { resumeTicketId: metadata.resumeTicketId } : {}),
        ...(metadata?.resumePriority ? { resumePriority: true } : {}),
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
function ticketQueuedAt(ticket: CapacityTicket): number | undefined {
  if (ticket.queuedAt !== undefined) return ticket.queuedAt;
  const value = Number(ticket.order.split('.')[0]?.split('-')[0]);
  return Number.isFinite(value)
    ? value + (ticket.priorityHeadStart ? defaultPolicy.capacity.criticalHeadStartMs : 0)
    : undefined;
}
function ticketQueueRank(ticket: CapacityTicket, now: number, fairnessWindowMs: number): number {
  if (ticket.operation === 'start') {
    const queuedAt = ticketQueuedAt(ticket);
    if (queuedAt !== undefined && now - queuedAt >= fairnessWindowMs) return 0;
  }
  if (ticket.operation === 'resume' && ticket.resumePriority && ticket.resumeReadyOperationId) return 1;
  if (ticket.operation === 'start') return 2;
  return 3;
}
function ticketPrecedes(
  candidate: CapacityTicket,
  mine: CapacityTicket,
  now: number,
  fairnessWindowMs: number,
): boolean {
  const candidateRank = ticketQueueRank(candidate, now, fairnessWindowMs);
  const mineRank = ticketQueueRank(mine, now, fairnessWindowMs);
  return candidateRank === mineRank ? candidate.order < mine.order : candidateRank < mineRank;
}
function ticketWaitersAhead(
  tickets: readonly CapacityTicket[],
  mine: CapacityTicket,
  now = Date.now(),
  fairnessWindowMs = defaultPolicy.capacity.criticalHeadStartMs,
): number {
  const ahead = new Set<string>();
  for (const ticket of tickets) {
    if (
      ticket.lane !== mine.lane ||
      ticket.admitted ||
      !ticketPrecedes(ticket, mine, now, fairnessWindowMs) ||
      (mine.key !== undefined && ticket.key === mine.key)
    )
      continue;
    ahead.add(ticket.key ?? `${ticket.lane}/${ticket.name}`);
  }
  return ahead.size;
}
function hostWaitReasons(snapshot: {
  hostCapacity: boolean;
  urgent: boolean;
  isOperationLeader: boolean;
  ahead: number;
  running: number;
  otherRunning: number;
  admitted: number;
  otherAdmitted: number;
  limit: number;
  maxWorkers: number;
  memory: number;
  minAvailableMiB: number;
  pressurePaused: boolean;
  sliceAvailable: boolean;
  goalAvailable: boolean;
}): string[] {
  const reasons = new Set<string>();
  if (snapshot.hostCapacity) {
    if (!snapshot.isOperationLeader) reasons.add('ticket-operation');
    else if (snapshot.ahead > 0) reasons.add('ticket-order');
    if (snapshot.running + snapshot.admitted + snapshot.ahead >= snapshot.limit)
      reasons.add(snapshot.urgent ? 'urgent-slots' : 'worker-limit');
    if (
      snapshot.running + snapshot.otherRunning + snapshot.admitted + snapshot.otherAdmitted + snapshot.ahead >=
      snapshot.maxWorkers
    )
      reasons.add('shared-worker-limit');
    if (snapshot.memory < snapshot.minAvailableMiB) reasons.add('memory-floor');
    if (snapshot.pressurePaused) reasons.add('host-pressure');
    if (!snapshot.sliceAvailable) reasons.add('worker-slice-reserve');
  }
  if (!snapshot.goalAvailable) reasons.add('goal-start-limit');
  return [...reasons];
}
function ticketGoal(ticket: CapacityTicket, store: HostCapacityStore): string | undefined {
  return ticket.goal ?? (ticket.taskId ? store.taskGoal?.(ticket.taskId) : undefined);
}
function ticketSequence(ticket: CapacityTicket, store: HostCapacityStore): number | undefined {
  return ticket.goalSequence ?? (ticket.taskId ? store.taskSequence?.(ticket.taskId) : undefined);
}
function admittedGoalTasks(tickets: readonly CapacityTicket[], goal: string, store: HostCapacityStore): Set<string> {
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
type ReclaimSnapshot = {
  memoryCurrentMiB: number | undefined;
  reservedMemoryMiB: number;
  runningCount: number;
  terminalScopes: string[];
  headroomMiB: number;
};
function emptyReclaimAttempt(id: string, outcome: ReclaimOutcome, at = 0): ReclaimAttempt {
  return {
    id,
    at,
    outcome,
    headroomBeforeMiB: 0,
    headroomAfterMiB: 0,
    memoryCurrentBeforeMiB: null,
    memoryCurrentAfterMiB: null,
    reservedMemoryMiB: null,
    runningCount: null,
    terminalScopes: [],
    requestedMiB: 0,
    memoryProgressMiB: 0,
  };
}
function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function nullableNonNegativeFinite(value: unknown): value is number | null {
  return value === null || nonNegativeFinite(value);
}
function invalidReclaimEpisode(): ReclaimEpisode {
  return {
    version: 1,
    history: Array.from({ length: MAX_RECLAIM_ATTEMPTS }, (_, index) =>
      emptyReclaimAttempt(`invalid-${index}`, 'invalid'),
    ),
  };
}
function readReclaimEpisode(stateDirectory: string): ReclaimEpisode {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDirectory, 'capacity-reclaim.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidReclaimEpisode();
    const value = parsed as Record<string, unknown>;
    if (value.blocked === false) return { version: 1, history: [] };
    if (value.blocked === true) return { version: 1, history: [emptyReclaimAttempt('legacy-blocked', 'legacy')] };
    if (value.version !== 1 || !Array.isArray(value.history) || value.history.length > MAX_RECLAIM_ATTEMPTS)
      return invalidReclaimEpisode();
    const history: ReclaimAttempt[] = [];
    for (const item of value.history) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return invalidReclaimEpisode();
      const record = item as Record<string, unknown>;
      const currentFormat =
        typeof record.id === 'string' &&
        Object.hasOwn(record, 'memoryCurrentBeforeMiB') &&
        Object.hasOwn(record, 'runningCount') &&
        Array.isArray(record.terminalScopes);
      if (currentFormat) {
        const terminalScopes = record.terminalScopes as unknown[];
        if (
          !nonNegativeFinite(record.at) ||
          !['pending', 'progress', 'no-progress', 'eagain', 'unavailable', 'legacy', 'invalid'].includes(
            String(record.outcome),
          ) ||
          !nonNegativeFinite(record.headroomBeforeMiB) ||
          !nonNegativeFinite(record.headroomAfterMiB) ||
          !nullableNonNegativeFinite(record.memoryCurrentBeforeMiB) ||
          !nullableNonNegativeFinite(record.memoryCurrentAfterMiB) ||
          !nullableNonNegativeFinite(record.reservedMemoryMiB) ||
          !(
            record.runningCount === null ||
            (nonNegativeFinite(record.runningCount) && Number.isSafeInteger(record.runningCount))
          ) ||
          terminalScopes.some((scope) => typeof scope !== 'string') ||
          !nonNegativeFinite(record.requestedMiB) ||
          !nonNegativeFinite(record.memoryProgressMiB) ||
          (record.errorCode !== undefined && typeof record.errorCode !== 'string')
        )
          return invalidReclaimEpisode();
        history.push(record as unknown as ReclaimAttempt);
        continue;
      }
      // Convert the retained partial-progress format without crediting its old inactive-file estimate.
      if (
        nonNegativeFinite(record.at) &&
        typeof record.outcome === 'string' &&
        nonNegativeFinite(record.headroomBeforeMiB) &&
        nonNegativeFinite(record.headroomAfterMiB) &&
        nonNegativeFinite(record.requestedMiB)
      ) {
        history.push({
          ...emptyReclaimAttempt(`legacy-${history.length}`, 'legacy', Number(record.at)),
          headroomBeforeMiB: Number(record.headroomBeforeMiB),
          headroomAfterMiB: Number(record.headroomAfterMiB),
          requestedMiB: Number(record.requestedMiB),
        });
        continue;
      }
      return invalidReclaimEpisode();
    }
    return { version: 1, history };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, history: [] };
    if (error instanceof SyntaxError) return invalidReclaimEpisode();
    throw error;
  }
}
function rearmReclaimEpisode(stateDirectory: string, episode?: ReclaimEpisode): ReclaimEpisode {
  if (!episode?.history.length) return episode ?? { version: 1, history: [] };
  const rearmed: ReclaimEpisode = { version: 1, history: [] };
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify(rearmed));
  return rearmed;
}
function reclaimRetryAllowed(episode: ReclaimEpisode | undefined, current: ReclaimSnapshot, now: number): boolean {
  if (!episode?.history.length) return true;
  if (episode.history.length >= MAX_RECLAIM_ATTEMPTS) return false;
  const previous = episode.history.at(-1)!;
  if (previous.outcome === 'invalid' || now - previous.at < RECLAIM_RETRY_COOLDOWN_MS) return false;
  const memoryDrop =
    previous.memoryProgressMiB >= RECLAIM_OBSERVATION_DELTA_MIB ||
    (previous.memoryCurrentAfterMiB !== null &&
      current.memoryCurrentMiB !== undefined &&
      previous.memoryCurrentAfterMiB - current.memoryCurrentMiB >= RECLAIM_OBSERVATION_DELTA_MIB);
  const reservationDrop =
    previous.reservedMemoryMiB !== null &&
    previous.reservedMemoryMiB - current.reservedMemoryMiB >= RECLAIM_OBSERVATION_DELTA_MIB;
  const writerFinished = previous.runningCount !== null && previous.runningCount > current.runningCount;
  const newTerminalScope = current.terminalScopes.some((scope) => !previous.terminalScopes.includes(scope));
  // Old one-shot latches have no baseline. A newly verified terminal scope is the material change that
  // the old admission path could not observe; a zero-valued synthetic baseline is never treated as progress.
  const legacyTerminalProof = previous.outcome === 'legacy' && current.terminalScopes.length > 0;
  const measuredHeadroomIncrease =
    previous.id !== 'legacy-blocked' &&
    current.headroomMiB - previous.headroomAfterMiB >= RECLAIM_OBSERVATION_DELTA_MIB;
  return (
    memoryDrop ||
    reservationDrop ||
    writerFinished ||
    newTerminalScope ||
    legacyTerminalProof ||
    measuredHeadroomIncrease
  );
}
function observeLegacyReclaim(
  stateDirectory: string,
  episode: ReclaimEpisode,
  current: ReclaimSnapshot,
  headroomMiB: number,
  now: number,
): ReclaimEpisode {
  const previous = episode.history.at(-1);
  if (!previous || previous.outcome !== 'legacy' || previous.reservedMemoryMiB !== null) return episode;
  const history = [...episode.history];
  history[history.length - 1] = {
    ...previous,
    at: now,
    headroomBeforeMiB: headroomMiB,
    headroomAfterMiB: headroomMiB,
    memoryCurrentBeforeMiB: current.memoryCurrentMiB ?? null,
    memoryCurrentAfterMiB: current.memoryCurrentMiB ?? null,
    reservedMemoryMiB: current.reservedMemoryMiB,
    runningCount: current.runningCount,
    terminalScopes: [...current.terminalScopes],
  };
  const observed = { version: 1 as const, history };
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify(observed));
  return observed;
}
function beginReclaimAttempt(
  stateDirectory: string,
  episode: ReclaimEpisode | undefined,
  current: ReclaimSnapshot,
  headroomMiB: number,
  now: number,
  id: string,
): ReclaimEpisode {
  const history = [...(episode?.history ?? [])];
  history.push({
    ...emptyReclaimAttempt(id, 'pending', now),
    headroomBeforeMiB: headroomMiB,
    headroomAfterMiB: headroomMiB,
    memoryCurrentBeforeMiB: current.memoryCurrentMiB ?? null,
    memoryCurrentAfterMiB: current.memoryCurrentMiB ?? null,
    reservedMemoryMiB: current.reservedMemoryMiB,
    runningCount: current.runningCount,
    terminalScopes: [...current.terminalScopes],
  });
  const updated: ReclaimEpisode = { version: 1, history };
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify(updated));
  return updated;
}
function normalizeReclaimRequest(result: number | void | CacheReclaimRequest): CacheReclaimRequest {
  if (typeof result === 'number') return { requestedMiB: Number.isFinite(result) && result > 0 ? result : 0 };
  if (!result) return { requestedMiB: 0 };
  return result;
}
function completeReclaimAttempt(
  stateDirectory: string,
  id: string,
  result: Pick<
    ReclaimAttempt,
    'headroomAfterMiB' | 'memoryCurrentAfterMiB' | 'requestedMiB' | 'memoryProgressMiB' | 'outcome' | 'errorCode'
  >,
): void {
  const episode = readReclaimEpisode(stateDirectory);
  const history = [...episode.history];
  const index = history.findIndex((attempt) => attempt.id === id && attempt.outcome === 'pending');
  if (index < 0) return;
  history[index] = { ...history[index]!, ...result };
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify({ version: 1, history }));
}
function clearReclaimEpisode(stateDirectory: string): void {
  writeFileSync(join(stateDirectory, 'capacity-reclaim.json'), JSON.stringify({ version: 1, history: [] }));
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
      if (
        current &&
        (resume ? current.state !== 'pending' && current.state !== 'waiting' : current.state !== 'pending')
      )
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
    const operation =
      metadata?.operation ?? (metadata?.resume === true ? 'resume' : attempt === undefined ? undefined : 'start');
    const ticket: CapacityTicket = {
      lane: basename(queue) === 'urgent-capacity-queue' ? 'urgent-capacity-queue' : 'capacity-queue',
      queue,
      name,
      order: name.replace(/\.admitted$/, ''),
      admitted: name.endsWith('.admitted'),
      ...(taskId ? { taskId } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(operation ? { operation } : {}),
      ...(metadata?.queuedAt !== undefined ? { queuedAt: metadata.queuedAt } : {}),
      ...(metadata?.priorityHeadStart !== undefined ? { priorityHeadStart: metadata.priorityHeadStart } : {}),
      ...(metadata?.resumeReadyOperationId ? { resumeReadyOperationId: metadata.resumeReadyOperationId } : {}),
      ...(metadata?.resumeTicketId ? { resumeTicketId: metadata.resumeTicketId } : {}),
      ...(metadata?.resumePriority ? { resumePriority: true } : {}),
    };
    if (ticket.taskId && ticket.attempt !== undefined && ticket.operation)
      ticket.key = JSON.stringify([ticket.taskId, ticket.attempt, ticket.operation]);
    return [ticket];
  });
}
