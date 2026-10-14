import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobStore, JOB_WAIT_MS, jobDirectory, runJob, wakeJobs, type JobPassOptions } from './job.ts';
import { coordinateWorkerJobs } from './coordinator.ts';
import { settlementOwed } from './settle.ts';
import { managerEvents } from './manager-commands.ts';
import { GoalMailStore } from './mail.ts';
import { resumeDecisionError } from './tasks.ts';
import type { Ledger, Task } from './types.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const parent = join(import.meta.dir, '../../.temp/job-tests');
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, 'run-')); directories.push(cwd);
  const output = join(cwd, 'attempt.json');
  const lastMessage = join(cwd, 'attempt.last.md');
  writeFileSync(output, JSON.stringify({ type: 'thread.started', thread_id: 'native-worker-session' }));
  writeFileSync(lastMessage, 'RESULT: parked');
  const task: Task = { id: 'worker', title: 'Wait for a command', goal: 'program', brief: '', worktree: cwd,
    branch: 'fixture', base: '', state: 'exited', effort: 'high', cases: [], paths: [], migrations: [], shared: [], depends: [],
    engine: 'codex', attempts: [{ n: 1, pid: 2147483647, engine: 'codex', session: '', effort: 'high', output, lastMessage,
      startedAt: new Date().toISOString(), round: 'initial' }] };
  const ledger: Ledger = { tasks: { worker: task }, goals: { program: { manager: 'manager', startedAt: new Date().toISOString() } } };
  const reports: string[] = []; const prompts: string[] = [];
  const options: JobPassOptions = { mutate: async work => work(ledger), admit: () => ({}) as never,
    start: (current, effort, session, prompt, resume, manager, engine, round) => {
      expect(session).toBe('native-worker-session'); expect(resume).toBe(true); expect(manager).toBe('manager');
      prompts.push(prompt);
      return { ...current.attempts[0]!, n: current.attempts.length + 1, session, effort, engine, round };
    }, report: (_job, reason) => reports.push(reason) };
  return { cwd, task, ledger, options, prompts, reports };
}

test('inline completion preserves output, exit status and log without a wake', async () => {
  const f = fixture(); const lines: string[] = [];
  expect(await runJob([process.execPath, '-e', 'console.log("finished inline"); process.exit(7)'], {
    cwd: f.cwd, task: f.task, inlineMs: 3000, print: line => lines.push(line),
  })).toBe(7);
  expect(lines.join('\n')).toContain('finished inline'); expect(lines.join('\n')).toContain('exit:7');
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await wakeJobs(store, f.options);
    expect(store.all()[0]!.phase).toBe('inline'); expect(f.prompts).toHaveLength(0);
  } finally { store.close(); }
});

test('parked command outlives the caller and coordinator wakes its same session once with bounded failures', async () => {
  const f = fixture(); const lines: string[] = [];
  expect(await runJob(['--', process.execPath, '-e', 'await Bun.sleep(150); console.error("error: command failed"); console.error("x".repeat(20000)); process.exit(3)'], {
    cwd: f.cwd, task: f.task, inlineMs: 1, print: line => lines.push(line),
  })).toBe(0);
  expect(lines[0]).toMatch(/^PARKED job:.*; end your turn with RESULT: parked$/);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    expect(store.all()[0]!.phase).toBe('parked');
    await coordinateWorkerJobs(f.ledger, f.options); expect(f.prompts).toHaveLength(0);
    const deadline = Date.now() + 3000;
    while (store.all()[0]!.code === undefined && Date.now() < deadline) await Bun.sleep(20);
    expect(store.all()[0]!.code).toBe(3);
    await coordinateWorkerJobs(f.ledger, f.options); await coordinateWorkerJobs(f.ledger, f.options);
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('exit status 3');
    expect(f.prompts[0]).toContain('error: command failed'); expect(f.prompts[0]).toContain(store.log(store.all()[0]!.id));
    expect(f.prompts[0]!.length).toBeLessThan(13000);
    expect(f.task.attempts[1]!.continuedFor).toBe('job'); expect(f.task.attempts[1]!.round).toBe('continuation');
    expect(resumeDecisionError(f.task.attempts, '')).toBeUndefined(); expect(f.reports).toHaveLength(0);
  } finally { store.close(); }
});

function completed(f: ReturnType<typeof fixture>) {
  const store = new JobStore(jobDirectory(f.cwd));
  store.put({ id: 'completed', task: f.task.id, attempt: 1, cwd: f.cwd, command: ['task', 'goal', '--', 'check'],
    created: Date.now(), phase: 'parked', code: 1, ended: Date.now() });
  writeFileSync(store.log('completed'), '(fail) broken case\nerror: broken\n');
  return store;
}

test('refused native resume reports to the manager once and never consumes a fix round', async () => {
  const f = fixture(); const store = completed(f);
  try {
    f.options.start = () => { throw new Error('Native session cannot be resumed'); };
    await wakeJobs(store, f.options); await wakeJobs(store, f.options);
    expect(f.reports).toEqual(['Native session cannot be resumed']);
    expect(store.get('completed')!.phase).toBe('reported'); expect(f.task.attempts).toHaveLength(1);
  } finally { store.close(); }
});

test('capacity queues the wake; timeout and a lost command owner reach the manager', async () => {
  const f = fixture(); const store = completed(f);
  try {
    f.options.admit = () => { throw new Error('Memory floor reached: wait for memory'); };
    await wakeJobs(store, f.options);
    expect(store.get('completed')!.phase).toBe('parked'); expect(f.reports).toHaveLength(0);
    await wakeJobs(store, { ...f.options, now: Date.now() + JOB_WAIT_MS + 1 });
    expect(f.reports).toEqual(['wait exceeded 45 minutes']);
    store.update('completed', job => { job.phase = 'parked'; delete job.code; });
    await wakeJobs(store, { ...f.options, alive: () => false });
    expect(f.reports[1]).toBe('command owner exited without recording a result');
  } finally { store.close(); }
});

test('wake intent recovers a published continuation and refuses an uncertain launch', async () => {
  const f = fixture(); const store = completed(f);
  try {
    store.update('completed', job => { job.phase = 'waking'; });
    f.task.attempts.push({ ...f.task.attempts[0]!, n: 2, continuedFor: 'job', round: 'continuation' });
    await wakeJobs(store, f.options);
    expect(store.get('completed')!.phase).toBe('woken'); expect(f.prompts).toHaveLength(0);
    f.task.attempts.pop(); store.update('completed', job => { job.phase = 'waking'; });
    await wakeJobs(store, f.options);
    expect(f.reports[0]).toContain('reconcile before another resume'); expect(f.prompts).toHaveLength(0);
  } finally { store.close(); }
});

test('admission retries without rerunning the command and cannot wake a live worker', async () => {
  const f = fixture(); const store = completed(f);
  const worker = spawn(process.execPath, ['-e', 'await Bun.sleep(10000)', 'codex'], { stdio: 'ignore' });
  try {
    f.options.admit = () => { throw new Error('Concurrency limit reached: 25/25 live workers'); };
    await wakeJobs(store, f.options); expect(f.prompts).toHaveLength(0);
    f.options.admit = () => ({}) as never;
    f.task.state = 'running'; f.task.attempts[0]!.pid = worker.pid!;
    await wakeJobs(store, f.options); expect(f.prompts).toHaveLength(0);
    f.task.state = 'exited'; f.task.attempts[0]!.pid = 2147483647;
    await wakeJobs(store, f.options); expect(f.prompts).toHaveLength(1);
    expect(store.get('completed')!.code).toBe(1); expect(f.reports).toHaveLength(0);
  } finally { worker.kill(); store.close(); }
});

test('missing sessions and replaced worker attempts go to the manager', async () => {
  const f = fixture(); const store = completed(f);
  try {
    writeFileSync(f.task.attempts[0]!.output, '');
    await wakeJobs(store, f.options); expect(f.reports[0]).toContain('session is missing');
    store.update('completed', job => { job.phase = 'parked'; });
    f.task.state = 'stopped';
    await wakeJobs(store, f.options); expect(f.reports[1]).toBe('worker attempt was replaced or closed');
    expect(f.prompts).toHaveLength(0);
  } finally { store.close(); }
});

test('RESULT: parked is neither a settlement handoff nor a manager event', () => {
  const f = fixture();
  expect(settlementOwed(f.task)).toBe(false);
  f.task.settlement = { attempt: 1, token: 'old', owner: { pid: 2147483647 }, settledAt: new Date().toISOString(), reason: 'missing handoff' };
  writeFileSync(join(f.cwd, 'ledger.json'), JSON.stringify(f.ledger));
  const mail = new GoalMailStore({ stateDir: f.cwd, goals: ['program'] });
  try { expect(managerEvents(f.cwd, 'program', mail, f.cwd).filter(event => event.key.startsWith('task:'))).toEqual([]); }
  finally { mail.close(); }
  writeFileSync(f.task.attempts[0]!.lastMessage!, 'RESULT: done');
  delete f.task.settlement;
  expect(settlementOwed(f.task)).toBe(true);
});
