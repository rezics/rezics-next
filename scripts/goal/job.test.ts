import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobStore, JOB_INLINE_MS, JOB_WAIT_MS, jobDirectory, runJob, wakeJobs, type JobPassOptions } from './job.ts';
import { coordinateWorkerJobs, stopTurnProcesses } from './coordinator.ts';
import { processAlive, processIdentity } from '../qa/process/identity.ts';
import { settlementOwed } from './settle.ts';
import { managerEvents } from './manager-commands.ts';
import { GoalMailStore } from './mail.ts';
import { resumeDecisionError } from './tasks.ts';
import type { Ledger, Task } from './types.ts';
import { fixtureProcessScope } from './fixtures/process-scope.ts';

const directories: string[] = [];
const scopes: ReturnType<typeof fixtureProcessScope>[] = [];
const originalScope = process.env.GOAL_TEST_PROCESS_SCOPE;
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.cleanup();
  if (originalScope === undefined) delete process.env.GOAL_TEST_PROCESS_SCOPE;
  else process.env.GOAL_TEST_PROCESS_SCOPE = originalScope;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const scope = fixtureProcessScope(); scopes.push(scope);
  Object.assign(process.env, scope.env);
  const parent = join(import.meta.dir, '../../.temp/job-tests');
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, 'run-')); directories.push(cwd);
  // Detached completion now reads the ledger too; isolate it from the host's live worker ledger.
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd }).status).toBe(0);
  mkdirSync(join(cwd, 'scripts/goal'), { recursive: true });
  symlinkSync(join(import.meta.dir, 'job.ts'), join(cwd, 'scripts/goal/job.ts'));
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

function processFixture() {
  const f = fixture();
  const state = join(f.cwd, '.temp/goal-orchestration');
  const bin = join(f.cwd, '.temp/bin');
  const wakes = join(f.cwd, '.temp/wakes.jsonl');
  mkdirSync(state, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(state, 'ledger.json'), JSON.stringify(f.ledger));
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env bun
    import { appendFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(wakes)}, JSON.stringify({ at: Date.now(), args }) + '\\n');
    writeFileSync(args[args.indexOf('-o') + 1], 'RESULT: parked');
  `);
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_TASK_ID: f.task.id,
    GOAL_MEMORY_FLOOR_GIB: '0', GOAL_MAX_WORKERS: '25', GOAL_USAGE_FILE: join(f.cwd, '.temp/usage.json'),
    GOAL_CODEX_HOME: join(f.cwd, '.temp/codex'), GOAL_SETTINGS_DIRECTORY: join(f.cwd, '.goalctl') };
  const execute = async (source: string) => {
    const child = Bun.spawn([process.execPath, '-e', source], { cwd: f.cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  const start = (command: string[], inlineMs = 1, timeoutMs?: number) => execute(`
    import { runJob } from ${JSON.stringify(join(import.meta.dir, 'job.ts'))};
    process.exitCode = await runJob(${JSON.stringify(command)}, { inlineMs: ${inlineMs}, timeoutMs: ${timeoutMs} });
  `);
  const pass = () => execute(`
    import { coordinateWorkerJobs } from ${JSON.stringify(join(import.meta.dir, 'coordinator.ts'))};
    await coordinateWorkerJobs();
  `);
  const ledger = () => JSON.parse(readFileSync(join(state, 'ledger.json'), 'utf8')) as Ledger;
  return { ...f, wakes, execute, start, pass, ledger };
}

function sequenceArgs(commands: string[][]): string[] {
  const shell = (command: string[]) => command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
  return [...commands.slice(1).flatMap(command => ['--then', shell(command)]), '--', ...commands[0]!];
}

test('an ordered green sequence stays parked between commands and wakes once with one line per command', async () => {
  const f = processFixture();
  const first = join(f.cwd, 'first'); const second = join(f.cwd, 'second'); const release = join(f.cwd, 'release');
  const command = (source: string) => [process.execPath, '-e', source];
  const commands = [
    command(`await Bun.write(${JSON.stringify(first)}, 'first');`),
    command(`if (!await Bun.file(${JSON.stringify(first)}).exists()) process.exit(4);
      await Bun.write(${JSON.stringify(second)}, 'second');
      while (!await Bun.file(${JSON.stringify(release)}).exists()) await Bun.sleep(10);`),
    command('console.log("last check passed")'),
  ];
  expect(await f.start(sequenceArgs(commands))).toStartWith('PARKED job:');
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => existsSync(second));
    await f.pass();
    expect(existsSync(f.wakes)).toBe(false);
    expect(store.all()[0]!.code).toBeUndefined();
    writeFileSync(release, 'go');
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    await f.pass(); await f.pass();
    const wakes = readFileSync(f.wakes, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
    expect(wakes).toHaveLength(1);
    const prompt = wakes[0]!.args.at(-1)!;
    expect(prompt.match(/^\d+\. exit:0 /gm)).toHaveLength(3);
    expect(store.all()[0]!.sequence!.map(step => step.code)).toEqual([0, 0, 0]);
    for (const step of store.all()[0]!.sequence!) expect(prompt).toContain(step.command.join(' ').replaceAll('\n', '\\n'));
  } finally { store.close(); }
});

test('a middle failure stops the sequence and wakes once with only that command diagnostics', async () => {
  const f = processFixture(); const remaining = join(f.cwd, 'must-not-run');
  const commands = [
    [process.execPath, '-e', 'console.log("error: passing command diagnostic")'],
    [process.execPath, '-e', 'console.error("error: middle check failed"); process.exit(7)'],
    [process.execPath, '-e', `await Bun.write(${JSON.stringify(remaining)}, 'ran')`],
  ];
  await f.start(sequenceArgs(commands));
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    await f.pass(); await f.pass();
    const wakes = readFileSync(f.wakes, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
    expect(wakes).toHaveLength(1);
    const job = store.all()[0]!; const prompt = wakes[0]!.args.at(-1)!;
    expect(job.code).toBe(7); expect(job.sequence!.map(step => step.code)).toEqual([0, 7, undefined]);
    expect(prompt).toContain('exit status 7'); expect(prompt).toContain('process.exit(7)');
    expect(prompt).toContain('error: middle check failed'); expect(prompt).not.toContain('passing command diagnostic');
    expect(existsSync(remaining)).toBe(false);
    expect(job.sequence![2]!.started).toBeUndefined();
  } finally { store.close(); }
});

test('a stalled sequence command times out, kills its process group and wakes with a failure', async () => {
  const f = processFixture(); const ready = join(f.cwd, 'stalled-pid'); const remaining = join(f.cwd, 'must-not-run');
  await f.start(sequenceArgs([
    [process.execPath, '-e', 'console.log("first passed")'],
    [process.execPath, '-e', `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); await Bun.sleep(30000)`],
    [process.execPath, '-e', `await Bun.write(${JSON.stringify(remaining)}, 'ran')`],
  ]), 1, 500);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => existsSync(ready));
    const stalled = processIdentity(Number(readFileSync(ready, 'utf8')))!;
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    await until(() => !processAlive(stalled));
    await f.pass();
    const wakes = readFileSync(f.wakes, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
    expect(wakes).toHaveLength(1);
    expect(store.all()[0]!.code).toBe(124);
    expect(wakes[0]!.args.at(-1)).toContain('timed out');
    expect(existsSync(remaining)).toBe(false);
  } finally { store.close(); }
});

test('a lost sequence owner fails the active command and wakes without starting the remaining commands', async () => {
  const f = processFixture(); const ready = join(f.cwd, 'ready'); const remaining = join(f.cwd, 'must-not-run');
  await f.start(sequenceArgs([
    [process.execPath, '-e', `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); await Bun.sleep(30000)`],
    [process.execPath, '-e', `await Bun.write(${JSON.stringify(remaining)}, 'ran')`],
  ]));
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => existsSync(ready));
    const command = processIdentity(Number(readFileSync(ready, 'utf8')))!;
    const owner = store.all()[0]!.owner!;
    process.kill(owner.pid, 'SIGKILL');
    await until(() => !processAlive(owner));
    await f.pass(); await f.pass();
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    await until(() => !processAlive(command));
    const wakes = readFileSync(f.wakes, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
    expect(wakes).toHaveLength(1);
    expect(store.all()[0]!.code).toBe(1);
    expect(wakes[0]!.args.at(-1)).toContain('command owner exited without recording a result');
    expect(existsSync(remaining)).toBe(false);
  } finally { store.close(); }
});

test('sequence options reject missing commands before publishing a job', async () => {
  const f = fixture();
  for (const command of [['--then'], ['--then', ' '], ['--then', '--'], ['--then', 'true'], ['--then', 'true', '--']]) {
    await expect(runJob(command, { cwd: f.cwd, task: f.task })).rejects.toThrow();
  }
  expect(existsSync(join(jobDirectory(f.cwd), 'jobs.sqlite'))).toBe(false);
});

test('one coordinator pass records a parked turn while its command is still running', async () => {
  const f = fixture();
  f.task.state = 'running';
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    store.put({ id: 'pending', task: f.task.id, attempt: 1, cwd: f.cwd, command: ['pending'],
      created: Date.now(), phase: 'parked', owner: processIdentity(process.pid)! });
    const before = Date.now();
    await coordinateWorkerJobs(f.ledger, f.options);
    expect(Date.parse(f.task.attempts[0]!.endedAt!)).toBeGreaterThanOrEqual(before);
    expect(f.ledger.tasks.worker!.state).toBe('exited');
    expect(store.get('pending')!.code).toBeUndefined();
    expect(f.prompts).toHaveLength(0); expect(f.reports).toHaveLength(0);
    const ended = f.task.attempts[0]!.endedAt;
    await coordinateWorkerJobs(f.ledger, f.options);
    expect(f.task.attempts[0]!.endedAt).toBe(ended);
  } finally { store.close(); }
});

test('a durable final message records the end even while the engine is closing', async () => {
  const f = fixture();
  const worker = spawn(process.execPath, ['-e', 'await Bun.sleep(30000)', 'codex'], { stdio: 'ignore' });
  const closed = new Promise(resolveExit => worker.once('close', resolveExit));
  try {
    f.task.state = 'running'; f.task.attempts[0]!.pid = worker.pid!;
    rmSync(f.task.attempts[0]!.lastMessage!);
    await coordinateWorkerJobs(f.ledger, f.options);
    expect(f.task.attempts[0]!.endedAt).toBeUndefined();
    await Bun.sleep(5);
    writeFileSync(f.task.attempts[0]!.lastMessage!, 'RESULT: parked');
    await coordinateWorkerJobs(f.ledger, f.options);
    expect(f.task.attempts[0]!.endedAt).toBeDefined();
    expect(f.task.state).toBe('running');
    const ended = f.task.attempts[0]!.endedAt;
    worker.kill('SIGKILL'); await closed;
    await coordinateWorkerJobs(f.ledger, f.options);
    expect(f.ledger.tasks.worker!.state).toBe('exited');
    expect(f.task.attempts[0]!.endedAt).toBe(ended);
  } finally { worker.kill('SIGKILL'); await closed; }
});

test('a wave worktree uses main job control to adopt and wake a later parked attempt', async () => {
  const f = processFixture();
  expect(spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: f.cwd }).status).toBe(0);
  expect(spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: f.cwd }).status).toBe(0);
  expect(spawnSync('git', ['add', 'scripts'], { cwd: f.cwd }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-qm', 'Main runtime'], { cwd: f.cwd }).status).toBe(0);
  const wave = join(f.cwd, '.temp/wave');
  expect(spawnSync('git', ['worktree', 'add', '-qb', 'wave/2', wave], { cwd: f.cwd }).status).toBe(0);
  rmSync(join(wave, 'scripts/goal/job.ts'));
  // The caller can load its branch's entry point, but no detached control process may execute it.
  writeFileSync(join(wave, 'scripts/goal/job.ts'),
    'if (import.meta.main) throw new Error("stale coordination must never run");\n'
    + readFileSync(join(import.meta.dir, 'job.ts'), 'utf8'));
  for (const file of readdirSync(import.meta.dir)) {
    if (file !== 'job.ts') symlinkSync(join(import.meta.dir, file), join(wave, 'scripts/goal', file));
  }
  symlinkSync(join(import.meta.dir, '../qa'), join(wave, 'scripts/qa'));
  const ledger = f.ledger(); ledger.tasks.worker!.worktree = wave;
  writeFileSync(join(f.cwd, '.temp/goal-orchestration/ledger.json'), JSON.stringify(ledger));
  const release = join(f.cwd, '.temp/job-release');
  const command = `import { existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10); console.log(process.cwd());`;
  const output = await f.execute(`
    import { runJob } from ${JSON.stringify(join(wave, 'scripts/goal/job.ts'))};
    await runJob([process.execPath, '-e', ${JSON.stringify(command)}],
      { cwd: ${JSON.stringify(wave)}, inlineMs: 1 });
  `);
  expect(output).toStartWith('PARKED job:');
  const current = f.ledger(); const task = current.tasks.worker!;
  task.attempts.push({ ...task.attempts[0]!, n: 2 }, { ...task.attempts[0]!, n: 3 });
  writeFileSync(join(f.cwd, '.temp/goal-orchestration/ledger.json'), JSON.stringify(current));
  writeFileSync(release, 'complete');
  const store = new JobStore(jobDirectory(wave));
  try {
    // No coordinator rescue: main's detached completion must adopt this newer turn itself.
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    const job = store.all()[0]!;
    expect(job.attempt).toBe(3); expect(job.resumedAttempt).toBe(4);
    expect(readFileSync(store.log(job.id), 'utf8')).toContain(wave);
    expect(f.ledger().tasks.worker!.attempts[3]!.continuedFor).toBe('job');
    expect(readFileSync(f.wakes, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { store.close(); }
});

test('the default inline bound parks a running command in one 30-second tool call', async () => {
  const f = fixture(); const lines: string[] = [];
  expect(JOB_INLINE_MS).toBe(20_000);
  const started = Date.now();
  await runJob([process.execPath, '-e', 'await Bun.sleep(22000)'], {
    cwd: f.cwd, task: f.task, print: line => lines.push(line),
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(20_000); expect(elapsed).toBeLessThan(25_000);
  expect(lines).toHaveLength(1); expect(lines[0]).toStartWith('PARKED job:');
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    expect(store.all()[0]!.phase).toBe('parked'); expect(store.all()[0]!.code).toBeUndefined();
    await until(() => store.all()[0]!.code !== undefined);
    await until(() => !processAlive(store.all()[0]!.owner!));
  } finally { store.close(); }
}, 30_000);

test('the executor wakes its worker immediately without a coordinator pass; later passes never wake twice', async () => {
  const f = processFixture();
  expect(await f.start([process.execPath, '-e', 'await Bun.sleep(200); console.log("completed")'])).toStartWith('PARKED job:');
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => store.all()[0]!.phase === 'woken');
    await until(() => existsSync(f.wakes));
    const wake = JSON.parse(readFileSync(f.wakes, 'utf8').trim()) as { at: number; args: string[] };
    const job = store.all()[0]!;
    expect(wake.at - job.ended!).toBeGreaterThanOrEqual(0); expect(wake.at - job.ended!).toBeLessThan(1000);
    expect(wake.args.slice(0, 3)).toEqual(['exec', 'resume', 'native-worker-session']);
    expect(f.ledger().tasks.worker!.attempts[1]!.continuedFor).toBe('job');
    await f.pass(); await f.pass();
    expect(readFileSync(f.wakes, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(f.ledger().tasks.worker!.attempts).toHaveLength(2);
  } finally { store.close(); }
});

test('executor completion and a concurrent coordinator pass publish only one continuation', async () => {
  const f = processFixture();
  await f.start([process.execPath, '-e', 'await Bun.sleep(300)']);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    // Independent processes contend for the real ledger lease while completion becomes visible.
    await Promise.all([0, 1].map(() => f.execute(`
      import { coordinateWorkerJobs } from ${JSON.stringify(join(import.meta.dir, 'coordinator.ts'))};
      for (let n = 0; n < 40; n++) { await coordinateWorkerJobs(); await Bun.sleep(10); }
    `)));
    await until(() => store.all()[0]!.phase === 'woken' && existsSync(f.wakes));
    expect(f.ledger().tasks.worker!.attempts).toHaveLength(2);
    expect(readFileSync(f.wakes, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { store.close(); }
});

test('a coordinator pass wakes the same worker when the executor dies before its completion wake', async () => {
  const f = processFixture();
  const worker = spawn(process.execPath, ['-e', 'await Bun.sleep(30000)', 'codex'], { stdio: 'ignore' });
  const closed = new Promise(resolveExit => worker.once('close', resolveExit));
  const ledgerPath = join(f.cwd, '.temp/goal-orchestration/ledger.json');
  const ledger = f.ledger();
  ledger.tasks.worker!.state = 'running'; ledger.tasks.worker!.attempts[0]!.pid = worker.pid!;
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  await f.start([process.execPath, '-e', 'await Bun.sleep(30000)']);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => store.all()[0]!.executor !== undefined);
    const job = store.all()[0]!;
    process.kill(job.executor!.pid, 'SIGKILL');
    await until(() => store.get(job.id)!.code !== undefined && !processAlive(job.owner!));
    expect(store.get(job.id)!.code).toBe(137);
    expect(store.get(job.id)!.reason).toBe('executor exited with signal SIGKILL');
    // The owner recorded the exit, but could not resume a still-live caller. The pass recovers it.
    expect(existsSync(f.wakes)).toBe(false);
    worker.kill('SIGKILL'); await closed;
    await f.pass(); await f.pass();
    await until(() => existsSync(f.wakes));
    expect(store.get(job.id)!.phase).toBe('woken');
    expect(readFileSync(f.wakes, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(f.ledger().tasks.worker!.attempts).toHaveLength(2);
  } finally { worker.kill('SIGKILL'); store.close(); }
});

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

test('executor waits for the transaction publishing its record before reading it', async () => {
  const f = fixture(); const store = new JobStore(jobDirectory(f.cwd));
  const ready = join(f.cwd, 'executor-ready');
  const log = openSync(store.log('publication'), 'a');
  let exited: Promise<number | null>;
  try {
    store.db.transaction(() => {
      store.put({ id: 'publication', task: f.task.id, attempt: 1, cwd: f.cwd,
        command: [process.execPath, '-e', 'console.log("published command ran")'], created: Date.now(), phase: 'parked' });
      const child = spawn(process.execPath, ['-e', `import { executeJob } from ${JSON.stringify(join(import.meta.dir, 'job.ts'))};
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        await executeJob(${JSON.stringify(store.directory)}, 'publication');`], { stdio: ['ignore', log, log] });
      exited = new Promise(resolveExit => child.once('close', resolveExit));
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      expect(existsSync(ready)).toBe(true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }).immediate();
    expect(await exited!).toBe(0);
    expect(store.get('publication')!.code).toBe(0);
    expect(readFileSync(store.log('publication'), 'utf8')).toContain('published command ran');
  } finally { closeSync(log); store.close(); }
});

test('startup exceptions leave a start marker, stack and terminal failure record', async () => {
  const f = fixture(); const store = new JobStore(jobDirectory(f.cwd));
  store.put({ id: 'invalid', task: f.task.id, attempt: 1, cwd: f.cwd, command: [], created: Date.now(), phase: 'parked' });
  try {
    const child = spawn(process.execPath, [join(import.meta.dir, 'job.ts'), '--run', store.directory, 'invalid'], { stdio: 'ignore' });
    await new Promise(resolveExit => child.once('close', resolveExit));
    const result = store.get('invalid')!;
    expect(result.code).toBe(1); expect(result.ended).toBeNumber();
    expect(result.reason).toContain('error:');
    const log = readFileSync(store.log('invalid'), 'utf8');
    expect(log).toContain('executor started'); expect(log).toContain('error:'); expect(log).toContain('job.ts:');
    await wakeJobs(store, f.options);
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('error:');
  } finally { store.close(); }
});

test('a command killed by a signal records that signal in its result and continuation', async () => {
  const f = fixture(); const lines: string[] = [];
  expect(await runJob([process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], {
    cwd: f.cwd, task: f.task, inlineMs: 3000, print: line => lines.push(line),
  })).not.toBe(0);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    expect(store.all()[0]!.reason).toContain('SIGKILL');
    expect(lines.join('\n')).toContain('SIGKILL');
  } finally { store.close(); }
});

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  expect(check()).toBe(true);
}

/** A real caller process parks, then the same group cleanup used for turns ends it. */
async function endCaller(f: ReturnType<typeof fixture>, command: string[]): Promise<void> {
  const parked = join(f.cwd, 'caller-parked');
  const token = `job-test-${f.cwd}`;
  const caller = spawn(process.execPath, ['-e', `
    import { runJob } from ${JSON.stringify(join(import.meta.dir, 'job.ts'))};
    import { writeFileSync } from 'node:fs';
    await runJob(${JSON.stringify(command)}, { cwd: ${JSON.stringify(f.cwd)}, task: ${JSON.stringify(f.task)}, inlineMs: 1,
      print: line => writeFileSync(${JSON.stringify(parked)}, line) });
    await Bun.sleep(60000);
  `], { cwd: f.cwd, detached: true, stdio: 'ignore',
    env: { ...process.env, GOAL_TASK_ID: f.task.id, GOAL_WORKTREE: f.cwd, GOAL_TURN_TOKEN: token } });
  const closed = new Promise(resolveExit => caller.once('close', resolveExit));
  try {
    const identity = processIdentity(caller.pid!)!;
    await until(() => existsSync(parked));
    expect(readFileSync(parked, 'utf8')).toStartWith('PARKED job:');
    stopTurnProcesses(token, identity);
    await closed;
    expect(processAlive(identity)).toBe(false);
  } finally { caller.kill('SIGKILL'); }
}

test('the surviving owner records SIGKILL of a parked executor and reaps its command', async () => {
  const f = fixture(); const ready = join(f.cwd, 'command-ready');
  await endCaller(f, [process.execPath, '-e', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(ready)}, String(process.pid)); await Bun.sleep(30000);
  `]);
  const store = new JobStore(jobDirectory(f.cwd));
  try {
    await until(() => existsSync(ready));
    const command = processIdentity(Number(readFileSync(ready, 'utf8')))!;
    const job = store.all()[0]!;
    expect(job.executor).toBeDefined(); expect(job.owner!.pid).not.toBe(job.executor!.pid);
    expect(processAlive(job.owner!)).toBe(true);
    process.kill(job.executor!.pid, 'SIGKILL');
    await until(() => store.get(job.id)!.code !== undefined);
    const result = store.get(job.id)!;
    expect(result.code).toBe(137); expect(result.signal).toBe('SIGKILL'); expect(result.ended).toBeNumber();
    expect(result.reason).toBe('executor exited with signal SIGKILL');
    expect(readFileSync(store.log(job.id), 'utf8')).toContain('error: executor exited with signal SIGKILL');
    await until(() => !processAlive(command));
    await wakeJobs(store, f.options); await wakeJobs(store, f.options);
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('SIGKILL'); expect(f.reports).toHaveLength(0);
  } finally { store.close(); }
});

test('twenty parked 30-second jobs all wake once after their caller turns are killed', async () => {
  const fixtures = Array.from({ length: 20 }, fixture);
  await Promise.all(fixtures.map(f => endCaller(f, [process.execPath, '-e',
    'await Bun.sleep(30000); console.log("thirty-second command completed")'])));
  const stores = fixtures.map(f => new JobStore(jobDirectory(f.cwd)));
  try {
    for (const store of stores) {
      const job = store.all()[0]!;
      expect(job.phase).toBe('parked'); expect(job.code).toBeUndefined(); expect(processAlive(job.owner!)).toBe(true);
    }
    await until(() => stores.every(store => store.all()[0]!.code !== undefined), 40000);
    for (const [index, f] of fixtures.entries()) {
      await coordinateWorkerJobs(f.ledger, f.options); await coordinateWorkerJobs(f.ledger, f.options);
      const job = stores[index]!.all()[0]!;
      expect(job.code).toBe(0); expect(job.phase).toBe('woken'); expect(job.resumedAttempt).toBe(2);
      expect(readFileSync(stores[index]!.log(job.id), 'utf8')).toContain('thirty-second command completed');
      expect(f.prompts).toHaveLength(1); expect(f.reports).toHaveLength(0);
    }
    console.log('Parked-job soak: 20/20 callers ended; 20/20 commands completed after 30s; 20/20 continuations woken exactly once.');
  } finally { for (const store of stores) store.close(); }
}, 60000);

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
    expect(f.reports).toEqual(['wait exceeded 4 hours']);
    store.update('completed', job => { job.phase = 'parked'; delete job.code; });
    await wakeJobs(store, { ...f.options, alive: () => false });
    expect(f.reports[1]).toBe('command owner exited without recording a result');
    expect(store.get('completed')!.code).toBe(1); expect(store.get('completed')!.ended).toBeNumber();
    expect(readFileSync(store.log('completed'), 'utf8')).toContain('error: command owner exited without recording a result');
  } finally { store.close(); }
});

test('a result committed during an owner liveness check is neither overwritten nor reported lost', async () => {
  const f = fixture(); const store = completed(f);
  store.update('completed', job => { delete job.code; job.owner = processIdentity(process.pid)!; });
  try {
    await wakeJobs(store, { ...f.options, alive: () => {
      store.update('completed', job => { job.code = 0; job.ended = Date.now(); });
      return false;
    } });
    expect(store.get('completed')!.code).toBe(0); expect(store.get('completed')!.phase).toBe('parked');
    expect(f.reports).toHaveLength(0);
    await wakeJobs(store, f.options);
    expect(f.prompts).toHaveLength(1);
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

test('a worker that ended mid-step without any RESULT is woken by its job; a final handoff goes to the manager', async () => {
  const f = fixture(); const store = completed(f);
  try {
    // A Grok session can end mid-step with prose only; its parked job is still its continuation.
    writeFileSync(f.task.attempts[0]!.lastMessage!, 'Story tests will run through the job wrapper.');
    await wakeJobs(store, f.options);
    expect(f.reports).toHaveLength(0); expect(f.prompts).toHaveLength(1);
    expect(f.task.attempts[1]!.continuedFor).toBe('job');
  } finally { store.close(); }
  const g = fixture(); const final = completed(g);
  try {
    writeFileSync(g.task.attempts[0]!.lastMessage!, 'RESULT: blocked\nCASES: none');
    await wakeJobs(final, g.options);
    expect(g.prompts).toHaveLength(0); expect(g.reports[0]).toBe('worker handed off RESULT: blocked while its job ran');
  } finally { final.close(); }
});

test('a resume while the job ran hands the job to the later attempt that parked without its own job', async () => {
  const f = fixture(); const store = completed(f);
  try {
    const later = join(f.cwd, 'attempt-2.last.md'); writeFileSync(later, 'RESULT: parked');
    f.task.attempts.push({ ...f.task.attempts[0]!, n: 2, lastMessage: later, round: 'fix' });
    await wakeJobs(store, f.options);
    expect(f.reports).toHaveLength(0); expect(store.get('completed')!.attempt).toBe(2);
    await wakeJobs(store, f.options);
    expect(f.prompts).toHaveLength(1); expect(f.task.attempts[2]!.continuedFor).toBe('job');
  } finally { store.close(); }
  const g = fixture(); const final = completed(g);
  try {
    const later = join(g.cwd, 'attempt-2.last.md'); writeFileSync(later, 'RESULT: done');
    g.task.attempts.push({ ...g.task.attempts[0]!, n: 2, lastMessage: later, round: 'fix' });
    await wakeJobs(final, g.options);
    expect(g.prompts).toHaveLength(0); expect(g.reports[0]).toBe('worker attempt was replaced or closed');
  } finally { final.close(); }
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

test('a turn that ended with prose while its job is parked owes no settlement; once reported it does', () => {
  const f = fixture();
  writeFileSync(f.task.attempts[0]!.lastMessage!, 'Story tests will run through the job wrapper.');
  expect(settlementOwed(f.task)).toBe(true);
  const store = completed(f);
  try {
    expect(settlementOwed(f.task)).toBe(false);
    store.update('completed', job => { job.phase = 'reported'; });
    expect(settlementOwed(f.task)).toBe(true);
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
