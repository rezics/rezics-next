import { recordedFailure, qaFailure, type JobResultClass } from '../qa/failure.ts';
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { constants } from 'node:os';
import { checkFailureLines } from './check.ts';
import { lastAttempt, launch, readResult, running } from './launch.ts';
import { admitWorkers } from './tasks.ts';
import { git, managerOf, readLedger, stateDir, withLedger } from './ledger.ts';
import { engineOf, type Ledger, type Task } from './types.ts';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { gateRefusal } from './queue.ts';
import { GoalMailStore } from './mail.ts';
import type { CapacityTask } from './claude-capacity.ts';

export const JOB_INLINE_MS = 20_000;
// A parked worker costs nothing while it waits; a dead command is caught by the owner check, so this bound only
// catches a command that hangs. The merge gate's unit and owner run takes more than 45 minutes.
export const JOB_WAIT_MS = 4 * 60 * 60_000;
export const parkedResult = (text: string): boolean => /^RESULT:[ \t]*parked[ \t]*$/m.test(text);

/** A turn that ended while its own job is parked or waking is that job's to continue, whatever it wrote, unless it
 * handed off a final RESULT. A Grok session can end mid-step with prose only. */
export function parkedOnJob(task: Task, attempt: number, text: string): boolean {
  if (parkedResult(text)) return true;
  if (/^RESULT:[ \t]*\w+/m.test(text) || !task.worktree) return false;
  const directory = jobDirectory(task.worktree);
  if (!existsSync(join(directory, 'jobs.sqlite'))) return false;
  const store = new JobStore(directory);
  try { return store.all().some(job => job.task === task.id && job.attempt === attempt && ['parked', 'waking'].includes(job.phase)); }
  finally { store.close(); }
}
export const jobDirectory = (cwd: string): string => join(cwd, '.temp/goal/jobs');

/** Coordination follows the main checkout even when a wave deliberately keeps an older application tree. */
export const jobRuntime = (cwd: string): string => join(dirname(git(cwd,
  ['rev-parse', '--path-format=absolute', '--git-common-dir'])), 'scripts/goal/job.ts');

export interface JobStep {
  command: string[]; started?: number; code?: number; ended?: number; reason?: string; signal?: NodeJS.Signals;
}

export interface Job {
  id: string; task: string; attempt: number; cwd: string; command: string[]; created: number;
  phase: 'running' | 'inline' | 'parked' | 'waking' | 'woken' | 'reported';
  owner?: Pick<ProcessIdentity, 'pid'> & Partial<ProcessIdentity>;
  executor?: Pick<ProcessIdentity, 'pid'> & Partial<ProcessIdentity>;
  signal?: NodeJS.Signals;
  code?: number; ended?: number; resumedAttempt?: number; reason?: string;
  sequence?: JobStep[]; current?: number; timeoutMs?: number;
  resultClass?: JobResultClass;
  capacityPausedAt?: number; capacityDelayMs?: number;
}

/** Jobs stay with their worktree; the resident coordinator discovers them from its task ledger. */
export class JobStore {
  readonly db: Database;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, 'jobs.sqlite'));
    this.db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  }
  get(id: string): Job | undefined {
    const row = this.db.query('SELECT record FROM jobs WHERE id=?').get(id) as { record: string } | null;
    return row ? JSON.parse(row.record) as Job : undefined;
  }
  all(): Job[] {
    return (this.db.query('SELECT record FROM jobs').all() as { record: string }[]).map(row => JSON.parse(row.record) as Job);
  }
  put(job: Job): void { this.db.query('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(job.id, JSON.stringify(job)); }
  update(id: string, change: (job: Job) => void): Job {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      change(job); this.put(job); return job;
    }).immediate();
  }
  log(id: string, step?: number): string { return join(this.directory, `${id}${step === undefined ? '' : `.${step + 1}`}.log`); }
  close(): void { this.db.close(); }
}

function childResult(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
}

function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/** Each command gets the ordinary executor group and admission, but only the sequence owns a continuation. */
async function ownSequence(store: JobStore, job: Job): Promise<void> {
  for (let index = 0; index < job.sequence!.length; index++) {
    const path = store.log(job.id, index);
    const current = store.update(job.id, record => {
      if (record.code !== undefined) return;
      record.current = index; delete record.executor;
      record.sequence![index]!.started = Date.now();
    });
    if (current.code !== undefined) return;
    const step = current.sequence![index]!;
    appendFileSync(path, `$ ${step.command.join(' ')}\n`);
    const log = openSync(path, 'a');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const child = spawn(process.execPath, [jobRuntime(job.cwd), '--run', store.directory, job.id], {
        cwd: job.cwd, detached: true, stdio: ['ignore', log, log],
      });
      const result = childResult(child);
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killGroup(child.pid);
      }, job.timeoutMs ?? JOB_WAIT_MS);
      const { code, signal } = await result;
      if (signal && child.pid) killGroup(child.pid);
      store.update(job.id, record => {
        const finished = record.sequence![index]!;
        if (timedOut || finished.code === undefined) {
          finished.code = timedOut ? 124 : signal ? 128 + constants.signals[signal] : code || 1;
          finished.reason = timedOut ? `command timed out after ${job.timeoutMs ?? JOB_WAIT_MS}ms`
            : signal ? `executor exited with signal ${signal}` : `executor exited with status ${code} without recording a result`;
          finished.ended = Date.now();
          if (signal) finished.signal = signal;
          appendFileSync(path, `error: ${finished.reason}\n`);
        }
        if (finished.code !== 0 || index === record.sequence!.length - 1) {
          record.code = finished.code; record.ended = finished.ended;
          record.reason = finished.reason; record.signal = finished.signal;
        }
      });
      if (store.get(job.id)!.code !== undefined) return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      closeSync(log);
    }
  }
}

/** The supervisor survives the caller and can record even SIGKILL of the executor. Both have their own
 * process groups; commands retain their existing Task memory and QA-slot admission. */
async function jobProcess(directory: string, id: string, role: 'owner' | 'executor'): Promise<void> {
  const path = join(directory, `${id}.log`);
  appendFileSync(path, `${new Date().toISOString()} job:${id} ${role} started pid:${process.pid}\n`);
  let store: JobStore | undefined;
  let log: number | undefined;
  try {
    store = new JobStore(directory);
    // BEGIN IMMEDIATE waits for publication, including callers that still launch within a transaction.
    // An ordinary SELECT in WAL mode can read the old snapshot and see no job at all.
    const job = store.update(id, current => {
      current[role] = processIdentity(process.pid) ?? { pid: process.pid };
    });
    if (role === 'owner' && job.sequence) { await ownSequence(store, job); return; }
    const command = job.sequence ? job.sequence[job.current!]!.command : job.command;
    const commandPath = job.sequence ? store.log(id, job.current) : path;
    log = openSync(commandPath, 'a');
    const child = role === 'owner'
      ? spawn(process.execPath, [jobRuntime(job.cwd), '--run', directory, id], {
        cwd: job.cwd, detached: true, stdio: ['ignore', log, log],
      })
      : spawn(command[0]!, command.slice(1), { cwd: job.cwd, stdio: ['ignore', log, log] });
    const { code, signal } = await childResult(child);
    const reason = signal ? `${role === 'owner' ? 'executor' : 'command'} exited with signal ${signal}`
      : role === 'owner' ? `executor exited with status ${code} without recording a result` : undefined;
    if (role === 'owner' && signal && child.pid) {
      // The executor cannot reap its command after SIGKILL. Its separate group contains only this job.
      killGroup(child.pid);
    }
    store.update(id, current => {
      const result = current.sequence ? current.sequence[current.current!]! : current;
      if (result.code !== undefined || current.code !== undefined) return;
      if (reason) appendFileSync(commandPath, `error: ${reason}\n`);
      result.code = signal ? 128 + constants.signals[signal] : role === 'owner' ? code || 1 : code ?? 1;
      result.ended = Date.now();
      if (reason) result.reason = reason;
      if (signal) result.signal = signal;
    });
  } catch (error) {
    const reason = `error: ${role}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    appendFileSync(path, `${reason}\n`);
    process.exitCode = 1;
    if (store?.get(id)) {
      store.update(id, current => {
        const result = role === 'executor' && current.sequence ? current.sequence[current.current!]! : current;
        if (result.code !== undefined) return;
        result.code = 1; result.ended = Date.now(); result.reason = reason;
      });
    }
  } finally {
    if (log !== undefined) closeSync(log);
    if (store) {
      try {
        // Completion owns the first wake; the coordinator retries if this process dies or admission waits.
        const result = store.get(id);
        if (result?.code !== undefined && !(role === 'executor' && result.sequence)) {
          store.update(id, current => { current.resultClass = jobResultClass(store!, current); });
          await wakeJobs(store, {}, id);
        }
      } catch (error) {
        appendFileSync(path, `error: job wake: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally { store.close(); }
    }
  }
}

export const executeJob = (directory: string, id: string): Promise<void> => jobProcess(directory, id, 'executor');

export async function runJob(command: string[], options: {
  cwd?: string; task?: Task; inlineMs?: number; print?: (line: string) => void; timeoutMs?: number;
} = {}): Promise<number> {
  const then: string[][] = [];
  while (command[0] === '--then') {
    if (!command[1]?.trim() || command[1] === '--') throw new Error('--then needs a nonempty shell command');
    then.push(['/bin/sh', '-c', command[1]]);
    command = command.slice(2);
  }
  if (then.length && command[0] !== '--') throw new Error('job --then needs -- <first command…>');
  if (command[0] === '--') command = command.slice(1);
  if (!command.length) throw new Error('job needs -- <command…>');
  const cwd = resolve(options.cwd ?? process.cwd());
  const task = options.task ?? readLedger().tasks[process.env.GOAL_TASK_ID ?? ''];
  if (!task || resolve(task.worktree) !== cwd) throw new Error('job must run in its worker worktree with GOAL_TASK_ID');
  const print = options.print ?? console.log;
  const store = new JobStore(jobDirectory(cwd));
  const job: Job = { id: randomUUID(), task: task.id, attempt: lastAttempt(task).n, cwd, command,
    created: Date.now(), phase: 'running',
    ...(then.length ? { sequence: [command, ...then].map(command => ({ command })), timeoutMs: options.timeoutMs ?? JOB_WAIT_MS } : {}) };
  try {
    // Commit the record before starting anything that reads it on another connection.
    if (store.all().some(current => current.task === task.id && ['parked', 'waking'].includes(current.phase))) {
      throw new Error('A parked job already owns this worker continuation');
    }
    store.put(job);
    const log = openSync(store.log(job.id), 'a');
    try {
      const child = spawn(process.execPath, [jobRuntime(cwd), '--own', store.directory, job.id], {
        cwd, detached: true, stdio: ['ignore', log, log],
      });
      await new Promise<void>((resolveStart, reject) => {
        child.once('spawn', resolveStart); child.once('error', reject);
      });
      store.update(job.id, current => { current.owner = processIdentity(child.pid!) ?? { pid: child.pid! }; });
      child.unref();
    } catch (error) {
      const reason = `error: owner launch: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
      appendFileSync(store.log(job.id), `${reason}\n`);
      store.update(job.id, current => { current.code = 1; current.ended = Date.now(); current.reason = reason; });
    } finally { closeSync(log); }
    const deadline = job.created + (options.inlineMs ?? JOB_INLINE_MS);
    while (store.get(job.id)!.code === undefined && Date.now() < deadline) await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    const result = store.update(job.id, current => { current.phase = current.code === undefined ? 'parked' : 'inline'; });
    if (result.phase === 'inline') {
      print(result.sequence ? jobResult(store, result) : readFileSync(store.log(job.id), 'utf8'));
      print(`job:${job.id} exit:${result.code}; whole output: ${store.log(job.id)}`);
      return result.code!;
    }
    print(`PARKED job:${job.id}; end your turn with RESULT: parked`);
    return 0;
  } finally { store.close(); }
}

/** The first recorded QA failure survives later cleanup errors; plain commands retain a conservative fallback. */
export function jobResultClass(store: JobStore, job: Job): JobResultClass {
  if (job.code === 0) return 'passed';
  if (job.resultClass) return job.resultClass;
  const paths = job.sequence ? job.sequence.map((_, index) => store.log(job.id, index)) : [store.log(job.id)];
  const output = paths.filter(existsSync).map(path => readFileSync(path, 'utf8')).join('\n');
  return recordedFailure(output) ?? qaFailure({ timedOut: job.code === 124 || /timed out/.test(job.reason ?? ''), output },
    job.reason || job.signal ? 'harness' : 'test', /(?:^\s*\(fail\)|<failure\b|<error\b)/m.test(output));
}

export function jobResult(store: JobStore, job: Job): string {
  if (job.sequence) {
    const failed = job.code !== 0 ? job.sequence[job.current ?? 0] : undefined;
    const log = store.log(job.id, job.current ?? 0);
    const summary = failed
      ? `Command: ${failed.command.join(' ')}\nReason: ${job.reason ?? failed.reason ?? 'command failed'}\n`
        + (existsSync(log) ? checkFailureLines(readFileSync(log, 'utf8')).join('\n').slice(0, 12_000) : '')
        + `\nWhole output: ${log}`
      : job.sequence.map((step, index) => `${index + 1}. exit:${step.code} ${step.command.join(' ').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}; log: ${store.log(job.id, index)}`).join('\n');
    return `Job job:${job.id} finished with exit status ${job.code}.\nResult class: ${jobResultClass(store, job)}\n${summary}\nContinue where you parked; this is a continuation, not a fix round.`;
  }
  const lines = job.code ? checkFailureLines(readFileSync(store.log(job.id), 'utf8')) : [];
  return `Job job:${job.id} finished with exit status ${job.code}.\nResult class: ${jobResultClass(store, job)}\nCommand: ${job.command.join(' ')}\n`
    + (job.reason ? `Reason: ${job.reason.slice(0, 2000)}\n` : '')
    + `${lines.join('\n').slice(0, 12_000)}\nWhole output: ${store.log(job.id)}\nContinue where you parked; this is a continuation, not a fix round.`;
}

export interface JobPassOptions {
  mutate?: (work: (ledger: Ledger) => void) => Promise<unknown>;
  admit?: typeof admitWorkers;
  start?: typeof launch;
  alive?: typeof processAlive;
  report?: (job: Job, reason: string, ledger: Ledger) => void;
  now?: number;
}

function reportJob(job: Job, reason: string, ledger: Ledger): void {
  const goal = ledger.tasks[job.task]?.goal;
  if (!goal) throw new Error(`Job ${job.id} has no Goal manager`);
  const mail = new GoalMailStore({ stateDir, goals: Object.keys(ledger.goals ?? {}), sender: goal });
  try { mail.send(goal, `${job.task}: job:${job.id} needs its manager: ${reason}\nLog: ${join(jobDirectory(job.cwd), `${job.id}.log`)}`, `job:${job.id}`); }
  finally { mail.close(); }
}

/** The ledger lock serializes wake intent and attempt publication with settlement and manager resumes.
 * An interrupted intent is reconciled from the published continuation, never blindly sent again. */
export async function wakeJobs(store: JobStore, options: JobPassOptions = {}, id?: string): Promise<void> {
  const candidates = id === undefined ? store.all() : [store.get(id)].filter((job): job is Job => job !== undefined);
  for (const candidate of candidates.filter(job => ['parked', 'waking'].includes(job.phase))) {
    let woke: number | undefined;
    await (options.mutate ?? withLedger)(ledger => {
      const job = store.get(candidate.id)!;
      if (!['parked', 'waking'].includes(job.phase)) return;
      const task = ledger.tasks[job.task];
      const attempt = task?.attempts.find(attempt => attempt.n === job.attempt);
      const next = task?.attempts.find(attempt => attempt.n === job.attempt + 1);
      if (job.phase === 'waking' && next?.continuedFor === 'job') {
        woke = next.n; return;
      }
      const pause = (task as CapacityTask | undefined)?.claudeCapacity?.pause;
      const now = options.now ?? Date.now();
      const waitingSince = job.sequence ? job.ended : job.created;
      // Quota interruption retains the worker's continuation; it is neither a handoff nor a lost job.
      // A native capacity resume owns the next turn. The ordinary adoption path below then reconciles
      // this job with that turn, without a second concurrent wake or charging the reset wait as a hang.
      if (pause && task?.state === 'stopped') {
        if (job.capacityPausedAt === undefined) store.update(job.id, current => { current.capacityPausedAt = pause.at; });
        return;
      }
      if (job.capacityPausedAt !== undefined) {
        const updated = store.update(job.id, current => {
          current.capacityDelayMs = (current.capacityDelayMs ?? 0)
            + Math.max(0, now - Math.max(current.capacityPausedAt!, waitingSince ?? now));
          delete current.capacityPausedAt;
        });
        job.capacityDelayMs = updated.capacityDelayMs;
      }
      const report = (reason: string) => {
        (options.report ?? reportJob)(job, reason, ledger);
        store.update(job.id, current => { current.phase = 'reported'; current.reason = reason; });
      };
      if (waitingSince !== undefined && now - waitingSince - (job.capacityDelayMs ?? 0) > JOB_WAIT_MS) { report('wait exceeded 4 hours'); return; }
      const later = task && lastAttempt(task).n > job.attempt && !['verified', 'cancelled', 'stopped'].includes(task.state)
        ? lastAttempt(task) : undefined;
      if (later) {
        // A resume while this job ran replaced its attempt. The later attempt waits for it if still running, and
        // adopts it once it has ended parked or mid-step without a job of its own; a final handoff goes to the manager.
        if (running(task!)) return;
        const final = /^RESULT:[ \t]*(\w+)/m.exec(readResult(later).text)?.[1];
        const owned = store.all().some(other => other.id !== job.id && other.attempt === later.n
          && ['parked', 'waking'].includes(other.phase));
        if ((!final || final === 'parked') && !owned) { store.update(job.id, current => { current.attempt = later.n; }); return; }
      }
      if (!task || !attempt || lastAttempt(task).n !== job.attempt || ['verified', 'cancelled', 'stopped'].includes(task.state)) {
        report('worker attempt was replaced or closed'); return;
      }
      if (job.phase === 'waking') { report('wake intent has no published attempt; reconcile before another resume'); return; }
      if (job.code === undefined) {
        if (!job.owner || !(options.alive ?? processAlive)(job.owner)) {
          const reason = 'command owner exited without recording a result';
          let lost = false;
          store.update(job.id, current => {
            // Recheck under the write lock: an executor may have committed its result after our read.
            if (current.code !== undefined) return;
            appendFileSync(store.log(job.id), `error: ${reason}\n`);
            current.code = 1; current.ended = Date.now(); current.reason = reason;
            if (current.sequence) {
              const step = current.sequence[current.current ?? 0]!;
              step.code = 1; step.ended = current.ended; step.reason = reason;
              if (current.executor && processAlive(current.executor)) killGroup(current.executor.pid);
            }
            lost = true;
          });
          if (lost && !job.sequence) report(reason);
        }
        return;
      }
      if (running(task)) return;
      const result = readResult(attempt);
      // A session that ended mid-step without any handoff (Grok does) still owes this job its continuation;
      // only a final handoff while the job ran goes to the manager.
      const final = /^RESULT:[ \t]*(\w+)/m.exec(result.text)?.[1];
      if (final && final !== 'parked') { report(`worker handed off RESULT: ${final} while its job ran`); return; }
      const session = attempt.session || result.session;
      if (!session) { report('worker session is missing; cannot resume'); return; }
      try { (options.admit ?? admitWorkers)(Object.values(ledger.tasks), engineOf(attempt), false); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!gateRefusal(reason)) report(reason);
        return;
      }
      store.update(job.id, current => { current.phase = 'waking'; current.resultClass = jobResultClass(store, current); });
      try {
        attempt.endedAt ??= new Date().toISOString(); attempt.session = session;
        const resumed = (options.start ?? launch)(task, attempt.effort, session, jobResult(store, job), true,
          managerOf(ledger, task.goal), engineOf(attempt), 'continuation');
        resumed.continuedFor = 'job'; resumed.jobResult = jobResultClass(store, job); task.attempts.push(resumed); task.state = 'running';
        woke = resumed.n;
      } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    });
    // Acknowledge only after withLedger durably publishes the native attempt.
    if (woke !== undefined) store.update(candidate.id, current => { current.phase = 'woken'; current.resumedAttempt = woke; });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === '--run' || mode === '--own') {
    try { await jobProcess(process.argv[3]!, process.argv[4]!, mode === '--own' ? 'owner' : 'executor'); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
}
