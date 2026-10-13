import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { activeGoals, pidAlive, readLedger, root, stateDir, withLedger } from './ledger.ts';
import { capacityRefusal, lastAttempt, readResult, taskOf } from './launch.ts';
import { handoffResult } from './land.ts';
import { finishAttempt, landTask, closeTasks, canVerifyReadOnly } from './tasks.ts';
import { CAPACITY_WAIT_MS, engineOf, programOf, type Task } from './types.ts';
import { processAlive, processIdentity } from '../qa/process/identity.ts';

type Settlement = NonNullable<Task['settlement']>;
type SpawnSettlement = (task: Task, token: string) => Settlement['owner'];

function spawnSettlement(task: Task, token: string): Settlement['owner'] {
  const directory = join(stateDir, 'runs', task.id);
  mkdirSync(directory, { recursive: true });
  const log = openSync(join(directory, 'settle.log'), 'a');
  try {
    const child = spawn(process.execPath, [import.meta.filename, task.id, String(lastAttempt(task).n), token], {
      cwd: root, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, GOAL_ID: task.goal ?? '' },
    });
    child.on('error', error => console.error(`${task.id}: settlement start failed: ${error.message}`));
    if (!child.pid) throw new Error(`${task.id}: settlement process did not start`);
    child.unref();
    return processIdentity(child.pid) ?? { pid: child.pid };
  } finally { closeSync(log); }
}

/** The ledger lock publishes ownership before a child can inspect its token. */
async function claim(id: string, detached: boolean, start: SpawnSettlement): Promise<Settlement | undefined> {
  return withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (!task.attempts.length || ['verified', 'cancelled'].includes(task.state)) return;
    const attempt = lastAttempt(task);
    if (pidAlive(attempt.pid, programOf(engineOf(attempt)))) return;
    const previous = task.settlement;
    if (previous?.attempt === attempt.n && (previous.settledAt || processAlive(previous.owner))) return;
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
  return settlement?.attempt === lastAttempt(task).n && settlement.settledAt ? settlement.reason : undefined;
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
    else if (task.land !== 'auto' && !['outcome', 'surface', 'tooling'].includes(task.kind ?? '')) {
      reason = `${task.kind ?? 'implementation'} task needs a manager landing decision (land: auto is absent)`;
    } else {
      if (task.state === 'merged' || canVerifyReadOnly(task)) await closeTasks([id], 'verified');
      else await landTask(id);
      reason = 'landed and verified';
    }
  } catch (error) { reason = firstLine(error); }
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
export async function settlePass(options: { spawn?: SpawnSettlement } = {}): Promise<void> {
  const ledger = readLedger();
  const goals = activeGoals(ledger);
  for (const task of Object.values(ledger.tasks)) {
    if (task.goal && goals.includes(task.goal)) await claim(task.id, true, options.spawn ?? spawnSettlement);
  }
}

if (import.meta.main) {
  await runSettlement(process.argv[2]!, Number(process.argv[3]), process.argv[4]!);
}
