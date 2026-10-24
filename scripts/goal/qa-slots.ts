import { spawnSync, spawn } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';
import { stateDir, pidAlive, dirLockHeld } from './ledger.ts';
import { readFileSync, readdirSync, rmSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { readDirectoryLease, type DirectoryLeaseRecord, directoryLeaseHeld, type AcquiredDirectoryLease, tryAcquireDirectoryLease, updateDirectoryLeaseNote, transferDirectoryLease } from '../qa/process/lease.ts';
import { processAlive, processIdentity } from '../qa/process/identity.ts';
import { randomUUID } from 'node:crypto';
import { positiveInteger } from './unit-gate.ts';
import { terminateProcessGroup } from '../qa/process/terminate.ts';
import { sweepOrphanContainers, reapSettleMs } from '../qa/container-reaper.ts';
import { parseAffectedArgs, testCommands } from '../qa/test.ts';
import { qaArtifactDirectory } from '../qa/core.ts';
import { assertWideRunAllowed, borrowedBookAdmission, borrowedBookSelection, isWideRun, liveWorkerGoals, qaGoal, slotHolderLines, slotHolders, tryAcquireQaSlot, type SlotShareOptions } from './admission.ts';
import { loadSettings } from './config.ts';

/** QA stacks are named `rezics-qa-<UTC yyyymmddThhmmss>-<id>-<n>`. A run killed with SIGKILL never tears
 * its stack down, and leaked stacks filled the Docker VM (four left running for nine hours). No QA run
 * lasts three hours, so a stack started earlier is removed before the next run takes a slot. */
export function reapStaleQaStacks(now = Date.now(), maxAgeMs = 3 * 3_600_000): string[] {
  const listed = spawnSync('docker', ['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'],
    { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) return [];
  const stale = [...new Set(listed.stdout.split('\n'))].filter(project => {
    const match = /^rezics-qa-(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})-/.exec(project);
    if (!match) return false;
    const [, y, mo, d, h, mi, se] = match;
    return now - Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!) > maxAgeMs;
  });
  for (const project of stale) {
    spawnSync('docker', ['compose', '-p', project, 'down', '-v'], { encoding: 'utf8', timeout: 180_000 });
  }
  return stale;
}

const heavyLock = join(stateDir, 'qa-slots', 'heavy');
const sharedLifecycleLock = join(stateDir, 'shared-lifecycle');
const HEAVY_POLL_MS = 10_000;
const HEAVY_DEADLINE_MS = 6 * 3_600_000;

interface CommandTicket {
  pid: number;
  goal?: string;
  command?: string;
  arrivedAt: number;
  /** Zero-padded monotonic time. Wall-clock milliseconds collide; this keeps those tickets in arrival order. */
  seq?: string;
  start?: string;
  boot?: string;
}

/** Beside the lock, not inside it: releasing the lock deletes the lock directory, and later waiters must keep their tickets. */
function commandQueueDir(lockDir: string): string {
  return join(dirname(lockDir), `${basename(lockDir)}-queue`);
}

function commandGoalTurns(queueDir: string): string[] {
  try {
    const turns: unknown = JSON.parse(readFileSync(join(queueDir, 'turns'), 'utf8'));
    return Array.isArray(turns) ? turns.filter((goal): goal is string => typeof goal === 'string') : [];
  } catch { return []; }
}

/** Arrival order across Goals; a dead process gives up its place. */
function commandTickets(queueDir: string, alive: (pid: number) => boolean, fifo = true): { path: string; ticket: CommandTicket }[] {
  let names: string[];
  try { names = readdirSync(queueDir); } catch { return []; }
  const live: { path: string; ticket: CommandTicket }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(queueDir, name);
    try {
      const ticket = JSON.parse(readFileSync(path, 'utf8')) as CommandTicket;
      if (typeof ticket?.pid !== 'number' || typeof ticket.arrivedAt !== 'number'
        || !(ticket.start && ticket.boot ? processAlive(ticket) : alive(ticket.pid))) {
        rmSync(path, { force: true });
        continue;
      }
      live.push({ path, ticket });
    } catch { rmSync(path, { force: true }); }
  }
  if (fifo) live.sort((a, b) => a.ticket.arrivedAt - b.ticket.arrivedAt
    || (a.ticket.seq ?? '').localeCompare(b.ticket.seq ?? '')
    || a.ticket.pid - b.ticket.pid || a.path.localeCompare(b.path));
  else {
  // Refresh repairs the shared stack for every Goal. It gets the next turn, never the holder’s turn.
  const priority = (ticket: CommandTicket) => ticket.command === 'task dev:refresh' ? 0 : 1;
  const turns = commandGoalTurns(queueDir);
  const turn = (ticket: CommandTicket) => priority(ticket) === 0 ? -1 : turns.indexOf(ticket.goal ?? '?');
  live.sort((a, b) => priority(a.ticket) - priority(b.ticket) || turn(a.ticket) - turn(b.ticket)
    || a.ticket.arrivedAt - b.ticket.arrivedAt
    || (a.ticket.seq ?? '').localeCompare(b.ticket.seq ?? '')
    || a.ticket.pid - b.ticket.pid
    || (a.path < b.path ? -1 : 1));
  }
  return live;
}

/** Who holds the heavy QA lock, or undefined when it is free (a dead holder's lock is free). */
function commandHolder(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string | undefined {
  const info = readDirectoryLease(lockDir);
  if (!info?.command || info.invalid) return undefined;
  const commandState = typeof info.commandStartedAt === 'string' ? `command started ${info.commandStartedAt}`
    : info.commandStartedAt === null ? 'command not started' : 'command start unknown';
  const live = info.start && info.boot ? processAlive({ pid: info.pid, start: info.start, boot: info.boot }) : alive(info.pid);
  return live ? `Goal ${info.goal ?? '?'} since ${info.startedAt} (pid ${info.pid}): ${info.command} (${commandState})` : undefined;
}

/** Holder text as before, plus how many live tickets are waiting. Reading the queue drops tickets of dead pids. */
export function heavyQaStatus(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string {
  if (inheritedHeavyLease(lockDir)) return 'free; 0 waiting';
  const waiting = commandTickets(commandQueueDir(lockDir), alive).length;
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${waiting} waiting`;
}

export function heavyQaWaiters(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive).map(({ ticket }) =>
    `QA waiting for heavy turn: Goal ${ticket.goal ?? '?'} since ${new Date(ticket.arrivedAt).toISOString()} (pid ${ticket.pid}): ${ticket.command ?? 'QA command'}`);
}

export function sharedLifecycleStatus(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string {
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${commandTickets(commandQueueDir(lockDir), alive, false).length} waiting`;
}

export function sharedLifecycleWaiters(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive, false).map(({ ticket }) =>
    `Shared lifecycle waiting: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'lifecycle command'}`);
}

export interface QaWaitStatus {
  pid: number; goal?: string; command: string; waitingFor: 'slot' | 'memory' | 'heavy' | 'load'; message?: string; since: string;
  /** Set only while this waiter is the oldest fitting startup with a ready lease. */
  headSince?: string;
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

export function qaWaitStatusLines(qaSlotsDir = join(stateDir, 'qa-slots'), alive: (pid: number) => boolean = pidAlive,
  now: () => number = Date.now): string[] {
  const directory = join(qaSlotsDir, 'waiters');
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const waits: { ticket: boolean; wait: QaWaitStatus }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const wait = JSON.parse(readFileSync(path, 'utf8')) as QaWaitStatus;
      if (!Number.isSafeInteger(wait.pid) || typeof wait.command !== 'string'
        || !['slot', 'memory', 'heavy', 'load'].includes(wait.waitingFor) || !alive(wait.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      waits.push({ ticket: name.startsWith('ordered-slot-'), wait });
    } catch { rmSync(path, { force: true }); }
  }
  // A run's ordered ticket and its slot wait are one waiter: the wait's own record names the command and the reason.
  const waitingForSlot = new Set(waits.filter(entry => !entry.ticket && entry.wait.waitingFor === 'slot').map(entry => entry.wait.pid));
  return waits.filter(entry => !entry.ticket || !waitingForSlot.has(entry.wait.pid))
    .map(({ wait }) => `QA waiting for ${wait.waitingFor}: Goal ${wait.goal ?? '?'} (pid ${wait.pid}): ${wait.command}`
      + `; since ${wait.since}` + (wait.message ? `; ${wait.message}` : '')
      + (wait.headSince && now() - Date.parse(wait.headSince) >= 10 * 60_000
        ? `; startup queue head has not advanced for ${Math.floor((now() - Date.parse(wait.headSince)) / 60_000)} minutes` : '')).sort();
}

/** Both dispatcher and harness use the existing waiter directory and share owner.
 * Tickets stay ordered across retries; only a runnable head may take a lifetime lease. */
export function qaSlotAdmission(directory: string, total: number, options: SlotShareOptions = {}) {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const alive = options.alive ?? pidAlive;
  const waiters = join(directory, 'waiters');
  mkdirSync(waiters, { recursive: true });
  const path = join(waiters, `ordered-slot-${pid}-${randomUUID()}.json`);
  const since = env.GOAL_QA_ARRIVED_AT ?? new Date(now()).toISOString();
  const seq = env.GOAL_QA_ARRIVAL_SEQUENCE ?? process.hrtime.bigint().toString().padStart(24, '0');
  const goal = qaGoal(env);
  atomicJson(path, { pid, ...processIdentity(pid), goal, command: env.GOAL_QA_COMMAND ?? 'QA', waitingFor: 'slot', since, seq });
  let admitted = false;
  return {
    release: () => rmSync(path, { force: true }),
    acquire: (slot: number): AcquiredDirectoryLease | 'held' => {
      const guard = tryAcquireDirectoryLease(join(directory, 'order'), { pid, alive, now });
      if (guard === 'held') return 'held';
      try {
        const tickets: { path: string; pid: number; start?: string; boot?: string; goal?: string; since: string; seq?: string; waitingFor?: string }[] = [];
        for (const name of readdirSync(waiters)) {
          // Status survives nonblocking retries; only an outstanding acquisition
          // can own a queue turn. Otherwise a startup waiting on memory can head
          // this queue while the startup ahead of it waits for this slot.
          if (!name.startsWith('ordered-slot-') || !name.endsWith('.json')) continue;
          const candidatePath = join(waiters, name);
          try {
            const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as typeof tickets[number];
            if (candidate.waitingFor !== 'slot' || typeof candidate.since !== 'string') continue;
            if (!(candidate.start && candidate.boot ? processAlive(candidate) : alive(candidate.pid))) { rmSync(candidatePath, { force: true }); continue; }
            tickets.push({ ...candidate, path: candidatePath });
          } catch { /* a concurrently released ticket is absent */ }
        }
        tickets.sort((a, b) => a.since.localeCompare(b.since) || (a.seq ?? '').localeCompare(b.seq ?? ''));
        // Match the existing share owner's eligibility; it still makes the final decision under its guard.
        const goals = new Set((options.workerGoals ?? liveWorkerGoals)());
        const share = Math.max(1, Math.floor(total / Math.max(1, goals.size)));
        const holders = slotHolders(directory, total, alive);
        const first = tickets.find(ticket => !ticket.goal || ticket.goal === 'program' || !goals.has(ticket.goal)
          || holders.filter(holder => holder.goal === ticket.goal).length < share
          || !tickets.some(other => other.goal && other.goal !== ticket.goal));
        if (!admitted && first?.path !== path) return 'held';
        const lease = tryAcquireQaSlot(directory, total, slot, options);
        if (lease !== 'held') { admitted = true; rmSync(path, { force: true }); }
        return lease;
      } finally { guard.release(); }
    },
  };
}

/** Ordinary QA runs share the configured slots; the environment overrides one process.
 * Memory admission still decides each start. */
export function qaSlotCount(directory: string, env: NodeJS.ProcessEnv = process.env): number {
  if (env.GOAL_QA_SLOTS !== undefined) return Number(env.GOAL_QA_SLOTS);
  return loadSettings({ stateDirectory: dirname(directory), env }).settings.qaSlots;
}

/** Concurrent type-check and unit gates share this many process-identity leases.
 * A killed gate's lease is stale, so the next gate takes its lane. */
function gateLaneCount(directory: string = gateLanesDir): number {
  if (process.env.GOAL_GATE_LANES) return positiveInteger('GOAL_GATE_LANES', 2);
  return loadSettings({ stateDirectory: dirname(directory) }).settings.gateLanes;
}

const gateLanesDir = join(stateDir, 'gate-lanes');
const GATE_LANE_POLL_MS = 3_000;
const GATE_LANE_DEADLINE_MS = 6 * 3_600_000;

interface GateLaneWait {
  pid: number; goal?: string; command: string; since: string;
}

interface GateLaneView {
  held: number; lanes: number; holders: string[];
}

function gateLaneOwnerLive(info: DirectoryLeaseRecord, alive: (pid: number) => boolean): boolean {
  if (info.invalid) return false;
  if (info.start !== undefined && info.boot !== undefined)
    return processAlive({ pid: info.pid, start: info.start, boot: info.boot });
  return alive(info.pid);
}

function gateLaneView(directory: string, lanes: number, alive: (pid: number) => boolean): GateLaneView {
  const holders: string[] = [];
  let held = 0;
  for (let index = 0; index < lanes; index++) {
    const path = join(directory, String(index));
    if (!directoryLeaseHeld(path, { alive })) continue;
    held++;
    const info = readDirectoryLease(path);
    if (!info || !gateLaneOwnerLive(info, alive)) continue;
    holders.push(`Goal ${info.goal ?? '?'} since ${info.startedAt ?? 'unknown'} (pid ${info.pid}): ${info.command ?? 'gate'}`);
  }
  return { held, lanes, holders };
}

function gateLaneBusyText(view: GateLaneView): string {
  return `${view.held}/${view.lanes} gate lanes busy${view.holders.length ? `: ${view.holders.join('; ')}` : ''}`;
}

/** Live waiters. A record whose process is gone is removed, the same way a QA slot waiter is. */
function readGateLaneWaiters(directory: string, alive: (pid: number) => boolean): GateLaneWait[] {
  const waiterDirectory = join(directory, 'waiters');
  let names: string[];
  try { names = readdirSync(waiterDirectory); } catch { return []; }
  const waiting: GateLaneWait[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(waiterDirectory, name);
    try {
      const wait = JSON.parse(readFileSync(path, 'utf8')) as GateLaneWait;
      if (!Number.isSafeInteger(wait.pid) || wait.pid <= 0 || typeof wait.command !== 'string'
        || typeof wait.since !== 'string' || !alive(wait.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      waiting.push(wait);
    } catch { rmSync(path, { force: true }); }
  }
  return waiting;
}

/** Holders and how many gates are waiting. Dead holders are omitted; the next acquire reclaims their lease. */
export function gateLaneStatus(directory = gateLanesDir, alive: (pid: number) => boolean = pidAlive,
  lanes = gateLaneCount(directory)): string {
  const view = gateLaneView(directory, lanes, alive);
  const who = view.holders.length ? ` (${view.holders.join('; ')})` : '';
  return `${view.held}/${view.lanes} busy${who}; ${readGateLaneWaiters(directory, alive).length} waiting`;
}

export function gateLaneWaiters(directory = gateLanesDir, alive: (pid: number) => boolean = pidAlive,
  lanes = gateLaneCount(directory)): string[] {
  const message = gateLaneBusyText(gateLaneView(directory, lanes, alive));
  return readGateLaneWaiters(directory, alive).map(wait =>
    `Gate waiting for lane: Goal ${wait.goal ?? '?'} (pid ${wait.pid}): ${wait.command}; ${message}`).sort();
}

export interface GateLaneOptions {
  directory?: string;
  lanes?: number;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  alive?: (pid: number) => boolean;
  goal?: string;
  command?: string;
  pid?: number;
}

/** One host-wide lane for a gate's type check and unit work. `work` starts only after the lease is held,
 * so the per-side budget does not include the wait. The lease records this process; a kill leaves it stale. */
export async function withGateLane<T>(work: (hold: { acquiredAt: number }) => Promise<T>,
  options: GateLaneOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.error;
  const alive = options.alive ?? (pid => pidAlive(pid));
  const pid = options.pid ?? process.pid;
  const directory = options.directory ?? gateLanesDir;
  const lanes = options.lanes ?? gateLaneCount(directory);
  const goal = options.goal ?? currentQaGoal();
  const command = options.command ?? 'gate';
  const waiterDirectory = join(directory, 'waiters');
  const deadline = now() + (options.timeoutMs ?? GATE_LANE_DEADLINE_MS);
  mkdirSync(directory, { recursive: true });
  let held: AcquiredDirectoryLease | undefined;
  let waitPath: string | undefined;
  let announced = false;
  try {
    while (!held) {
      for (let index = 0; index < lanes && !held; index++) {
        const acquired = tryAcquireDirectoryLease(join(directory, String(index)), {
          pid, alive: candidate => alive(candidate),
          note: { goal, command, startedAt: new Date(now()).toISOString() },
        });
        if (acquired !== 'held') held = acquired;
      }
      if (held) break;
      const message = gateLaneBusyText(gateLaneView(directory, lanes, alive));
      const record: GateLaneWait = { pid, goal, command, since: new Date(now()).toISOString() };
      mkdirSync(waiterDirectory, { recursive: true });
      waitPath ??= join(waiterDirectory, `lane-${pid}-${randomUUID()}.json`);
      atomicJson(waitPath, record);
      if (!announced) {
        announce(`waiting for gate lane; ${message}`);
        announced = true;
      }
      if (now() > deadline) throw new Error('No gate lane became free within six hours; waiting for a gate lane');
      await sleep(options.pollMs ?? GATE_LANE_POLL_MS);
    }
    if (waitPath) rmSync(waitPath, { force: true });
    waitPath = undefined;
    return await work({ acquiredAt: now() });
  } finally {
    if (waitPath) rmSync(waitPath, { force: true });
    held?.release();
  }
}

/** `process.exit` from a signal still runs the exit hook, which is the one place a waiting ticket is removed without `finally`. */
function bindCommandTicketCleanup(remove: () => void): () => void {
  const onExit = () => remove();
  const onSignal = (signal: NodeJS.Signals) => {
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
  };
  process.on('exit', onExit);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('exit', onExit);
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

export interface HeavyWaitOptions {
  lockDir?: string;
  /** Lifecycle takes the next admission turn while existing isolated QA is allowed to finish. */
  lifecycleLockDir?: string;
  pid?: number;
  goal?: string;
  waitForWorkers?: boolean;
  besideWorkers?: boolean;
  workerGoals?: () => string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  pollMs?: number;
  /** Epoch milliseconds after which a waiter that still does not hold the lock gives up. */
  deadline?: number;
  /** Nonblocking startup retries retain their original queue arrival. */
  arrivedAt?: number;
  signal?: AbortSignal;
  /** Exit and signal hooks remove the ticket. In-process tests pass false so they do not exit the runner. */
  bindExit?: boolean;
  /** A waiting refresh already includes committed main when it starts. Return undefined instead of queuing another. */
  coalesceRefresh?: boolean;
  announce?: (message: string) => void;
}

/** Heavy runs (affected sets, whole tiers, wave and browser suites) are host-wide exclusive: two managers' waves
 * together would put four or more QA stacks beside the workers, past what a 62 GB host held on 2026-09-27/28. A heavy
 * run owns only its heavy lease; bounded light runs use the ordinary slots independently.
 * The lock belongs to the process and is freed when it exits, so no manager has to remember to release it.
 * Waiters poll, so a run that starts at the moment the lock frees would otherwise cut in front of one that has been
 * waiting. Tickets preserve FIFO within each Goal, with a shared rotation preventing one Goal's backlog from starving peers. */
export function acquireHeavy(command: readonly string[], options?: HeavyWaitOptions & { coalesceRefresh?: false }): Promise<() => void>;
export function acquireHeavy(command: readonly string[], options: HeavyWaitOptions & { coalesceRefresh: boolean }): Promise<(() => void) | undefined>;
export async function acquireHeavy(command: readonly string[], options: HeavyWaitOptions = {}): Promise<(() => void) | undefined> {
  return acquireQueuedCommand(command, options, 'heavy QA');
}

export type SharedLifecycleWaitOptions = Omit<HeavyWaitOptions, 'lifecycleLockDir'>;

/** Shared-stack mutation has its own lease. Existing isolated QA can keep running while refresh or repair starts. */
export function acquireSharedLifecycle(command: readonly string[], options?: SharedLifecycleWaitOptions & { coalesceRefresh?: false }): Promise<() => void>;
export function acquireSharedLifecycle(command: readonly string[], options: SharedLifecycleWaitOptions & { coalesceRefresh: boolean }): Promise<(() => void) | undefined>;
export async function acquireSharedLifecycle(command: readonly string[], options: SharedLifecycleWaitOptions = {}): Promise<(() => void) | undefined> {
  return acquireQueuedCommand(command, options, 'shared lifecycle');
}

async function acquireQueuedCommand(command: readonly string[], options: HeavyWaitOptions,
  kind: 'heavy QA' | 'shared lifecycle'): Promise<(() => void) | undefined> {
  const lockDir = options.lockDir ?? (kind === 'heavy QA' ? heavyLock : sharedLifecycleLock);
  const lifecycleLockDir = options.lifecycleLockDir ?? (options.lockDir ? join(dirname(lockDir), 'shared-lifecycle') : sharedLifecycleLock);
  const queueDir = commandQueueDir(lockDir);
  const pid = options.pid ?? process.pid;
  const goal = options.goal ?? process.env.GOAL_ID;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const alive = options.alive ?? pidAlive;
  const pollMs = options.pollMs ?? HEAVY_POLL_MS;
  const deadline = options.deadline ?? now() + HEAVY_DEADLINE_MS;
  const commandText = command.join(' ');
  const arrivedAt = options.arrivedAt ?? now();
  const ticketPath = join(queueDir, `${String(arrivedAt).padStart(16, '0')}-${pid}-${randomUUID()}.json`);
  const removeTicket = () => {
    rmSync(ticketPath, { force: true });
    rmSync(`${ticketPath}.tmp`, { force: true });
  };
  let unbind = () => {};
  try {
    // Bound before the ticket exists, so a signal between the write and the first poll still removes it.
    if (options.bindExit !== false) unbind = bindCommandTicketCleanup(removeTicket);
    mkdirSync(queueDir, { recursive: true });
    const ticket: CommandTicket = {
      pid, goal, command: commandText, arrivedAt, seq: process.hrtime.bigint().toString().padStart(24, '0'),
      ...processIdentity(pid),
    };
    writeFileSync(`${ticketPath}.tmp`, JSON.stringify(ticket));
    renameSync(`${ticketPath}.tmp`, ticketPath);
    let announced = false;
    for (;;) {
      if (options.signal?.aborted) throw new Error('QA turn request cancelled');
      const tickets = commandTickets(queueDir, alive, kind === 'heavy QA');
      const ahead = tickets.findIndex(entry => entry.path === ticketPath);
      if (options.coalesceRefresh && commandText === 'task dev:refresh') {
        const prior = tickets.find(entry => entry.path !== ticketPath && entry.ticket.command === commandText
          && tickets.indexOf(entry) < ahead);
        if (prior) {
          // A refresh that has already taken the lock must not absorb changes arriving after its snapshot.
          let started = false;
          try {
            const holder = readDirectoryLease(lockDir);
            started = holder?.command === commandText && holder.pid === prior.ticket.pid && alive(holder.pid);
          } catch { /* a queued refresh has no holder record */ }
          if (!started) return undefined;
        }
      }
      const lifecyclePending = kind === 'heavy QA' && (dirLockHeld(lifecycleLockDir, alive)
        || commandTickets(commandQueueDir(lifecycleLockDir), alive, false).length > 0);
      const workers = options.waitForWorkers ? (options.workerGoals ?? liveWorkerGoals)().length : 0;
      const workersPending = workers > 0 && !options.besideWorkers;
      if (ahead === 0 && !workersPending && !lifecyclePending && !dirLockHeld(lockDir, alive)) {
        try {
          // Fail at once when the directory is held, so this loop's poll is the only wait.
          // Stale-owner reclaim still runs before that failure.
          const acquired = tryAcquireDirectoryLease(lockDir, {
            pid, alive: candidate => alive(candidate),
            note: { goal, command: commandText, startedAt: new Date().toISOString(), commandStartedAt: null,
              ...(options.waitForWorkers ? { besideWorkers: options.besideWorkers ? workers : 0 } : {}) },
          });
          if (acquired === 'held') throw new Error(`The ${kind} lock is held`);
          if (kind === 'shared lifecycle' && commandText !== 'task dev:refresh') {
            const turns = commandGoalTurns(queueDir).filter(turn => turn !== (goal ?? '?'));
            turns.push(goal ?? '?');
            writeFileSync(join(queueDir, 'turns'), JSON.stringify(turns));
          }
          return () => acquired.release();
        } catch { /* the lock was taken between the check and the create */ }
      }
      if (now() >= deadline) throw new Error(`The ${kind} lock stayed held before the deadline`);
      if (!announced) {
        const holder = commandHolder(lockDir, alive);
        (options.announce ?? console.error)(workersPending ? `waiting for ${workers} live worker${workers === 1 ? '' : 's'} before wide QA; use --beside-workers to start alongside them`
          : lifecyclePending ? 'waiting for shared lifecycle before heavy QA admission' : ahead > 0
          ? `waiting for ${kind} turn; ${ahead} waiter${ahead === 1 ? '' : 's'} in line${holder ? ` (${holder})` : ''}`
          : `waiting for ${kind} turn held by ${holder ?? 'a starting run'}`);
        announced = true;
      }
      await sleep(pollMs);
    }
  } finally {
    removeTicket();
    unbind();
  }
}

export interface SlotRunOptions {
  slotDirectory?: string;
  heavyLockDirectory?: string;
  lifecycleLockDirectory?: string;
  slots?: number;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  reap?: () => void;
  runCommand?: (command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void) => Promise<number>;
  env?: NodeJS.ProcessEnv;
  workerGoals?: SlotShareOptions['workerGoals'];
}

async function runQaCommand(command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void,
  lifecycleLockDirectory?: string, borrowedPublicDomainBook = false): Promise<number> {
  const owner = lifecycleLockDirectory ? commandLease(lifecycleLockDirectory) : undefined;
  const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env, detached: true });
  let restoreOwner: (() => void) | undefined;
  if (lifecycleLockDirectory && child.pid && owner) {
    onStart();
    // Transfer synchronously before yielding: a killed launcher must not make its still-running repair look stale.
    restoreOwner = transferSharedLifecycleOwnership(lifecycleLockDirectory, child.pid, owner.pid);
  }
  const exited = new Promise<number>((done, reject) => {
    child.once('error', reject);
    if (!restoreOwner) child.once('spawn', onStart);
    child.once('exit', exit => done(exit ?? 1));
  });
  let stopping: Promise<void> | undefined;
  const forward = () => {
    if (!child.pid) return;
    stopping ??= terminateProcessGroup(child.pid, { graceMs: 1_000 });
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const code = await exited;
    if (stopping) await stopping;
    return code;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    restoreOwner?.();
    if (!borrowedPublicDomainBook) {
      // The child's exit hook can run before dockerd finishes creating its container.
      try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
      await Bun.sleep(reapSettleMs);
      try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
    }
  }
}

export function markHeavyCommandStarted(lockDirectory: string): void {
  updateDirectoryLeaseNote(lockDirectory, process.pid, { commandStartedAt: new Date().toISOString() });
}

export function markSharedLifecycleCommandStarted(lockDirectory = sharedLifecycleLock): void {
  markHeavyCommandStarted(lockDirectory);
}

function commandOwnerAlive(info: DirectoryLeaseRecord): boolean {
  return info.start && info.boot ? processAlive({ pid: info.pid, start: info.start, boot: info.boot }) : pidAlive(info.pid);
}

function commandLease(lockDirectory: string): DirectoryLeaseRecord | undefined {
  const info = readDirectoryLease(lockDirectory);
  return info?.token && !info.invalid ? info : undefined;
}

export function sharedLifecycleEnvironment(lockDirectory = sharedLifecycleLock): NodeJS.ProcessEnv {
  const info = commandLease(lockDirectory);
  if (!info?.token || !commandOwnerAlive(info)) throw new Error('Shared lifecycle lease is absent or stale');
  return { GOAL_SHARED_LIFECYCLE_LOCK: resolve(lockDirectory), GOAL_SHARED_LIFECYCLE_PID: String(info.pid),
    GOAL_SHARED_LIFECYCLE_LEASE: info.token };
}

/** Nested maintenance uses the caller's validated lease, so a repair may invoke refresh without queuing behind itself. */
export function inheritedSharedLifecycleOwnership(lockDirectory = sharedLifecycleLock, env = process.env):
  { lockDirectory: string; pid: number; leaseId: string } | undefined {
  if (!env.GOAL_SHARED_LIFECYCLE_LOCK) return undefined;
  const info = commandLease(lockDirectory);
  if (resolve(env.GOAL_SHARED_LIFECYCLE_LOCK) !== resolve(lockDirectory) || !info?.token || !commandOwnerAlive(info)
    || ![String(info.pid), String(info.delegatedFromPid)].includes(env.GOAL_SHARED_LIFECYCLE_PID ?? '')
    || info.token !== env.GOAL_SHARED_LIFECYCLE_LEASE) {
    throw new Error('Inherited shared lifecycle lease is absent, stale or belongs to another lock');
  }
  return { lockDirectory, pid: info.pid, leaseId: info.token };
}

/** The staged child owns the lease while running. Restore a live caller for the rest of its repair command;
 * if that caller was killed, the child releases it. */
export function transferSharedLifecycleOwnership(lockDirectory: string, pid: number,
  expectedOwnerPid = process.ppid): () => void {
  const info = commandLease(lockDirectory);
  if (!Number.isSafeInteger(pid) || pid < 1 || !info?.token)
    throw new Error('Shared lifecycle ownership changed before transfer');
  return transferDirectoryLease(lockDirectory, info.token, pid, expectedOwnerPid, { alive: candidate => pidAlive(candidate) });
}

/** Repairs mutate the shared stack, not a QA stack: no QA lease, stack reap or QA admission environment. */
export async function withRecovery(command: string[], options: SlotRunOptions = {}): Promise<number> {
  if (!command.length) throw new Error('slot --recovery needs a command after --');
  const lockDirectory = options.lifecycleLockDirectory ?? sharedLifecycleLock;
  const inherited = inheritedSharedLifecycleOwnership(lockDirectory);
  const release = inherited ? () => {} : await acquireSharedLifecycle(command, { lockDir: lockDirectory, goal: currentQaGoal(),
    now: options.now, sleep: options.sleep, pollMs: options.pollMs,
    deadline: options.timeoutMs === undefined ? undefined : (options.now ?? Date.now)() + options.timeoutMs,
    announce: options.announce });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_SHARED_LIFECYCLE: '1', ...sharedLifecycleEnvironment(lockDirectory) };
    delete env.GOAL_IN_SLOT;
    delete env.GOAL_QA_HEAVY_RUN;
    delete env.GOAL_QA_SLOT_DIRECTORY;
    delete env.GOAL_QA_WAIT_DIR;
    delete env.GOAL_QA_COMMAND;
    const onStart = () => markSharedLifecycleCommandStarted(lockDirectory);
    return await (options.runCommand ? options.runCommand(command, env, onStart)
      : runQaCommand(command, env, onStart, lockDirectory));
  } finally { release(); }
}

function currentQaGoal(): string | undefined {
  return qaGoal();
}

function inheritedHeavyLease(lockDirectory: string, env = process.env): boolean {
  if (env.GOAL_QA_HEAVY_LOCK !== resolve(lockDirectory)) return false;
  const info = commandLease(lockDirectory);
  return !!info && commandOwnerAlive(info) && info.token === env.GOAL_QA_HEAVY_LEASE;
}

/** The harness admits its own lifetime lease after memory and the startup turn. */
function harnessOwnsSlot(command: readonly string[]): boolean {
  if (command[0] === 'worker-check') return true;
  if (basename(command[0] ?? '') !== 'bun') return false;
  const script = resolve(command[1] ?? '');
  if (script === resolve(import.meta.dir, '../qa/cli.ts')) return true;
  if (script !== resolve(import.meta.dir, '../qa/test.ts')) return false;
  const args = command.slice(2);
  if (parseAffectedArgs(args)) return false;
  const commands = testCommands(args);
  return commands.some(([program, selected]) => program === 'bun' && selected[0] === 'scripts/qa/cli.ts');
}

export async function withSlot(command: string[], heavy = false, resultFile?: string, options: SlotRunOptions = {}): Promise<number> {
  const callerEnv = options.env ?? process.env;
  const borrowed = borrowedBookSelection(command, heavy) ? borrowedBookAdmission(callerEnv) : undefined;
  if (borrowed && options.slotDirectory && resolve(options.slotDirectory) !== resolve(borrowed.directory))
    throw new Error('Borrowed Book cannot replace its registered shared Goal admission directory');
  if (command.length === 1 && command[0] === '--holders') {
    const directory = options.slotDirectory ?? join(stateDir, 'qa-slots');
    for (const line of slotHolderLines(directory, options.slots ?? qaSlotCount(directory, callerEnv))) (options.announce ?? console.log)(line);
    return 0;
  }
  assertWideRunAllowed(command, callerEnv);
  const wide = isWideRun(command);
  const besideWorkers = command.includes('--beside-workers');
  command = command.filter(arg => arg !== '--beside-workers');
  heavy ||= wide;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.error;
  const queuedAt = now();
  let startedAt: number | undefined;
  let code: number | undefined;
  // A checkout older than the artifact override still writes under its own `.artifacts/qa`, so list both.
  const artifactDirs = [...new Set([qaArtifactDirectory(process.cwd()), join(process.cwd(), '.artifacts', 'qa')])];
  const listed = (dir: string) => existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
  const prior = new Set(artifactDirs.flatMap(listed));
  const deferred = harnessOwnsSlot(command);
  const dir = borrowed?.directory ?? options.slotDirectory ?? (deferred ? callerEnv.GOAL_QA_SLOT_DIRECTORY : undefined) ?? join(stateDir, 'qa-slots');
  const slots = options.slots ?? (borrowed ? qaSlotCount(dir, callerEnv) : qaSlotCount(dir));
  if (!heavy && (!Number.isSafeInteger(slots) || slots! < 1)) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const heavyLockDirectory = options.heavyLockDirectory ?? (options.slotDirectory ? join(dir, 'heavy') : callerEnv.GOAL_QA_HEAVY_LOCK ?? heavyLock);
  const waiterDirectory = join(dir, 'waiters');
  const goal = qaGoal(callerEnv);
  const inheritedHeavy = inheritedHeavyLease(heavyLockDirectory, callerEnv);
  if (!inheritedHeavy && !heavy && callerEnv.GOAL_IN_SLOT === '1' && !options.slotDirectory && !resultFile) {
    return (options.runCommand ?? runQaCommand)(command, callerEnv, () => {});
  }
  mkdirSync(dir, { recursive: true });
  let releaseHeavy: (() => void) | undefined;
  let heldSlot: AcquiredDirectoryLease | undefined;
  let waitPath: string | undefined;
  let slotAdmission: ReturnType<typeof qaSlotAdmission> | undefined;
  try {
    releaseHeavy = heavy && !deferred && !inheritedHeavy ? await acquireHeavy(command, { lockDir: heavyLockDirectory,
      lifecycleLockDir: options.lifecycleLockDirectory ?? (options.slotDirectory ? join(dir, 'shared-lifecycle') : sharedLifecycleLock),
      goal, announce, waitForWorkers: wide, besideWorkers, workerGoals: options.workerGoals,
      now, sleep, pollMs: options.pollMs,
      deadline: options.timeoutMs === undefined ? undefined : now() + options.timeoutMs }) : undefined;
    if (!heavy && !deferred && !inheritedHeavy) {
      const deadline = now() + (options.timeoutMs ?? 3_600_000);
      slotAdmission = qaSlotAdmission(dir, slots!, { env: callerEnv, now, workerGoals: borrowed?.workerGoals ?? options.workerGoals });
      let announced = false;
      while (!heldSlot) {
        for (let k = 0; k < slots! && !heldSlot; k++) {
          const acquired = slotAdmission.acquire(k);
          if (acquired !== 'held') heldSlot = acquired;
        }
        if (!heldSlot) {
          const free = [...Array(slots!).keys()].filter(k => !dirLockHeld(join(dir, String(k)), pidAlive)).length;
          const record: QaWaitStatus = { pid: process.pid, goal, command: command.join(' '),
            waitingFor: 'slot', message: `${slots! - free}/${slots} ordinary slots busy`
              + (free ? '; Goal share reserved for another waiting Goal' : ''), since: new Date(queuedAt).toISOString() };
          mkdirSync(waiterDirectory, { recursive: true });
          waitPath ??= join(waiterDirectory, `slot-${process.pid}-${randomUUID()}.json`);
          atomicJson(waitPath, record);
          if (!announced) { announce(`waiting for QA slot; ${record.message}`); announced = true; }
          if (now() > deadline) throw new Error('No QA slot became free within one hour; waiting for an ordinary slot');
          await sleep(options.pollMs ?? 3000);
        }
      }
      if (waitPath) rmSync(waitPath, { force: true });
    }
    if (borrowed) borrowed.workerGoals(); // Refuse a changed owner after waiting, before starting the child.
    else if (!inheritedHeavy) (options.reap ?? reapStaleQaStacks)();
    const env: NodeJS.ProcessEnv = { ...callerEnv, GOAL_IN_SLOT: deferred ? '0' : '1',
      ...(deferred || borrowed ? { GOAL_QA_SLOT_DIRECTORY: dir, GOAL_QA_SLOTS: String(slots) } : {}),
      GOAL_QA_WAIT_DIR: waiterDirectory, GOAL_QA_COMMAND: command.join(' '),
      GOAL_QA_ARRIVED_AT: callerEnv.GOAL_QA_ARRIVED_AT ?? new Date(queuedAt).toISOString(),
      GOAL_QA_ARRIVED_AT_MS: callerEnv.GOAL_QA_ARRIVED_AT_MS ?? String(queuedAt),
      GOAL_QA_ARRIVAL_SEQUENCE: callerEnv.GOAL_QA_ARRIVAL_SEQUENCE ?? process.hrtime.bigint().toString().padStart(24, '0') };
    if (heavy || inheritedHeavy) {
      env.GOAL_QA_HEAVY_RUN = '1';
      env.GOAL_QA_HEAVY_LOCK = resolve(heavyLockDirectory);
      env.GOAL_QA_HEAVY_LEASE = commandLease(heavyLockDirectory)?.token;
      if (deferred && !inheritedHeavy) {
        env.GOAL_QA_DEFERRED_HEAVY = '1';
        env.GOAL_QA_WIDE_RUN = wide ? '1' : '0';
        env.GOAL_QA_LIFECYCLE_LOCK = options.lifecycleLockDirectory
          ?? (options.slotDirectory ? join(dir, 'shared-lifecycle') : sharedLifecycleLock);
        env.GOAL_QA_BESIDE_WORKERS = besideWorkers ? '1' : '0';
      }
    }
    if (goal) env.GOAL_ID = goal;
    const onStart = () => {
      startedAt = now();
      if (heavy && !inheritedHeavy) markHeavyCommandStarted(heavyLockDirectory);
    };
    code = await (options.runCommand ? options.runCommand(command, env, onStart)
      : runQaCommand(command, env, onStart, undefined, !!borrowed));
    return code;
  } finally {
    if (waitPath) rmSync(waitPath, { force: true });
    slotAdmission?.release();
    heldSlot?.release();
    releaseHeavy?.();
    if (resultFile) {
      const finishedAt = now();
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, JSON.stringify({ code, queuedAt, startedAt, finishedAt,
        queueMs: (startedAt ?? finishedAt) - queuedAt, testMs: startedAt ? finishedAt - startedAt : 0,
        totalMs: finishedAt - queuedAt,
        artifactPaths: artifactDirs.flatMap(listed).filter(path => !prior.has(path)) }, null, 2));
    }
  }
}
