import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeGoals, briefPathOf, pidAlive, readLedger, root, stateDir, withLedger } from './ledger.ts';
import { capacityRefusal, lastAttempt, readResult, taskOf } from './launch.ts';
import { handoffResult } from './land.ts';
import { landingEnv } from './land-outside-turn.ts';
import { finishAttempt, landTask, closeTasks, canVerifyReadOnly, removeDispatchLeftover, resumeTask } from './tasks.ts';
import { CAPACITY_WAIT_MS, engineOf, programOf, type Task } from './types.ts';
import { processAlive, processIdentity } from '../qa/process/identity.ts';
import { directoryLeaseHeld } from '../qa/process/lease.ts';
import { classifyLandingRefusal } from './refusal.ts';
import { pumpQueue, type QueueLedger } from './queue.ts';
import { scheduleConfirmation, type ScheduleConfirmationOptions } from './confirm.ts';
import { parkedOnJob } from './job.ts';
import { pumpManagerCommits } from './manager-commit.ts';
import type { CapacityTask } from './claude-capacity.ts';

type Settlement = NonNullable<Task['settlement']>;
type SpawnSettlement = (task: Task, token: string) => Settlement['owner'];

interface AutomaticLanding {
  reportsBefore: string[];
  brief: string;
  branch: string;
  worktree: string;
  handoff: string;
  check?: string;
  output?: string;
  resumedAttempt?: number;
}

const runDirectory = (id: string) => join(stateDir, 'runs', id);
const landingRecord = (id: string, attempt: number) => join(runDirectory(id), `settle-${attempt}.json`);
const reviewDirectories = (id: string) => readdirSync(runDirectory(id)).filter(name => name.startsWith('review-')).sort();

function isWaveBuild(task: Task): boolean {
  return /^## Wave[ \t]*$/m.test(readFileSync(briefPathOf(task) ?? '', 'utf8'));
}

function landingStop(id: string, record: AutomaticLanding): string | undefined {
  return reviewDirectories(id).filter(name => !record.reportsBefore.includes(name))
    .map(name => join(runDirectory(id), name, 'stop.txt')).find(existsSync);
}

function readLanding(id: string, attempt: number): AutomaticLanding | undefined {
  const file = landingRecord(id, attempt);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as AutomaticLanding : undefined;
}

function writeLanding(id: string, attempt: number, record: AutomaticLanding): void {
  const file = landingRecord(id, attempt);
  writeFileSync(`${file}.tmp`, JSON.stringify(record));
  renameSync(`${file}.tmp`, file);
}

async function returnRefusal(task: Task, attempt: number): Promise<string | undefined> {
  const record = readLanding(task.id, attempt);
  if (!record) return;
  const output = landingStop(task.id, record);
  if (!output || (task as CapacityTask).claudeCapacity || task.land !== 'auto' || isWaveBuild(task)) return;
  const refusal = classifyLandingRefusal(output);
  if (refusal.kind === 'manager') return refusal.reason;
  if (task.branch !== record.branch || task.worktree !== record.worktree
    || readFileSync(briefPathOf(task) ?? '', 'utf8') !== record.brief
    || readResult(lastAttempt(task)).text !== record.handoff) return 'task or brief changed after landing stopped';
  if (!lastAttempt(task).session && !readResult(lastAttempt(task)).session) {
    return `worker session is missing; cannot return the refusal to its own session\n${refusal.message}`;
  }
  record.check = refusal.check;
  record.output = output;
  // Publish intent before resume. resumeTask publishes the new attempt under the ledger lock;
  // after a crash that attempt is enough to prevent a second send and to recover status.
  writeLanding(task.id, attempt, record);
  try { await resumeTask(task.id, ['-m', refusal.message]); }
  catch (error) { return `${firstLine(error)}\n${refusal.message}`; }
  record.resumedAttempt = attempt + 1;
  writeLanding(task.id, attempt, record);
  return;
}

export function spawnSettlement(task: Task, token: string,
  options: { start?: typeof spawn; directory?: string } = {}): Settlement['owner'] {
  const directory = options.directory ?? join(stateDir, 'runs', task.id);
  mkdirSync(directory, { recursive: true });
  const log = openSync(join(directory, 'settle.log'), 'a');
  try {
    const child = (options.start ?? spawn)(process.execPath, [import.meta.filename, task.id, String(lastAttempt(task).n), token], {
      cwd: root, detached: true, stdio: ['ignore', log, log],
      env: landingEnv({ ...process.env, GOAL_ID: task.goal ?? '' }),
    });
    child.on('error', error => console.error(`${task.id}: settlement start failed: ${error.message}`));
    if (!child.pid) throw new Error(`${task.id}: settlement process did not start`);
    child.unref();
    return processIdentity(child.pid) ?? { pid: child.pid };
  } finally { closeSync(log); }
}

/** Whether the task's last attempt has ended with nobody settling it. A pass asks without the ledger lock, so
 * that it takes the lock only for a task that needs it; `claim` asks again under the lock. */
export function settlementOwed(task: Task): boolean {
  if (!task.attempts.length || task.waitingResume || (task as CapacityTask).claudeCapacity?.pause
    || ['verified', 'cancelled'].includes(task.state)) return false;
  const attempt = lastAttempt(task);
  if (pidAlive(attempt.pid, programOf(engineOf(attempt)))) return false;
  if (parkedOnJob(task, attempt.n, readResult(attempt).text)) return false;
  const previous = task.settlement;
  return !(previous?.attempt === attempt.n && (previous.settledAt || processAlive(previous.owner)));
}

/** A preparation whose process died leaves a `starting` task that holds its claims and a worker's place for
 * good. It is removed and its brief queued again; the reservation had already passed admission. */
export function recoverDiedPreparations(ledger: QueueLedger,
  alive: (owner: NonNullable<Task['preparer']>) => boolean = processAlive): Task[] {
  const died = Object.values(ledger.tasks).filter(task => task.state === 'starting' && task.preparer && !alive(task.preparer));
  for (const task of died) {
    delete ledger.tasks[task.id];
    const entry = (ledger.queue ??= {})[task.id];
    if (entry) delete entry.owner;
    else ledger.queue[task.id] = { id: task.id, brief: task.brief, ...task.goal ? { goal: task.goal } : {},
      queuedAt: new Date().toISOString(), waits: [], allowArea: true };
  }
  return died;
}

/** The ledger lock publishes ownership before a child can inspect its token. */
async function claim(id: string, detached: boolean, start: SpawnSettlement): Promise<Settlement | undefined> {
  return withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (!settlementOwed(task)) return;
    const attempt = lastAttempt(task);
    attempt.endedAt ??= new Date().toISOString();
    if (task.state === 'running') task.state = 'exited';
    const token = randomUUID();
    task.settlement = { attempt: attempt.n, token, owner: processIdentity(process.pid) ?? { pid: process.pid } };
    if (detached) {
      try { task.settlement.owner = start(task, token); }
      catch (error) {
        task.settlement.settledAt = new Date().toISOString();
        task.settlement.reason = firstLine(error);
      }
    }
    return task.settlement;
  });
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!;
}

export function settlementReason(task: Task): string | undefined {
  const settlement = task.settlement;
  const attempt = lastAttempt(task);
  const record = attempt.n > 1 && attempt.round === 'fix' ? readLanding(task.id, attempt.n - 1) : undefined;
  const sent = record?.check && (!record.resumedAttempt || record.resumedAttempt === attempt.n)
    ? `fix round sent by tool for ${record.check}; whole output: ${record.output}` : undefined;
  const reason = settlement?.attempt === attempt.n && settlement.settledAt ? settlement.reason : undefined;
  return [sent, reason].filter(Boolean).join('\n  ') || undefined;
}

export async function runSettlement(id: string, attemptNumber: number, token: string,
  options: { capacityWaitMs?: number } = {}): Promise<void> {
  let task = await withLedger(ledger => taskOf(ledger, id));
  if (task.settlement?.token !== token || task.settlement.attempt !== attemptNumber
    || task.settlement.settledAt || lastAttempt(task).n !== attemptNumber) return;
  let reason: string;
  try {
    const attempt = lastAttempt(task);
    if (capacityRefusal(attempt)) {
      const pause = options.capacityWaitMs ?? CAPACITY_WAIT_MS;
      console.log(`${id} attempt ${attempt.n} was refused for capacity; resuming the same session in ${Math.round(pause / 1000)} s`);
      await Bun.sleep(pause);
    }
    const outcome = await finishAttempt(id, attemptNumber);
    if (outcome.kind !== 'ended') return;
    task = outcome.task;
    const result = readResult(lastAttempt(task));
    const handoff = handoffResult(result.text);
    const next = /^NEXT:[ \t]*(.*)$/m.exec(result.text)?.[1]?.trim();
    if (outcome.refused) reason = `${id} not continued after a ${capacityRefusal(attempt) ? 'capacity refusal' : 'transport error'}: ${firstLine(outcome.refused)}`;
    else if (result.error || handoff !== 'done') reason = `${result.error ? 'worker handoff is missing or reports an error; ' : ''}RESULT: ${handoff ?? 'missing'}${next ? `; NEXT: ${next}` : ''}`;
    else if (task.state === 'conflict') reason = task.refusal ?? 'landing stopped';
    else if (task.state !== 'exited' && task.state !== 'merged') reason = `task is ${task.state}`;
    else if (isWaveBuild(task)) reason = 'wave build task needs program disposition; it cannot land individually';
    else if (task.state === 'merged' || canVerifyReadOnly(task)) {
      await closeTasks([id], 'verified');
      reason = 'landed and verified';
    } else if ((task as CapacityTask).claudeCapacity || task.land !== 'auto') {
      reason = (task as CapacityTask).claudeCapacity ? 'Claude capacity tasks need a manager landing decision'
        : `${task.kind ?? 'implementation'} task needs a manager landing decision (land: auto is absent)`;
    } else {
      const record = readLanding(id, attemptNumber);
      if (record && landingStop(id, record)) throw new Error('landing stopped');
      if (!record) {
        const managerStop = reviewDirectories(id).map(name => join(runDirectory(id), name, 'stop.txt'))
          .find(file => existsSync(file) && statSync(file).mtimeMs >= Date.parse(attempt.startedAt));
        if (managerStop) throw new Error(readFileSync(managerStop, 'utf8'));
      }
      if (directoryLeaseHeld(join(runDirectory(id), 'land.lock'))) throw new Error('landing is already being watched by its caller');
      writeLanding(id, attemptNumber, { reportsBefore: reviewDirectories(id), brief: readFileSync(briefPathOf(task) ?? '', 'utf8'),
        branch: task.branch, worktree: task.worktree, handoff: result.text });
      await landTask(id);
      reason = 'landed and verified';
    }
  } catch (error) { reason = firstLine(error); }
  task = taskOf(readLedger(), id);
  if (lastAttempt(task).n === attemptNumber) {
    try { reason = await returnRefusal(task, attemptNumber) ?? reason; }
    catch (error) { reason = `${firstLine(error)}; ${reason}`; }
  }
  await withLedger(ledger => {
    const current = taskOf(ledger, id);
    if (lastAttempt(current).n !== attemptNumber || current.settlement?.token !== token) return;
    current.settlement.settledAt = new Date().toISOString();
    current.settlement.reason = reason;
  });
}

/** A waiter claims an unowned exit; otherwise it only observes the detached settlement. */
export async function settleTask(id: string, options: { capacityWaitMs?: number } = {}): Promise<void> {
  const claimed = await claim(id, false, spawnSettlement);
  if (claimed && !claimed.settledAt) await runSettlement(id, claimed.attempt, claimed.token, options);
}

/** One quick pass over every active Goal, including Goals without enrolled managers. */
export async function settlePass(options: { spawn?: SpawnSettlement; confirmation?: ScheduleConfirmationOptions } = {}): Promise<void> {
  pumpManagerCommits(root, stateDir);
  const ledger = readLedger();
  const goals = activeGoals(ledger);
  if (recoverDiedPreparations(structuredClone(ledger) as QueueLedger).length) {
    for (const task of await withLedger((current: QueueLedger) => recoverDiedPreparations(current))) {
      // An unshared half-prepared worktree is removed; one that other tasks use stays as it is.
      try { removeDispatchLeftover(readLedger(), task.id, task.worktree, task.branch); } catch { /* still in use */ }
      console.log(`${task.id}: its preparation died; queued again`);
    }
  }
  for (const task of Object.values(ledger.tasks)) {
    if (task.goal && goals.includes(task.goal) && settlementOwed(task)) await claim(task.id, true, options.spawn ?? spawnSettlement);
  }
  await pumpQueue();
  scheduleConfirmation(options.confirmation ?? { repo: root, stateDir });
}

if (import.meta.main) {
  await runSettlement(process.argv[2]!, Number(process.argv[3]), process.argv[4]!);
}
