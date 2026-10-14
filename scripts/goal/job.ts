import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkFailureLines } from './check.ts';
import { lastAttempt, launch, readResult, running } from './launch.ts';
import { admitWorkers } from './tasks.ts';
import { managerOf, readLedger, stateDir, withLedger } from './ledger.ts';
import { engineOf, type Ledger, type Task } from './types.ts';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { gateRefusal } from './queue.ts';
import { GoalMailStore } from './mail.ts';

export const JOB_INLINE_MS = 90_000;
export const JOB_WAIT_MS = 45 * 60_000;
export const parkedResult = (text: string): boolean => /^RESULT:[ \t]*parked[ \t]*$/m.test(text);
export const jobDirectory = (cwd: string): string => join(cwd, '.temp/goal/jobs');

export interface Job {
  id: string; task: string; attempt: number; cwd: string; command: string[]; created: number;
  phase: 'running' | 'inline' | 'parked' | 'waking' | 'woken' | 'reported';
  owner?: Pick<ProcessIdentity, 'pid'> & Partial<ProcessIdentity>;
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

/** A detached owner captures the result even after the worker's native turn exits. Commands keep their
 * existing Task memory and QA-slot admission; this wrapper never grants a slot or bypasses a queue. */
export async function executeJob(directory: string, id: string): Promise<void> {
  const store = new JobStore(directory);
  const job = store.get(id)!;
  const log = openSync(store.log(id), 'a');
  try {
    const code = await new Promise<number>(resolveCode => {
      const child = spawn(job.command[0]!, job.command.slice(1), { cwd: job.cwd, stdio: ['ignore', log, log] });
      child.once('error', error => {
        appendFileSync(store.log(id), `error: ${error.message}\n`);
        resolveCode(1);
      });
      child.once('close', code => resolveCode(code ?? 1));
    });
    store.update(id, current => { current.code = code; current.ended = Date.now(); });
  } finally { closeSync(log); store.close(); }
}

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
    // Publish before the executor starts. Its first update waits for this transaction's owner identity.
    if (store.all().some(current => current.task === task.id && ['parked', 'waking'].includes(current.phase))) {
      throw new Error('A parked job already owns this worker continuation');
    }
    store.db.transaction(() => {
      store.put(job);
      const child = spawn(process.execPath, [import.meta.filename, '--run', store.directory, job.id], {
        cwd, detached: true, stdio: 'ignore',
      });
      child.on('error', error => store.update(job.id, current => { current.code = 1; current.reason = error.message; }));
      if (!child.pid) throw new Error('Job executor did not start');
      job.owner = processIdentity(child.pid) ?? { pid: child.pid };
      store.put(job); child.unref();
    }).immediate();
    const deadline = Date.now() + (options.inlineMs ?? JOB_INLINE_MS);
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
export async function wakeJobs(store: JobStore, options: JobPassOptions = {}): Promise<void> {
  for (const candidate of store.all().filter(job => ['parked', 'waking'].includes(job.phase))) {
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
        if (!job.owner || !(options.alive ?? processAlive)(job.owner)) report('command owner exited without recording a result');
        return;
      }
      if (running(task)) return;
      const result = readResult(attempt);
      if (!parkedResult(result.text)) { report('worker ended without RESULT: parked'); return; }
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

if (import.meta.main && process.argv[2] === '--run') await executeJob(process.argv[3]!, process.argv[4]!);
