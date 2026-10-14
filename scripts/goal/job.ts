import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { constants } from 'node:os';
import { checkFailureLines } from './check.ts';
import { lastAttempt, launch, readResult, running } from './launch.ts';
import { admitWorkers } from './tasks.ts';
import { managerOf, readLedger, stateDir, withLedger } from './ledger.ts';
import { engineOf, type Ledger, type Task } from './types.ts';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { gateRefusal } from './queue.ts';
import { GoalMailStore } from './mail.ts';

export const JOB_INLINE_MS = 20_000;
export const JOB_WAIT_MS = 45 * 60_000;
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

export interface Job {
  id: string; task: string; attempt: number; cwd: string; command: string[]; created: number;
  phase: 'running' | 'inline' | 'parked' | 'waking' | 'woken' | 'reported';
  owner?: Pick<ProcessIdentity, 'pid'> & Partial<ProcessIdentity>;
  executor?: Pick<ProcessIdentity, 'pid'> & Partial<ProcessIdentity>;
  signal?: NodeJS.Signals;
  code?: number; ended?: number; resumedAttempt?: number; reason?: string;
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
  log(id: string): string { return join(this.directory, `${id}.log`); }
  close(): void { this.db.close(); }
}

function childResult(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
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
    log = openSync(path, 'a');
    const child = role === 'owner'
      ? spawn(process.execPath, [import.meta.filename, '--run', directory, id], {
        cwd: job.cwd, detached: true, stdio: ['ignore', log, log],
      })
      : spawn(job.command[0]!, job.command.slice(1), { cwd: job.cwd, stdio: ['ignore', log, log] });
    const { code, signal } = await childResult(child);
    const reason = signal ? `${role === 'owner' ? 'executor' : 'command'} exited with signal ${signal}`
      : role === 'owner' ? `executor exited with status ${code} without recording a result` : undefined;
    if (role === 'owner' && signal && child.pid) {
      // The executor cannot reap its command after SIGKILL. Its separate group contains only this job.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    store.update(id, current => {
      if (current.code !== undefined) return;
      if (reason) appendFileSync(path, `error: ${reason}\n`);
      current.code = signal ? 128 + constants.signals[signal] : role === 'owner' ? code || 1 : code ?? 1;
      current.ended = Date.now();
      if (reason) current.reason = reason;
      if (signal) current.signal = signal;
    });
  } catch (error) {
    const reason = `error: ${role}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    appendFileSync(path, `${reason}\n`);
    process.exitCode = 1;
    if (store?.get(id)) {
      store.update(id, current => {
        if (current.code !== undefined) return;
        current.code = 1; current.ended = Date.now(); current.reason = reason;
      });
    }
  } finally {
    if (log !== undefined) closeSync(log);
    if (store) {
      try {
        // Completion owns the first wake; the coordinator retries if this process dies or admission waits.
        if (store.get(id)?.code !== undefined) await wakeJobs(store, {}, id);
      } catch (error) {
        appendFileSync(path, `error: job wake: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally { store.close(); }
    }
  }
}

export const executeJob = (directory: string, id: string): Promise<void> => jobProcess(directory, id, 'executor');

export async function runJob(command: string[], options: {
  cwd?: string; task?: Task; inlineMs?: number; print?: (line: string) => void;
} = {}): Promise<number> {
  if (command[0] === '--') command = command.slice(1);
  if (!command.length) throw new Error('job needs -- <command…>');
  const cwd = resolve(options.cwd ?? process.cwd());
  const task = options.task ?? readLedger().tasks[process.env.GOAL_TASK_ID ?? ''];
  if (!task || resolve(task.worktree) !== cwd) throw new Error('job must run in its worker worktree with GOAL_TASK_ID');
  const print = options.print ?? console.log;
  const store = new JobStore(jobDirectory(cwd));
  const job: Job = { id: randomUUID(), task: task.id, attempt: lastAttempt(task).n, cwd, command,
    created: Date.now(), phase: 'running' };
  try {
    // Commit the record before starting anything that reads it on another connection.
    if (store.all().some(current => current.task === task.id && ['parked', 'waking'].includes(current.phase))) {
      throw new Error('A parked job already owns this worker continuation');
    }
    store.put(job);
    const log = openSync(store.log(job.id), 'a');
    try {
      const child = spawn(process.execPath, [import.meta.filename, '--own', store.directory, job.id], {
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
      print(readFileSync(store.log(job.id), 'utf8'));
      print(`job:${job.id} exit:${result.code}; whole output: ${store.log(job.id)}`);
      return result.code!;
    }
    print(`PARKED job:${job.id}; end your turn with RESULT: parked`);
    return 0;
  } finally { store.close(); }
}

export function jobResult(store: JobStore, job: Job): string {
  const lines = job.code ? checkFailureLines(readFileSync(store.log(job.id), 'utf8')) : [];
  return `Job job:${job.id} finished with exit status ${job.code}.\nCommand: ${job.command.join(' ')}\n`
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
      const report = (reason: string) => {
        (options.report ?? reportJob)(job, reason, ledger);
        store.update(job.id, current => { current.phase = 'reported'; current.reason = reason; });
      };
      if ((options.now ?? Date.now()) - job.created > JOB_WAIT_MS) { report('wait exceeded 45 minutes'); return; }
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
            lost = true;
          });
          if (lost) report(reason);
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
      store.update(job.id, current => { current.phase = 'waking'; });
      try {
        attempt.endedAt ??= new Date().toISOString(); attempt.session = session;
        const resumed = (options.start ?? launch)(task, attempt.effort, session, jobResult(store, job), true,
          managerOf(ledger, task.goal), engineOf(attempt), 'continuation');
        resumed.continuedFor = 'job'; task.attempts.push(resumed); task.state = 'running';
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
