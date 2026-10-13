// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, gate lanes, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { typecheckWorkspaces, TYPECHECK_WORKSPACES } from '../qa/affected.ts';
import { printScopeProgress } from '../qa/cases/outcomes.ts';
import { withLedger, activeGoals, root, managerOf, stateDir, pidAlive, dirLockHeld, readLedger, acquireDir, areasOf, unlandedChangers } from './ledger.ts';
import { running, lastAttempt, elapsed, transportContinuations, transportDrop, launchCommand, managerWakeGates, describe, taskOf } from './launch.ts';
import { clearRefusal, mergeTask } from './merge.ts';
import { currentUsage, codexAccounts, describeAccount, usageReport } from './usage.ts';
import { goalMeasures } from './measures.ts';
import { inboxEntries, provideGoalctl, runRegression, parseRegressArgs, appendInbox } from './regress.ts';
import { join, dirname, basename, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { validGoalSlug, pathsOverlap, isGeneratedOutput, isHeavyTest } from './briefs.ts';
import { MAX_TRANSPORT_CONTINUATIONS, engineOf, type Ledger, effortsOf, modelOf, engineEnv, HOLDING, ENGINES } from './types.ts';
import { spawnSync, spawn } from 'node:child_process';
import { readDirectoryLease, type DirectoryLeaseRecord, directoryLeaseHeld, type AcquiredDirectoryLease, tryAcquireDirectoryLease, updateDirectoryLeaseNote, transferDirectoryLease } from '../qa/process/lease.ts';
import { processAlive } from '../qa/process/identity.ts';
import { randomUUID } from 'node:crypto';
import { positiveInteger, declaredTestTimeout, planUnitGateShards } from './unit-gate.ts';
import { terminateProcessGroup } from '../qa/process/terminate.ts';
import { sweepOrphanContainers, reapSettleMs } from '../qa/container-reaper.ts';
import { parseAffectedArgs, testCommands } from '../qa/test.ts';
import { qaArtifactDirectory } from '../qa/core.ts';
import { GoalMailStore } from './mail.ts';
import { type WakeEvent, type LaunchDescriptor, processIdentity, claudeConfigHome, WAKE_PROMPT, WAKE_LAST_MESSAGE, tmuxServer, GoalCoordinator, TmuxLauncher, claudeNativeSession, claudeWakeArgs, nativeSession } from './coordinator.ts';
import { homedir } from 'node:os';
import { startGoal, closeGoal, newBrief, tidy, dispatch, waitFor, resumeTask, stopTask, landTask, setAutoLand, lendFiles, closeTasks, reclaimTask } from './tasks.ts';

export { type State, type Engine, BRIEF_KINDS, type BriefKind, type Brief, type Attempt, type Task, type GoalRecord, type Ledger, type UsageWindow, type UsageSnapshot, type UsageSample, type UsageLevel, type UsageReport, type AccountUsage, type CodexResetStatus, type CodexResetLoad, MODEL, FABLE_MODEL, SONNET_MODEL, HAIKU_MODEL, CODEX_MODEL, LUNA_MODEL, GROK_MODEL, DEFAULT_ENGINE, CODEX_HOME, CODEX_1_HOME } from './types.ts';
export { parseFrontmatter, parseBrief, validateBrief, mechanismSectionErrors, rangesOverlap, pathsOverlap, isGeneratedOutput, claimConflicts, outOfScope, GOALS_DIR, validGoalSlug, goalFile, goalBriefFile, goalOfBriefPath, goalAreas, areaConflicts, nextTaskId, HISTORY_EXEMPT, type ChangedFile, historyIntroductions, ownerRefusal, isHeavyTest } from './briefs.ts';
export { PROJECTED_LIMIT, CRITICAL_USED, WEEK_CAP, WEEK_TARGET, WEEK_PROJECTED_LIMIT, WEEK_CRITICAL_USED, burnRate, weekBurnRate, usageLevel, parseCodexUsage, loadCodexResetStatus, codexHoursUntil100, type GoalUsageReport, usageReport } from './usage.ts';
export { launchCommand, SOL_CONTEXT_WINDOW, CODEX_COMPACT_TOKENS, CODEX_TOOL_OUTPUT_TOKENS, briefFile, memoryFloorRefusal, managerWakeGates, workerSessionEnvironment, capacityRefusal } from './launch.ts';
export { retryGitIndexLock, ARCHIVE_BRANCH, archiveFiles, removeFromTree, treeMentions, landClaimScope, REGENERATION_COMMIT_SUBJECT, regenerationOnlyFiles } from './ledger.ts';
export { dispatchMethodErrors, waitFor, resumeDecisionError, killWorktreeProcesses, removeWorktreeStack, preserveWorktreeArtifacts, COMPOSITION_ROOTS } from './tasks.ts';
export { normalizeUseChains, compositionSyntaxFailure, type CompositionMerge, prepareCompositionMerge, migrationsBelowMain, landedBoundary } from './merge-normalise.ts';
export { type DeclaredTestTimeout, declaredTestTimeout, UNIT_GATE_TIMEOUT_MARGIN_MS, type PlannedUnitShard, UNIT_GATE_FILE_CAP, planUnitGateShards, readMeasuredUnitDurations, mergeUnitFiles, mergeOwnerFiles, unitFilesFromPlan, ownerFilesFromPlan, UNIT_JUNIT_MARKER, failingTestFiles, balanceUnitShards, type UnitShardResult, type UnitShardRunner, timedOutTestFiles, shardTimeoutFiles, type UnitFailureDetail, type UnitFileErrorDetail, type UnitRunnerError, unitFailureDetails, normalizeUnitFileError, unitFileErrorDetails, type UnitGateRunKind, type UnitFailureCase, type UnitFileEvidence, type UnitRunEvidence, type UnitGatePass, unitFileEvidence, unitGateRefusal, writeUnitEvidence, type IntroducedUnitFailure, introducedUnitFailures, introducedUnitFailureFiles, runOwnerShard, type UnitGateOptions, runUnitGate, streamUnitBaseline, streamSelectionFiles, runUnitSide, type InfrastructureStep, infrastructureStep, type BranchOnlyClassification, classifyBranchOnlyFailures, branchOnlyRefusal, gateTreeRefusal } from './unit-gate.ts';
export { typecheckDiagnostics, unclassifiedTypecheckLines, introducedTypecheckDiagnostics, type TypecheckRun, type TypecheckSide, typecheckGate, addGateWorktree, dependencyInstallIsStale, missingPinnedImage } from './typecheck-gate.ts';
export { type PreparedMerge, type MainSync, type FastForward, type FastForwardGates, fastForwardMain } from './merge.ts';

export { typecheckWorkspaces, TYPECHECK_WORKSPACES };

async function status(): Promise<void> {
  await printScopeProgress();
  const ledger = await withLedger(current => {
    for (const task of Object.values(current.tasks)) {
      if (task.state === 'running' && !running(task)) {
        task.state = 'exited';
        clearRefusal(task);
        lastAttempt(task).endedAt ??= new Date().toISOString();
      }
    }
    return current;
  });
  const tasks = Object.values(ledger.tasks);
  const usage = currentUsage();
  const live = tasks.filter(running);
  console.log(`program elapsed ${ledger.startedAt ? elapsed(ledger.startedAt) : 'not started'}; `
    + `live ${live.length}/${process.env.GOAL_MAX_WORKERS ?? 25}; `
    + `Claude 5h ${usage.used ?? '?'}% ${usage.level}`
    + (usage.projected !== undefined ? `, projected ${usage.projected}% at reset in ${usage.resetInMinutes}m` : '')
    + (usage.ageSeconds !== undefined ? ` (${usage.ageSeconds}s old)` : ''));
  if (usage.weekUsed !== undefined) {
    console.log(`Claude 7d ${usage.weekUsed}%, projected ${usage.weekProjected}–${usage.weekProjectedHigh}% at reset in ${usage.weekResetInHours}h: `
      + `${usage.weekAdvice}`);
  }
  for (const account of codexAccounts()) console.log(describeAccount(account));
  console.log(`heavy QA: ${heavyQaStatus()}`);
  for (const waiting of heavyQaWaiters()) console.log(waiting);
  console.log(`shared lifecycle: ${sharedLifecycleStatus()}`);
  for (const waiting of sharedLifecycleWaiters()) console.log(waiting);
  for (const waiting of qaWaitStatusLines()) console.log(waiting);
  console.log(`gate lanes: ${gateLaneStatus()}`);
  for (const waiting of gateLaneWaiters()) console.log(waiting);
  const active = activeGoals(ledger);
  await goalMeasures(ledger, { root, print: line => console.log(line) });
  for (const slug of active) {
    const own = tasks.filter(task => task.goal === slug);
    console.log(`Goal ${slug}: manager ${managerOf(ledger, slug)}; ${own.filter(running).length} live, `
      + `${own.filter(task => !['verified', 'cancelled'].includes(task.state)).length} open; `
      + `${inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length} unacknowledged regressions`);
  }
  const inboxDirectory = join(stateDir, 'inbox');
  for (const file of existsSync(inboxDirectory) ? readdirSync(inboxDirectory).sort() : []) {
    if (!file.endsWith('.jsonl')) continue;
    const slug = file.slice(0, -6);
    if (!validGoalSlug(slug) || active.includes(slug)) continue;
    const count = inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length;
    if (count) console.log(`Goal ${slug}: inactive; ${count} unacknowledged regressions`);
  }
  for (const task of tasks.filter(t => !['verified', 'cancelled'].includes(t.state))) {
    const attempt = lastAttempt(task);
    const continuations = transportContinuations(task);
    const repeated = task.state === 'exited' && transportDrop(attempt) && continuations >= MAX_TRANSPORT_CONTINUATIONS;
    console.log(`${task.id} ${task.state.padEnd(8)} ${task.goal ?? '-'} ${engineOf(attempt)}/${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`
      + (running(task) && continuations > 0 ? `; continued by itself ${continuations}` : '')
      + (repeated ? '\n  stopped after repeated transport errors' : '')
      + (task.state === 'conflict' && task.refusal ? `\n  ${task.refusal}` : ''));
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
}

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

/** Live tickets: shared refresh first, then Goals in turn order, FIFO within a Goal. Dead or unordered tickets are removed. */
function commandTickets(queueDir: string, alive: (pid: number) => boolean): { path: string; ticket: CommandTicket }[] {
  let names: string[];
  try { names = readdirSync(queueDir); } catch { return []; }
  const live: { path: string; ticket: CommandTicket }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(queueDir, name);
    try {
      const ticket = JSON.parse(readFileSync(path, 'utf8')) as CommandTicket;
      if (typeof ticket?.pid !== 'number' || typeof ticket.arrivedAt !== 'number' || !alive(ticket.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      live.push({ path, ticket });
    } catch { rmSync(path, { force: true }); }
  }
  // Refresh repairs the shared stack for every Goal. It gets the next turn, never the holder’s turn.
  const priority = (ticket: CommandTicket) => ticket.command === 'task dev:refresh' ? 0 : 1;
  const turns = commandGoalTurns(queueDir);
  const turn = (ticket: CommandTicket) => priority(ticket) === 0 ? -1 : turns.indexOf(ticket.goal ?? '?');
  live.sort((a, b) => priority(a.ticket) - priority(b.ticket) || turn(a.ticket) - turn(b.ticket)
    || a.ticket.arrivedAt - b.ticket.arrivedAt
    || (a.ticket.seq ?? '').localeCompare(b.ticket.seq ?? '')
    || a.ticket.pid - b.ticket.pid
    || (a.path < b.path ? -1 : 1));
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
  const waiting = commandTickets(commandQueueDir(lockDir), alive).length;
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${waiting} waiting`;
}

export function heavyQaWaiters(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive).map(({ ticket }) =>
    `QA waiting for heavy turn: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'QA command'}`);
}

export function sharedLifecycleStatus(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string {
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${commandTickets(commandQueueDir(lockDir), alive).length} waiting`;
}

export function sharedLifecycleWaiters(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive).map(({ ticket }) =>
    `Shared lifecycle waiting: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'lifecycle command'}`);
}

export interface QaWaitStatus {
  pid: number; goal?: string; command: string; waitingFor: 'slot' | 'memory'; message?: string; since: string;
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

export function qaWaitStatusLines(qaSlotsDir = join(stateDir, 'qa-slots'), alive: (pid: number) => boolean = pidAlive): string[] {
  const directory = join(qaSlotsDir, 'waiters');
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const lines: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const wait = JSON.parse(readFileSync(path, 'utf8')) as QaWaitStatus;
      if (!Number.isSafeInteger(wait.pid) || typeof wait.command !== 'string'
        || !['slot', 'memory'].includes(wait.waitingFor) || !alive(wait.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      lines.push(`QA waiting for ${wait.waitingFor}: Goal ${wait.goal ?? '?'} (pid ${wait.pid}): ${wait.command}`
        + (wait.message ? `; ${wait.message}` : ''));
    } catch { rmSync(path, { force: true }); }
  }
  return lines.sort();
}

/** Ordinary QA runs share this many slots. Program sets the count for every Goal in `qa-slot-count`
 * beside the slots; `GOAL_QA_SLOTS` overrides it for one process. Memory admission still decides each start. */
export function qaSlotCount(directory: string, env: NodeJS.ProcessEnv = process.env): number {
  if (env.GOAL_QA_SLOTS !== undefined) return Number(env.GOAL_QA_SLOTS);
  const file = join(dirname(directory), 'qa-slot-count');
  const stored = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return /^[1-9]\d*$/.test(stored) && Number.isSafeInteger(Number(stored)) ? Number(stored) : 3;
}

/** Concurrent type-check and unit gates share this many process-identity leases.
 * A killed gate's lease is stale, so the next gate takes its lane. */
function gateLaneCount(directory: string = gateLanesDir): number {
  if (process.env.GOAL_GATE_LANES) return positiveInteger('GOAL_GATE_LANES', 2);
  // Program sets the count for every Goal by writing this file beside the lanes; the environment
  // variable overrides it for one process.
  const file = join(dirname(directory), 'gate-lane-count');
  const stored = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return /^[1-9]\d*$/.test(stored) && Number.isSafeInteger(Number(stored)) ? Number(stored) : 2;
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  pollMs?: number;
  /** Epoch milliseconds after which a waiter that still does not hold the lock gives up. */
  deadline?: number;
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
  const arrivedAt = now();
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
    };
    writeFileSync(`${ticketPath}.tmp`, JSON.stringify(ticket));
    renameSync(`${ticketPath}.tmp`, ticketPath);
    let announced = false;
    for (;;) {
      const tickets = commandTickets(queueDir, alive);
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
        || commandTickets(commandQueueDir(lifecycleLockDir), alive).length > 0);
      if (ahead === 0 && !lifecyclePending && !dirLockHeld(lockDir, alive)) {
        try {
          // Fail at once when the directory is held, so this loop's poll is the only wait.
          // Stale-owner reclaim still runs before that failure.
          const acquired = tryAcquireDirectoryLease(lockDir, {
            pid, alive: candidate => alive(candidate),
            note: { goal, command: commandText, startedAt: new Date().toISOString(), commandStartedAt: null },
          });
          if (acquired === 'held') throw new Error(`The ${kind} lock is held`);
          if (commandText !== 'task dev:refresh') {
            const turns = commandGoalTurns(queueDir).filter(turn => turn !== (goal ?? '?'));
            turns.push(goal ?? '?');
            writeFileSync(join(queueDir, 'turns'), JSON.stringify(turns));
          }
          return () => acquired.release();
        } catch { /* the lock was taken between the check and the create */ }
      }
      if (now() > deadline) throw new Error(`The ${kind} lock stayed held for six hours`);
      if (!announced) {
        const holder = commandHolder(lockDir, alive);
        (options.announce ?? console.error)(lifecyclePending ? 'waiting for shared lifecycle before heavy QA admission' : ahead > 0
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
}

async function runQaCommand(command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void,
  lifecycleLockDirectory?: string): Promise<number> {
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
    // The child's exit hook can run before dockerd finishes creating its container.
    try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
    await Bun.sleep(reapSettleMs);
    try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
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
  if (process.env.GOAL_ID) return process.env.GOAL_ID;
  const taskId = process.env.GOAL_TASK_ID;
  if (!taskId) return undefined;
  try { return readLedger().tasks[taskId]?.goal; } catch { return undefined; }
}

/** The harness admits its own lifetime lease after memory and the startup turn. */
function harnessOwnsSlot(command: readonly string[]): boolean {
  if (basename(command[0] ?? '') !== 'bun') return false;
  const script = resolve(command[1] ?? '');
  if (script === resolve(import.meta.dir, '../qa/cli.ts')) return true;
  if (script !== resolve(import.meta.dir, '../qa/test.ts')) return false;
  const args = command.slice(2);
  if (parseAffectedArgs(args)) return false;
  const commands = testCommands(args);
  if (commands.length !== 1) return false;
  const [program, selected] = commands[0]!;
  return program === 'bun' && selected[0] === 'scripts/qa/cli.ts';
}

export async function withSlot(command: string[], heavy = false, resultFile?: string, options: SlotRunOptions = {}): Promise<number> {
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
  const deferred = !heavy && harnessOwnsSlot(command);
  const dir = options.slotDirectory ?? (deferred ? process.env.GOAL_QA_SLOT_DIRECTORY : undefined) ?? join(stateDir, 'qa-slots');
  const slots = heavy ? undefined : options.slots ?? qaSlotCount(dir);
  if (!heavy && (!Number.isSafeInteger(slots) || slots! < 1)) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const heavyLockDirectory = options.heavyLockDirectory ?? (options.slotDirectory ? join(dir, 'heavy') : heavyLock);
  const waiterDirectory = join(dir, 'waiters');
  const goal = currentQaGoal();
  mkdirSync(dir, { recursive: true });
  let releaseHeavy: (() => void) | undefined;
  let heldSlot: AcquiredDirectoryLease | undefined;
  let waitPath: string | undefined;
  try {
    releaseHeavy = heavy ? await acquireHeavy(command, { lockDir: heavyLockDirectory,
      lifecycleLockDir: options.lifecycleLockDirectory ?? (options.slotDirectory ? join(dir, 'shared-lifecycle') : sharedLifecycleLock),
      goal, announce }) : undefined;
    if (!heavy && !deferred) {
      const deadline = now() + (options.timeoutMs ?? 3_600_000);
      let announced = false;
      while (!heldSlot) {
        for (let k = 0; k < slots! && !heldSlot; k++) {
          const path = join(dir, String(k));
          try { heldSlot = await acquireDir(path, -1, 'slot'); } catch { /* busy */ }
        }
        if (!heldSlot) {
          const free = [...Array(slots!).keys()].filter(k => !dirLockHeld(join(dir, String(k)), pidAlive)).length;
          const record: QaWaitStatus = { pid: process.pid, goal, command: command.join(' '),
            waitingFor: 'slot', message: `${slots! - free}/${slots} ordinary slots busy`, since: new Date(now()).toISOString() };
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
    (options.reap ?? reapStaleQaStacks)();
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_IN_SLOT: deferred ? '0' : '1',
      ...(deferred ? { GOAL_QA_SLOT_DIRECTORY: dir, GOAL_QA_SLOTS: String(slots) } : {}),
      GOAL_QA_WAIT_DIR: waiterDirectory, GOAL_QA_COMMAND: command.join(' ') };
    if (heavy || process.env.GOAL_QA_HEAVY_RUN === '1') env.GOAL_QA_HEAVY_RUN = '1';
    if (goal) env.GOAL_ID = goal;
    code = await (options.runCommand ?? runQaCommand)(command, env, () => {
      startedAt = now();
      if (heavy) markHeavyCommandStarted(heavyLockDirectory);
    });
    return code;
  } finally {
    if (waitPath) rmSync(waitPath, { force: true });
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

/** The override confines disposable mail/pump trials to their own ledger and local state. */
function eventStateDirectory(): string {
  return process.env.GOAL_MAIL_STATE_DIR ? resolve(process.env.GOAL_MAIL_STATE_DIR) : stateDir;
}
function eventLedger(directory: string): Ledger {
  const path = join(directory, 'ledger.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ledger : { tasks: {} };
}
function namedOptions(args: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error(`Invalid option: ${flag}; expected ${allowed.join(', ')}`);
    }
    options[flag] = value;
  }
  return options;
}
export function mailCommand(args: string[], options: {stateDir: string; goals: string[]; callerGoal?: string}): string[] {
  const [action, ...rest] = args;
  const store = new GoalMailStore({...options,sender:options.callerGoal ?? ''});
  try {
    if (action === 'send') {
      const goal = rest[0] ?? '';
      const flags = namedOptions(rest.slice(1), ['--file', '--key', '--deadline']);
      if (!flags['--file'] || !flags['--key']) throw new Error('mail send <goal> needs --file <path> --key <retry-key>');
      if (!options.callerGoal) throw new Error('mail send needs GOAL_ID to record its sender');
      return [JSON.stringify(store.send(goal, readFileSync(resolve(flags['--file']), 'utf8'), flags['--key'],
        flags['--deadline'] === undefined ? undefined : Number(flags['--deadline'])))];
    }
    if (action === 'inbox') {
      if (rest.length > 1) throw new Error('mail inbox accepts one Goal');
      const goal = rest[0] ?? options.callerGoal;
      if (!goal) throw new Error('mail inbox needs <goal> or GOAL_ID');
      return store.inbox(goal).map(entry => JSON.stringify(entry));
    }
    if (action === 'ack') {
      const flags = namedOptions(rest.slice(1), ['--goal']);
      const goal = flags['--goal'] ?? options.callerGoal;
      if (!goal || !rest[0]) throw new Error('mail ack <id> needs GOAL_ID or --goal <goal>');
      return [JSON.stringify(store.ack(goal, rest[0]))];
    }
    throw new Error('mail needs send <goal> --file <path> --key <retry-key> [--deadline <minutes>] | inbox [goal] | ack <id> [--goal <goal>]');
  } finally { store.close(); }
}
export function managerEvents(directory: string, goal: string, mail: GoalMailStore): WakeEvent[] {
  const body = (message: ReturnType<GoalMailStore['pending']>[number]) =>
    `From: ${message.sender ?? 'unknown (historical mail)'}\nDeadline: ${message.deadlineAt ?? 'none'}\n${message.body}`;
  const events: WakeEvent[] = mail.pending(goal).map(message => ({key:message.id,body:body(message)}));
  for (const message of mail.overdue(goal)) {
    if (message.overdueAt !== null) events.push({key:`mail:overdue:${message.id}:${goal}`,
      body:`Mail ${message.id} is overdue and remains unacknowledged. This is its one deadline wake.\n${body(message)}`});
  }
  for (const task of Object.values(eventLedger(directory).tasks)) {
    if (task.goal !== goal || ['verified', 'cancelled', 'merged'].includes(task.state) || !task.attempts.length) continue;
    const attempt = lastAttempt(task);
    if (task.state === 'running' && running(task)) continue;
    events.push({key:`task:${task.id}:${attempt.n}`,body:`${task.id}: ${task.state}; attempt ${attempt.n} exited. Output: ${attempt.output}`});
  }
  return events;
}
export function coordinatorEnrollmentOptions(args: string[]): {
  goal: string; session: string; engine: LaunchDescriptor['engine']; effort: string; cwd: string; model?: string;
  socket?: string; previousOwner: NonNullable<ReturnType<typeof processIdentity>>;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--session', '--engine', '--effort', '--cwd', '--model', '--tmux-socket', '--previous-owner-pid']);
  const engine = flags['--engine'] ?? 'codex';
  if (engine !== 'codex' && engine !== 'codex-1' && engine !== 'luna' && engine !== 'claude') {
    throw new Error('The coordinator enrolls Codex and Claude managers only');
  }
  const effort = flags['--effort'];
  const session = flags['--session'];
  const cwd = flags['--cwd'];
  const model = flags['--model'];
  const pidText = flags['--previous-owner-pid'];
  if (!goal || !effort || !effortsOf(engine).includes(effort) || !session || !cwd || !pidText) {
    throw new Error('Enrollment requires <goal> --session <native UUID> --effort <effort> --cwd <directory> --previous-owner-pid <pid>');
  }
  if (engine === 'claude' && !model) throw new Error('Claude enrollment requires --model <id>');
  if (engine !== 'claude' && model) throw new Error('--model is only for --engine claude');
  const pid = Number(pidText);
  if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid)) throw new Error('--previous-owner-pid must be a positive integer PID');
  const previousOwner = processIdentity(pid);
  if (!previousOwner) throw new Error(`Cannot establish the live previous owner ${pid}; enroll while that process is still running`);
  return { goal, session, engine, effort, cwd, model, socket: flags['--tmux-socket'], previousOwner };
}
export function coordinatorStartOptions(args: string[]): {
  goal: string; engine: 'codex' | 'codex-1' | 'claude'; effort: string; model: string;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--engine', '--effort', '--model']);
  const engine = flags['--engine'];
  if (!validGoalSlug(goal) || (engine !== 'codex' && engine !== 'codex-1' && engine !== 'claude')) {
    throw new Error('coordinator start needs <goal> --engine <codex|codex-1|claude> --effort <effort> [--model <id>]');
  }
  const effort = flags['--effort'] ?? '';
  if (!effortsOf(engine).includes(effort)) throw new Error(`${engine} effort must be one of ${effortsOf(engine).join(', ')}`);
  return {goal,engine,effort,model:flags['--model'] ?? modelOf(engine)};
}
export function coordinatorStartDescriptor(options: ReturnType<typeof coordinatorStartOptions>, cwd: string, socket: string): LaunchDescriptor {
  const {goal,engine,effort,model} = options;
  const session = randomUUID();
  const home = realpathSync(engine === 'claude' ? claudeConfigHome() : engineEnv(engine).CODEX_HOME!);
  const command = (resume: boolean): [string, string[]] => {
    const [program,args] = launchCommand({id:goal,engine,effort,session,worktree:cwd,resume,
      prompt:WAKE_PROMPT,lastMessage:WAKE_LAST_MESSAGE});
    const modelFlag = args.findIndex(arg => arg === '--model' || arg === '-m');
    args[modelFlag + 1] = model;
    return [program,args];
  };
  const [program,args] = command(true);
  return {goal,generation:randomUUID(),session,engine,effort,cwd,home,
    program:Bun.which(program) ?? program,args,startArgs:command(false)[1],socket,server:tmuxServer(socket),
    env:{PATH:process.env.PATH ?? '',HOME:homedir(),GOAL_ID:goal,GOAL_MANAGER:`goal-${goal}`,
      ...(engine === 'claude' ? (process.env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:home} : {}) : {CODEX_HOME:home}),
      ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS','GOAL_CODEX_HOME',
        'GOAL_CODEX_1_HOME','GOAL_CODEX_SERVICE_TIER'].filter(key=>process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
}
async function coordinatorCommand(args: string[]): Promise<void> {
  const directory = eventStateDirectory();
  const coordinator = new GoalCoordinator({stateDir:directory,
    events:goal => {
      const goals = Object.keys(eventLedger(directory).goals ?? {});
      if (!goals.includes(goal)) return [];
      const mail = new GoalMailStore({stateDir:directory,goals});
      try { return managerEvents(directory,goal,mail); } finally { mail.close(); }
    },
    admit:descriptor => {
      if (!activeGoals(eventLedger(directory)).includes(descriptor.goal)) throw new Error('Enrolled Goal is no longer active');
      const home = descriptor.engine === 'claude' ? realpathSync(claudeConfigHome()) : engineEnv(descriptor.engine).CODEX_HOME;
      if (!home || realpathSync(home) !== descriptor.home) throw new Error('Selected engine account home changed; handover required');
      managerWakeGates(descriptor.engine);
    }});
  try {
    const [action, ...rest] = args;
    if (action === 'start') {
      const options = coordinatorStartOptions(rest);
      // Registration uses goal start's existing ledger and area owner checks.
      if (directory !== stateDir) throw new Error('coordinator start must use the Goal ledger directory');
      const socket = process.env.GOAL_COORDINATOR_TMUX_SOCKET
        ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
      if (!socket) throw new Error('Start needs an independent tmux server; set GOAL_COORDINATOR_TMUX_SOCKET');
      const descriptor = coordinatorStartDescriptor(options,realpathSync(root),socket);
      new TmuxLauncher(directory).verify(descriptor);
      coordinator.assertStartable(options.goal);
      managerWakeGates(options.engine);
      await startGoal(options.goal,['--manager',descriptor.env.GOAL_MANAGER!]);
      coordinator.start(descriptor);
      // A running pump collects the durable start event; otherwise make the first turn concrete now.
      let acquired = false;
      try { coordinator.acquire(); acquired = true; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'Coordinator already running') throw error; }
      if (acquired) { try { coordinator.step(); } finally { coordinator.release(); } }
      console.log(JSON.stringify(descriptor,null,2)); return;
    }
    if (action === 'status') {
      if (rest.length) throw new Error('coordinator status takes no options');
      const mail = new GoalMailStore({stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {})});
      try { console.log(JSON.stringify({...coordinator.status(),overdueMail:mail.overdue()},null,2)); }
      finally { mail.close(); }
      return;
    }
    if (action === 'unenroll') {
      if (rest.length !== 1) throw new Error('coordinator unenroll needs <goal>');
      coordinator.acquire();
      try { coordinator.unenroll(rest[0]!); } finally { coordinator.release(); }
      return;
    }
    if (action === 'enroll') {
      const { goal, session, engine, effort, model, cwd: requestedCwd, socket: requestedSocket, previousOwner } = coordinatorEnrollmentOptions(rest);
      if (!activeGoals(eventLedger(directory)).includes(goal)) throw new Error(`Unknown active Goal: ${goal}`);
      const cwd = realpathSync(resolve(requestedCwd));
      if (engine === 'claude') {
        const home = realpathSync(claudeConfigHome());
        claudeNativeSession(home, session, cwd);
        const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
        if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
        const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
          program:Bun.which('claude') ?? 'claude',args:claudeWakeArgs(session,model!,effort),socket,server:tmuxServer(socket),
          env:{PATH:process.env.PATH ?? '',HOME:homedir(),GOAL_ID:goal,
            GOAL_MANAGER:managerOf(eventLedger(directory),goal),
            ...(process.env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR} : {}),
            ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
            ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
        coordinator.acquire();
        try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
        console.log(JSON.stringify(descriptor,null,2)); return;
      }
      const home = realpathSync(engineEnv(engine).CODEX_HOME!);
      nativeSession(home,session,cwd);
      const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
      if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
      const [program, launchArgs] = launchCommand({id:goal,engine,effort,session,worktree:cwd,resume:true,
        prompt:WAKE_PROMPT,lastMessage:WAKE_LAST_MESSAGE});
      const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
        program:Bun.which(program) ?? program,args:launchArgs,socket,server:tmuxServer(socket),
        env:{PATH:process.env.PATH ?? '',HOME:homedir(),CODEX_HOME:home,GOAL_ID:goal,
          GOAL_MANAGER:managerOf(eventLedger(directory),goal),
          ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
          ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS','GOAL_CODEX_HOME',
            'GOAL_CODEX_1_HOME','GOAL_CODEX_SERVICE_TIER'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
      coordinator.acquire();
      try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
      console.log(JSON.stringify(descriptor,null,2)); return;
    }
    const once = args.includes('--once');
    const flags = namedOptions(args.filter(arg=>arg !== '--once'),['--interval-ms']);
    const interval = Number(flags['--interval-ms'] ?? 5000);
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw new Error('interval must be 100..60000 ms');
    coordinator.acquire();
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM',stop); process.on('SIGINT',stop);
    try {
      do {
        const mail = new GoalMailStore({stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {})});
        try { mail.notifyOverdue(); } finally { mail.close(); }
        coordinator.step();
        if (!once && !stopped) await Bun.sleep(interval);
      } while (!once && !stopped);
    } finally { process.off('SIGTERM',stop); process.off('SIGINT',stop); coordinator.release(); }
  } finally { coordinator.close(); }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  switch (command) {
    case 'init':
      throw new Error('init is replaced by `goal start <slug> --manager <session>`; see docs/goals/README.md');
    case 'goal': {
      const [action, slug = ''] = positional;
      if (action === 'start') { await startGoal(slug, rest.slice(2)); return 0; }
      if (action === 'close') return closeGoal(slug, flags);
      throw new Error('goal needs start <slug> --manager <session> [--adopt] [--allow-area] | close <slug> [--dry-run]');
    }
    case 'new': await newBrief(rest); return 0;
    case 'tidy': await tidy(rest); return 0;
    case 'dispatch': await dispatch(positional[0] ?? '', flags); return 0;
    case 'wait': await waitFor(positional[0] ?? ''); return 0;
    case 'resume': await resumeTask(rest[0] ?? '', rest.slice(1)); return 0;
    case 'stop': await stopTask(positional[0] ?? ''); return 0;
    case 'scope': console.log(describe(taskOf(readLedger(), positional[0] ?? ''))); return 0;
    case 'merge': await mergeTask(positional[0] ?? '', flags); return 0;
    case 'gate': await mergeTask(positional[0] ?? '', flags, undefined, undefined, undefined, true); return 0;
    case 'land': await landTask(positional[0] ?? '', flags.has('--step')); return 0;
    case 'auto-land': await setAutoLand(positional[0] ?? '', positional[1] !== 'off'); return 0;
    case 'loan': await lendFiles(positional[0] ?? '', positional.slice(1)); return 0;
    case 'close': await closeTasks(positional.slice(0, -1), positional.at(-1) ?? ''); return 0;
    case 'reclaim': await reclaimTask(positional[0] ?? '', positional[1] ?? '', flags); return 0;
    case 'owner': {
      // Read-only: which open task claims a path, or committed it outside its claim and has not landed.
      const path = positional[0] ?? '';
      const ledger = readLedger();
      const areas = Object.entries(areasOf(activeGoals(ledger)))
        .filter(([, globs]) => globs.some(glob => pathsOverlap(glob, path))).map(([slug]) => slug);
      const areaNote = areas.length ? `; in Goal ${areas.join(', ')}'s area` : '';
      if (isGeneratedOutput(path)) {
        console.log(`${path}: unclaimed${areaNote}`);
        return 0;
      }
      const tasks = Object.values(ledger.tasks);
      const holders = tasks.filter(task => HOLDING.includes(task.state)
        && task.paths.some(pattern => !isGeneratedOutput(pattern)
          && (new Bun.Glob(pattern).match(path) || pathsOverlap(pattern, path))));
      const changed = unlandedChangers(tasks, path);
      const claimText = holders.length
        ? `claimed by ${holders.map(task => `${task.id} (${task.state})`).join(', ')}` : '';
      const changeText = changed.length ? `changed by ${changed.map(task => task.id).join(', ')} (unlanded)` : '';
      const body = [claimText, changeText].filter(Boolean).join('; ') || 'unclaimed';
      console.log(`${path}: ${body}${areaNote}`);
      return claimText || changeText ? 1 : 0;
    }
    case 'status': await status(); return 0;
    case 'mail': {
      const directory = eventStateDirectory();
      for (const line of mailCommand(rest,{stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {}),callerGoal:process.env.GOAL_ID})) console.log(line);
      return 0;
    }
    case 'coordinator': await coordinatorCommand(rest); return 0;
    case 'regress': {
      // Worktree smoke runs can keep reports/inboxes in their writable checkout; QA still uses the shared host lock.
      const regressionState = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
      provideGoalctl({ declaredTestTimeout, planUnitGateShards, heavyQaStatus });
      const manifest = await runRegression({ ...parseRegressArgs(rest), repo: process.cwd(), stateDir: regressionState,
        route: entry => regressionState === stateDir ? withLedger(() => appendInbox(stateDir, entry))
          : Promise.resolve(appendInbox(regressionState, entry)) });
      console.log(`Regression ${manifest.runId}: ${manifest.status} at ${manifest.atCommit}`);
      console.log(`Manifest: ${join(regressionState, 'regress', manifest.runId, 'manifest.json')}`);
      return manifest.status === 'passed' ? 0 : 1;
    }
    case 'inbox': {
      const goal = process.env.GOAL_ID ?? 'program';
      if (!validGoalSlug(goal)) throw new Error('Invalid inbox Goal');
      if (rest.length && (rest.length !== 2 || rest[0] !== '--ack' || !/^\d+$/.test(rest[1]!))) {
        throw new Error('inbox accepts --ack <number> (the displayed line number)');
      }
      await withLedger(() => {
        const entries = inboxEntries(stateDir, goal, rest.length ? Number(rest[1]) : undefined);
        for (const entry of entries) console.log(JSON.stringify(entry));
        if (!entries.length) console.log(`Goal ${goal}: inbox empty`);
      });
      return 0;
    }
    case 'usage':
      console.log(JSON.stringify({ ...await usageReport(), measures: await goalMeasures(readLedger(), { root }) }, null, 2));
      return 0;
    case 'test': {
      const at = rest.indexOf('--result-file');
      const resultFile = at < 0 ? undefined : rest[at + 1];
      if (at >= 0 && (!resultFile || resultFile.startsWith('--'))) throw new Error('--result-file needs a path');
      const args = rest.filter((arg, index) => arg !== '--heavy' && (at < 0 || (index !== at && index !== at + 1)));
      return withSlot(['bun', 'scripts/qa/test.ts', ...args], isHeavyTest(rest), resultFile);
    }
    case 'slot': {
      if (rest[0] === '--recovery') {
        const command = rest.slice(1);
        return withRecovery(command[0] === '--' ? command.slice(1) : command);
      }
      const heavy = rest[0] === '--heavy';
      const command = heavy ? rest.slice(1) : rest;
      return withSlot(command[0] === '--' ? command.slice(1) : command, heavy);
    }
    default:
      console.error('Usage: goalctl goal start <slug> --manager <session> [--adopt] [--allow-area] | goal close <slug> [--dry-run]'
        + ' | new [--goal <slug>] <title> | dispatch <brief.md> [--dry-run] [--force-usage] [--allow-area]'
        + ' | wait <id> | owner <path> | reclaim <id> <brief> [--allow-area] | resume <id> (-m <text> | --file <path>) [--effort e]'
        + ` [--engine ${ENGINES.join('|')}] [--fresh] [--force-usage]`
        + ' | stop <id> | scope <id> | land <id> | merge <id> [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate] [--skip-type-gate]'
        + ' | gate <id> [--skip-unit-gate] [--skip-type-gate]'
        + ' | close <id>... verified|cancelled | tidy [--legacy <archive directory>]'
        + ' | status | usage | regress [--at <rev>] [--resume <run-id>] [--only <tiers>] [--integration-batches <n>]'
        + ' | mail send <goal> --file <path> --key <key> [--deadline <minutes>] | mail inbox [goal] | mail ack <id> [--goal <goal>]'
        + ' | coordinator [start <goal> --engine <codex|codex-1|claude> --effort <effort> [--model <id>]|enroll <goal> --session <UUID> --engine <engine> --effort <effort> --cwd <dir> --previous-owner-pid <pid> [--model <id>] [--tmux-socket <path>]|status|unenroll <goal>]'
        + ' | inbox [--ack <n>] | test [--heavy] <task test args> | slot [--heavy|--recovery] -- <command>');
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
