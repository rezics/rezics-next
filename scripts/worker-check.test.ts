import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireStackSlot } from './stack-lease.ts';
import { requestExecutionCancellation } from './remote-check.ts';
import {
  processTreeCpuTicks,
  runWorkerCheck,
  resolveRepositoryBun,
  scopeRootTypecheck,
  startWorkerCheck,
  waitWorkerCheck,
  requestWorkerCheckCancellation,
  workerCheckCancellation,
} from './worker-check.ts';
import { checkClass, checkMemoryWeight, recordPeak } from './check-memory.ts';

const dirs: string[] = [];
const repository = join(import.meta.dir, '..');
let suiteRoot: string;
const inheritedCheckEnvironment = { ...process.env };

async function needsStack(argv: readonly string[], cwd = repository): Promise<boolean> {
  const worker = (await import('./worker-check.ts')) as unknown as {
    workerCheckNeedsStack?: (command: readonly string[], directory?: string) => boolean;
  };
  if (typeof worker.workerCheckNeedsStack !== 'function') throw new Error('workerCheckNeedsStack is not exported');
  return worker.workerCheckNeedsStack(argv, cwd);
}

function restoreWorkerEnvironment(old: NodeJS.ProcessEnv): void {
  for (const key of [
    'REZICS_CHECK_MEMORY',
    'REZICS_CHECK_MEMORY_DIR',
    'REZICS_CHECK_MEMORY_GIB',
    'REZICS_CHECK_SCOPE',
    'WORKER_REMOTE_EVENTS',
    'WORKER_REMOTE_ARGS',
    'WORKER_REMOTE_MODE',
    'WORKER_REMOTE_CANCEL_ID',
    'KERNEL_CHECK_REMOTE',
    'KERNEL_CHECK_ON_REMOTE',
    'WORKER_WRAPPER_MARKER',
    'WRAPPER_KEEP',
    'WRAPPER_REMOVE',
  ]) {
    if (old[key] === undefined) delete process.env[key];
    else process.env[key] = old[key];
  }
}

function stopOwnedWorkerCheck(id: string, cwd: string): void {
  try {
    const record = JSON.parse(readFileSync(join(cwd, '.temp/goal/checks/results', `${id}.json`), 'utf8')) as {
      status?: string;
      runnerPid?: number;
      runnerHost?: string;
    };
    if (record.status === 'running' && record.runnerHost === hostname() && record.runnerPid) {
      try {
        process.kill(-record.runnerPid, 'SIGTERM');
      } catch {
        // The owned runner may have exited between reading its record and signaling its group.
      }
    }
  } catch {
    // A failed launch may not have published its result record.
  }
}

function cleanTestEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (
      (key.startsWith('REZICS_CHECK_') && key !== 'REZICS_CHECK_LEDGER_DIR') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete clean[key];
  }
  return clean;
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
  const temporary = join(import.meta.dir, '../.temp');
  mkdirSync(temporary, { recursive: true });
  suiteRoot = mkdtempSync(join(temporary, 'worker-check-test-'));
  process.env.REZICS_CHECK_LEDGER_DIR = join(suiteRoot, 'check-ledger');
});
afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(inheritedCheckEnvironment)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    ) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('nested worker checks start with default placement environment', () => {
  const environment = cleanTestEnvironment({
    ...process.env,
    REZICS_CHECK_SLICE: 'outer.slice',
    REZICS_CHECK_RUN: 'outer-run',
    KERNEL_CHECK_REMOTE: '/outer/hosts.json',
    KERNEL_CHECK_ON_REMOTE: '1',
  });
  expect(environment.REZICS_CHECK_SLICE).toBeUndefined();
  expect(environment.REZICS_CHECK_RUN).toBeUndefined();
  expect(environment.KERNEL_CHECK_REMOTE).toBeUndefined();
  expect(environment.KERNEL_CHECK_ON_REMOTE).toBeUndefined();
});

test('critical priority: worker-check rereads task-priority and overrides inherited priority each check', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-priority-'));
  dirs.push(directory);
  mkdirSync(join(directory, '.temp/goal'), { recursive: true });
  const file = join(directory, '.temp/goal/task-priority');
  const log = join(directory, 'check.log');
  const oldTask = process.env.GOAL_TASK_ID;
  const oldPriority = process.env.REMOTE_CHECK_PRIORITY;
  process.env.GOAL_TASK_ID = 'worker';
  process.env.REMOTE_CHECK_PRIORITY = 'landing';
  try {
    writeFileSync(file, 'critical\n');
    await runWorkerCheck(['bun', '-e', 'console.log(process.env.REMOTE_CHECK_PRIORITY)'], directory, false, log);
    expect(readFileSync(log, 'utf8')).toContain('critical');
    writeFileSync(file, 'normal\n');
    writeFileSync(log, '');
    await runWorkerCheck(
      ['bun', '-e', "console.log(process.env.REMOTE_CHECK_PRIORITY ?? 'normal')"],
      directory,
      false,
      log,
    );
    expect(readFileSync(log, 'utf8')).toContain('normal');
  } finally {
    if (oldTask === undefined) delete process.env.GOAL_TASK_ID;
    else process.env.GOAL_TASK_ID = oldTask;
    if (oldPriority === undefined) delete process.env.REMOTE_CHECK_PRIORITY;
    else process.env.REMOTE_CHECK_PRIORITY = oldPriority;
  }
});

test('critical priority: invalid task priority names its file and missing priority reports normal once', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-priority-errors-'));
  dirs.push(directory);
  mkdirSync(join(directory, '.temp/goal'), { recursive: true });
  const file = join(directory, '.temp/goal/task-priority');
  const log = join(directory, 'check.log');
  const oldTask = process.env.GOAL_TASK_ID;
  const oldPriority = process.env.REMOTE_CHECK_PRIORITY;
  process.env.GOAL_TASK_ID = 'worker';
  process.env.REMOTE_CHECK_PRIORITY = 'critical';
  const errors: string[] = [];
  const originalError = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    writeFileSync(file, 'urgent\n');
    await expect(runWorkerCheck(['bun', '-e', 'process.exit(0)'], directory, false, log)).rejects.toThrow(file);
    rmSync(file);
    writeFileSync(log, '');
    await runWorkerCheck(
      ['bun', '-e', "console.log(process.env.REMOTE_CHECK_PRIORITY ?? 'normal')"],
      directory,
      false,
      log,
    );
    writeFileSync(log, '');
    await runWorkerCheck(
      ['bun', '-e', "console.log(process.env.REMOTE_CHECK_PRIORITY ?? 'normal')"],
      directory,
      false,
      log,
    );
    expect(errors.join('')).toContain(`${file} unavailable; using normal priority`);
    expect(errors.join('').split(`${file} unavailable; using normal priority`).length - 1).toBe(1);
  } finally {
    process.stderr.write = originalError;
    if (oldTask === undefined) delete process.env.GOAL_TASK_ID;
    else process.env.GOAL_TASK_ID = oldTask;
    if (oldPriority === undefined) delete process.env.REMOTE_CHECK_PRIORITY;
    else process.env.REMOTE_CHECK_PRIORITY = oldPriority;
  }
});

test('ledger records each physical worker execution with logical id and rerun number', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-ledger-'));
  dirs.push(root);
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_SCOPE = 'off';
  const previousLedger = process.env.REZICS_CHECK_LEDGER_DIR;
  process.env.REZICS_CHECK_LEDGER_DIR = join(root, '.temp/check-ledger');
  try {
    const result = await runWorkerCheck(['true'], root, false, undefined, 60_000, 'logical-1', 1);
    expect(result).toBe(0);
    const ledgerRoot = join(root, '.temp/check-ledger');
    const day = readdirSync(ledgerRoot)[0]!;
    const entry = JSON.parse(readFileSync(join(ledgerRoot, day, readdirSync(join(ledgerRoot, day))[0]!), 'utf8'));
    expect(entry.logicalCheckId).toBe('logical-1');
    expect(entry.rerunNumber).toBe(1);
    expect(entry.terminalStatus).toBe('passed');
    expect(entry.exitStatus).toBe(0);
  } finally {
    process.env.REZICS_CHECK_LEDGER_DIR = previousLedger;
  }
});

function withQuietAdmission<T>(run: () => Promise<T>): Promise<T> {
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = join(suiteRoot, 'memory');
  process.env.REZICS_CHECK_SCOPE = 'off';
  return run().finally(() => {
    for (const key of ['REZICS_CHECK_MEMORY', 'REZICS_CHECK_MEMORY_DIR', 'REZICS_CHECK_SCOPE']) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function typecheckRepo(root: string, includeDev = true): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.temp/\n');
  for (const name of ['committed.txt', 'staged.txt', 'unstaged.txt', 'deleted.txt'])
    writeFileSync(join(root, name), 'base\n');
  writeFileSync(join(root, 'scripts/typecheck.ts'), "console.log(process.env.TYPECHECK_CHANGED ?? 'unset')\n");
  git(root, 'init', '-b', includeDev ? 'dev' : 'worker');
  git(root, 'config', 'user.email', 'worker-check@example.test');
  git(root, 'config', 'user.name', 'Worker Check');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  if (includeDev) git(root, 'switch', '-c', 'worker');
  writeFileSync(join(root, 'committed.txt'), 'branch\n');
  git(root, 'add', 'committed.txt');
  git(root, 'commit', '-m', 'branch change');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', 'staged.txt');
  writeFileSync(join(root, 'unstaged.txt'), 'unstaged\n');
  rmSync(join(root, 'deleted.txt'));
  writeFileSync(join(root, 'untracked.txt'), 'new\n');
  expect(base).toMatch(/^[0-9a-f]{40}$/);
}

test('typecheck scope: worker typecheck includes committed, staged, unstaged, deleted and untracked files', async () => {
  const root = mkdtempSync(join(repository, '.temp/worker-check-typecheck-scope-'));
  dirs.push(root);
  typecheckRepo(root);
  const expected = ['committed.txt', 'deleted.txt', 'staged.txt', 'unstaged.txt', 'untracked.txt'];
  const oldChanged = process.env.TYPECHECK_CHANGED;
  delete process.env.TYPECHECK_CHANGED;
  try {
    await withQuietAdmission(async () => {
      const status = await runWorkerCheck(['bun', 'scripts/typecheck.ts'], root);
      expect(status).toBe(0);
    });
  } finally {
    if (oldChanged === undefined) delete process.env.TYPECHECK_CHANGED;
    else process.env.TYPECHECK_CHANGED = oldChanged;
  }
  const logDirectory = join(root, '.temp/goal/checks');
  const log = readFileSync(
    join(
      logDirectory,
      readdirSync(logDirectory).find((name) => name.endsWith('.log'))!,
    ),
    'utf8',
  );
  expect(log).toContain(`worker-check: scripts/typecheck.ts scoped to ${expected.length} changed files from `);
  const summaryIndex = log.indexOf('\n', log.indexOf('worker-check: scripts/typecheck.ts scoped'));
  expect(
    log
      .slice(summaryIndex + 1)
      .trim()
      .split('\n'),
  ).toEqual(expected);
});

test('typecheck scope: scoped argv is an env prefix shared before local or remote placement', () => {
  const root = mkdtempSync(join(repository, '.temp/worker-check-typecheck-argv-'));
  dirs.push(root);
  typecheckRepo(root);
  const env: NodeJS.ProcessEnv = {};
  const lines: string[] = [];
  const input = ['bun', 'scripts/typecheck.ts', '--verbose'];
  const scoped = scopeRootTypecheck(input, root, env, (line) => lines.push(line));
  const localPlacementArgv = [...scoped];
  const remotePlacementArgv = [...scoped];
  expect(localPlacementArgv).toEqual(remotePlacementArgv);
  expect(localPlacementArgv.slice(0, 2)).toEqual([
    'env',
    `TYPECHECK_CHANGED=${['committed.txt', 'deleted.txt', 'staged.txt', 'unstaged.txt', 'untracked.txt'].join('\n')}`,
  ]);
  expect(localPlacementArgv.slice(2)).toEqual(input);
  expect(lines[0]).toContain('scoped to 5 changed files from');
});

test('typecheck scope: an existing TYPECHECK_CHANGED is kept unchanged', () => {
  const root = mkdtempSync(join(repository, '.temp/worker-check-typecheck-existing-'));
  dirs.push(root);
  typecheckRepo(root);
  const env = { TYPECHECK_CHANGED: 'caller\nvalue' };
  const input = ['bun', 'scripts/typecheck.ts'];
  expect(scopeRootTypecheck(input, root, env, () => {})).toEqual(input);
  expect(env.TYPECHECK_CHANGED).toBe('caller\nvalue');
});

test('typecheck scope: missing dev ref runs unscoped and explains why', () => {
  const root = mkdtempSync(join(repository, '.temp/worker-check-typecheck-no-dev-'));
  dirs.push(root);
  typecheckRepo(root, false);
  const lines: string[] = [];
  const input = ['bun', 'scripts/typecheck.ts'];
  expect(scopeRootTypecheck(input, root, {}, (line) => lines.push(line))).toEqual(input);
  expect(lines).toEqual(['worker-check: scripts/typecheck.ts running unscoped (dev ref or merge base unavailable)']);
});

test('typecheck scope: commands other than root typecheck get no TYPECHECK_CHANGED', () => {
  const root = mkdtempSync(join(repository, '.temp/worker-check-typecheck-other-'));
  dirs.push(root);
  const env: NodeJS.ProcessEnv = {};
  const input = ['bun', 'scripts/other.ts'];
  expect(scopeRootTypecheck(input, root, env, () => {})).toEqual(input);
  expect(env.TYPECHECK_CHANGED).toBeUndefined();
});

test('worker-check keeps exit status and writes a log plus failure summary with admission disabled', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-check-test-'));
  dirs.push(directory);
  const old = { ...process.env };
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_DIR = directory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  process.env.REZICS_CHECK_SCOPE = 'off';
  delete process.env.KERNEL_CHECK_REMOTE;
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await runWorkerCheck(['bun', '-e', 'console.error("failure marker"); process.exit(7)'])).toBe(7);
  } finally {
    process.stdout.write = write;
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
  expect(out.join('')).toContain('check: exit status 7');
  expect(out.join('')).toContain('failure marker');
  const log = out
    .join('')
    .match(/check: log (.+)/)?.[1]
    ?.trim();
  expect(log).toBeTruthy();
  expect(readFileSync(log!, 'utf8')).toContain('failure marker');
});

test('a queued memory lease writes its waiting line repeatedly into the check log', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-check-lease-wait-'));
  dirs.push(directory);
  const leaseDirectory = join(directory, 'leases');
  const holder = await acquireStackSlot('holder', { REZICS_STACK_SLOTS: '1', REZICS_STACK_LEASE_DIR: leaseDirectory });
  const old = { ...process.env };
  try {
    for (const [key, value] of Object.entries({
      REZICS_CHECK_MEMORY: 'on',
      REZICS_CHECK_MEMORY_DIR: leaseDirectory,
      REZICS_CHECK_MEMORY_GIB: '1',
      REZICS_CHECK_SCOPE: 'off',
    }))
      process.env[key] = value;
    delete process.env.KERNEL_CHECK_REMOTE;
    const waiting = runWorkerCheck(['bun', '-e', 'console.error("lease completed")'], directory, false, undefined, 15);
    await new Promise((resolveWait) => setTimeout(resolveWait, 55));
    await holder.release();
    expect(await waiting).toBe(0);
  } finally {
    await holder.release();
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
  const logDirectory = join(directory, '.temp/goal/checks');
  const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
  expect(log.match(/stack-lease: worker-check:.*waiting \(1\/1 held, 0 ahead\)/g)?.length).toBeGreaterThanOrEqual(2);
});

test('a timed out wait can wait again by id and receives the same check result', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-check-rewait-'));
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const marker = `${directory}/runs`;
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `await Bun.sleep(180); const { openSync, writeSync, closeSync } = await import('node:fs'); const fd = openSync(${JSON.stringify(marker)}, 'wx'); writeSync(fd, 'ran\\n'); closeSync(fd); console.error('completed marker')`,
      ],
      directory,
    );
    const out: string[] = [];
    expect(await waitWorkerCheck(id, directory, 20, { write: (chunk) => out.push(chunk) })).toBe(75);
    expect(out.join('')).toContain('check: still running');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
    out.length = 0;
    expect(await waitWorkerCheck(id, directory, undefined, { write: (chunk) => out.push(chunk) })).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(out.join('')).toContain('check: exit status 0');
    expect(out.join('')).toContain('check: log .temp/goal/checks/worker-check-');
  });
});

test('a queued check timeout prints the latest waiting line and its log path', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-queued-wait-'));
  dirs.push(root);
  const log = '.temp/goal/checks/queued.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'stack-lease: worker-check:kernel waiting (1/1 held, 0 ahead)\n');
  const id = '00000000-0000-4000-8000-000000000006';
  writeRunningRecord(root, id, log, 2_000_000_000);
  const out: string[] = [];
  expect(await waitWorkerCheck(id, root, 0, { write: (chunk) => out.push(chunk) })).toBe(75);
  expect(out.join('')).toContain('check: still running');
  expect(out.join('')).toContain('stack-lease: worker-check:kernel waiting (1/1 held, 0 ahead)');
  expect(out.join('')).toContain(`check: log ${log}`);
});

test('a finished check result remains readable by id after its worker session ends', async () => {
  const directory = mkdtempSync(join(suiteRoot, 'worker-check-finished-'));
  dirs.push(directory);
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'console.error("finished failure marker"); process.exit(9)'], directory);
    // A separate invocation models a retry after the original worker has ended.
    const record = `${directory}/.temp/goal/checks/results/${id}.json`;
    for (
      let attempt = 0;
      attempt < 200 && (!existsSync(record) || !readFileSync(record, 'utf8').includes('"finished"'));
      attempt++
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(readFileSync(record, 'utf8')).toContain('"finished"');
    const out: string[] = [];
    expect(await waitWorkerCheck(id, directory, undefined, { write: (chunk) => out.push(chunk) })).toBe(9);
    expect(out.join('')).toContain('check: exit status 9');
    expect(out.join('')).toContain('finished failure marker');
    expect(out.join('')).toContain(`check: log .temp/goal/checks/worker-check-`);
  });
});

function writeRunningRecord(
  root: string,
  id: string,
  log: string,
  runnerPid: number,
  runnerHost = 'check-host-a',
  reruns = 0,
) {
  const resultDirectory = join(root, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    join(resultDirectory, `${id}.json`),
    JSON.stringify({
      id,
      cwd: root,
      argv: [
        'bun',
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(join(root, 'rerun-marker'))}, 'rerun\\n')`,
      ],
      status: 'running',
      log,
      runnerPid,
      runnerHost,
      ...(reruns ? { reruns } : {}),
    }),
  );
}

test('worker-check --wait reruns once when the runner is gone but its result still says running', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-dead-runner-'));
  dirs.push(root);
  const log = '.temp/goal/checks/dead-runner.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), '');
  const id = '00000000-0000-4000-8000-000000000001';
  writeRunningRecord(root, id, log, 2_000_000_000, hostname());
  const out: string[] = [];
  await withQuietAdmission(async () =>
    expect(await waitWorkerCheck(id, root, 5_000, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(0),
  );
  expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
  expect(out.join('')).toContain(`infrastructure failure (runner process exited) on ${hostname()}`);
  expect(out.join('')).toContain('check: exit status 0');
  const result = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
  expect(result.reruns).toBe(1);
  expect(result.infrastructureFailure).toContain(`old log ${log}`);
});

test('a check whose log has been silent for 10 minutes is stopped and rerun once with host and log reported', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-stalled-runner-'));
  dirs.push(root);
  const log = '.temp/goal/checks/stalled.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), '');
  const stale = new Date(Date.now() - 25);
  utimesSync(join(root, log), stale, stale);
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolveRunner) => runner.once('spawn', resolveRunner));
  const id = '00000000-0000-4000-8000-000000000002';
  writeRunningRecord(root, id, log, runner.pid!, 'stall-host-b');
  const out: string[] = [];
  try {
    await withQuietAdmission(async () =>
      expect(
        await waitWorkerCheck(id, root, 5_000, {
          pollMs: 5,
          stallMs: 10,
          rerunStallMs: 1_000,
          write: (chunk) => out.push(chunk),
        }),
      ).toBe(0),
    );
  } finally {
    runner.kill('SIGKILL');
  }
  expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
  expect(out.join('')).toContain('infrastructure failure (log did not grow for 10 ms) on stall-host-b');
  expect(out.join('')).toContain('check: exit status 0');
  expect(out.join('')).toContain('log .temp/goal/checks/worker-check-');
});

test('a second interrupted runner finishes as infrastructure failure without a third run', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-second-runner-'));
  dirs.push(root);
  const log = '.temp/goal/checks/second.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'last rerun output\n');
  const id = '00000000-0000-4000-8000-000000000003';
  writeRunningRecord(root, id, log, 2_000_000_000, hostname(), 1);
  const out: string[] = [];
  await withQuietAdmission(async () =>
    expect(await waitWorkerCheck(id, root, 100, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(1),
  );
  expect(() => readFileSync(join(root, 'rerun-marker'), 'utf8')).toThrow();
  expect(out.join('')).toContain('second runner failed');
  expect(out.join('')).toContain('check: exit status 1');
  expect(
    JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).infrastructureFailureFinal,
  ).toBe(true);
});

test('an unrelated local pid and a runner recorded on another host are not treated as live runners', async () => {
  for (const [id, pid, host] of [
    ['00000000-0000-4000-8000-000000000004', process.pid, hostname()],
    ['00000000-0000-4000-8000-000000000005', 2_000_000_000, hostname() + '-elsewhere'],
  ] as const) {
    const root = mkdtempSync(join(suiteRoot, 'worker-check-unrelated-runner-'));
    dirs.push(root);
    const log = '.temp/goal/checks/live.log';
    mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
    writeFileSync(join(root, log), 'queued line\n');
    writeRunningRecord(root, id, log, pid, host);
    const out: string[] = [];
    await withQuietAdmission(async () =>
      expect(await waitWorkerCheck(id, root, 20, { pollMs: 5, stallMs: 1000, write: (chunk) => out.push(chunk) })).toBe(
        75,
      ),
    );
    expect(out.join('')).toContain('queued line');
    expect(
      JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).reruns,
    ).toBeUndefined();
  }
});

function workerFixture(): {
  root: string;
  memory: string;
  remoteEvents: string;
  remoteArgs: string;
  localMarker: string;
} {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-remote-test-'));
  dirs.push(root);
  const memory = join(root, 'memory');
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  const remoteEvents = join(root, 'remote-events');
  const remoteArgs = join(root, 'remote-args.json');
  const localMarker = join(root, 'local-marker');
  writeFileSync(
    join(scripts, 'remote-check.ts'),
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { requestExecutionCancellation } from ${JSON.stringify(join(repository, 'scripts/remote-check.ts'))};
appendFileSync(process.env.WORKER_REMOTE_EVENTS!, 'remote\\n');
appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.args', JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.WORKER_REMOTE_ARGS!, JSON.stringify(Bun.argv.slice(2)));
if (process.env.WORKER_REMOTE_PROFILE_OUTPUT) {
  mkdirSync(dirname(process.env.WORKER_REMOTE_PROFILE_OUTPUT), { recursive: true });
  writeFileSync(process.env.WORKER_REMOTE_PROFILE_OUTPUT, 'remote growth\\n');
}
if (process.env.WORKER_REMOTE_MODE === 'transport') {
  writeFileSync(3, JSON.stringify({ nonce: process.env.REMOTE_CHECK_RECEIPT_NONCE, transportFailure:{schema:1,message:'remote-check: connection to host failed during rsync before a result'} })+'\\n');
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  process.exit(75);
}
if (process.env.WORKER_REMOTE_MODE === 'cancel-transport') {
  requestExecutionCancellation({ file: process.env.REMOTE_CHECK_CANCELLATION_FILE!, id: process.env.REMOTE_CHECK_CANCELLATION_ID! });
  writeFileSync(3, JSON.stringify({ nonce: process.env.REMOTE_CHECK_RECEIPT_NONCE, transportFailure:{schema:1,message:'remote-check: connection to host failed during rsync before a result'} })+'\\n');
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  process.exit(75);
}
if (process.env.WORKER_REMOTE_MODE?.startsWith('lifetime-')) {
  const failure = {schema:1,status:'infrastructure-failure',phase:'run-lifetime',host:'check-a',run:'fixture-physical',limitMs:1000,elapsedMs:1200,command:'bun test [2 arguments]'};
  console.error('remote-check: infrastructure failure: remote run timed out ' + JSON.stringify(failure));
  if (process.env.WORKER_REMOTE_MODE === 'lifetime-channel') {
    writeFileSync(3, JSON.stringify({ nonce:process.env.REMOTE_CHECK_RECEIPT_NONCE, receipt:{schema:1,host:'check-a',run:'fixture-physical',exitCode:124,lifetimeFailure:failure,resources:null} })+'\\n');
  }
  if (process.env.WORKER_REMOTE_MODE === 'lifetime-malformed') {
    writeFileSync(3, JSON.stringify({ nonce:process.env.REMOTE_CHECK_RECEIPT_NONCE, receipt:{schema:1,host:'check-a',run:'different-physical',exitCode:124,lifetimeFailure:failure,resources:null} })+'\\n');
  }
  process.exit(124);
}
if (process.env.WORKER_REMOTE_MODE === 'failure') process.exit(7);
if (process.env.WORKER_REMOTE_MODE === 'failure-75') process.exit(75);
if (process.env.WORKER_REMOTE_MODE === 'queued') {
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
}
console.error('remote-check: run used 2.000 CPU seconds over 1.000 s (2.00 cores), peak memory 3072 MiB on check-a');
process.exit(0);
`,
  );
  return { root, memory, remoteEvents, remoteArgs, localMarker };
}

function workerEnv(fixture: ReturnType<typeof workerFixture>, hostsPath?: string): Record<string, string | undefined> {
  process.env.REZICS_CHECK_MEMORY = 'on';
  process.env.REZICS_CHECK_MEMORY_DIR = fixture.memory;
  process.env.REZICS_CHECK_MEMORY_GIB = '4';
  process.env.REZICS_CHECK_SCOPE = 'off';
  process.env.WORKER_REMOTE_EVENTS = fixture.remoteEvents;
  process.env.WORKER_REMOTE_ARGS = fixture.remoteArgs;
  process.env.WORKER_REMOTE_MODE = 'success';
  if (hostsPath === undefined) delete process.env.KERNEL_CHECK_REMOTE;
  else process.env.KERNEL_CHECK_REMOTE = hostsPath;
  return process.env;
}

function localCommand(marker: string): string[] {
  return [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.REZICS_CHECK_MEMORY_LEASE ?? 'missing')`,
  ];
}

test('only the outer receipt channel classifies a physical lifetime failure; nested text and command exit 124 do not', async () => {
  for (const mode of ['lifetime-channel', 'lifetime-stdout', 'lifetime-malformed']) {
    const fixture = workerFixture();
    const old = { ...process.env };
    try {
      const hosts = join(fixture.root, 'hosts.json');
      writeFileSync(hosts, JSON.stringify({ hosts: [] }));
      workerEnv(fixture, hosts);
      process.env.WORKER_REMOTE_MODE = mode;
      const command = localCommand(fixture.localMarker);
      const commandClass = checkClass(command, fixture.root);
      for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
      const id = randomUUID();
      const recordFile = join(fixture.root, '.temp/goal/checks/results', `${id}.json`);
      mkdirSync(dirname(recordFile), { recursive: true });
      const log = join(fixture.root, '.temp/goal/checks/fixture.log');
      writeFileSync(log, '');
      writeFileSync(
        recordFile,
        JSON.stringify({
          id,
          cwd: fixture.root,
          argv: command,
          status: 'running',
          log: '.temp/goal/checks/fixture.log',
        }),
      );
      expect(await runWorkerCheck(command, fixture.root, false, log, 60_000, id, 0, id), mode).toBe(124);
      const record = JSON.parse(readFileSync(recordFile, 'utf8'));
      expect(Boolean(record.infrastructureFailure), mode).toBe(mode === 'lifetime-channel');
      expect(existsSync(fixture.localMarker), mode).toBe(false);
      expect(readFileSync(fixture.remoteEvents, 'utf8'), mode).toBe('remote\n');
      if (mode === 'lifetime-channel')
        expect(record.physicalRun).toMatchObject({ host: 'check-a', run: 'fixture-physical', exitCode: 124 });
    } finally {
      restoreWorkerEnvironment(old);
    }
  }
});

test('durable cancellation preceding a transport exit prevents local fallback and detached watchdog resurrection', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    const hosts = join(fixture.root, 'hosts.json');
    writeFileSync(hosts, JSON.stringify({ hosts: [] }));
    workerEnv(fixture, hosts);
    process.env.WORKER_REMOTE_MODE = 'cancel-transport';
    const command = localCommand(fixture.localMarker);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, checkClass(command, fixture.root), 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root)).toBe(143);
    expect(existsSync(fixture.localMarker)).toBe(false);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    const id = randomUUID();
    const recordFile = join(fixture.root, '.temp/goal/checks/results', `${id}.json`);
    mkdirSync(dirname(recordFile), { recursive: true });
    const record = {
      id,
      cwd: fixture.root,
      argv: command,
      status: 'running',
      log: '.temp/goal/checks/cancelled.log',
      runnerHost: hostname(),
    };
    writeFileSync(recordFile, JSON.stringify(record));
    writeFileSync(join(fixture.root, record.log), 'old truthful output\n');
    requestWorkerCheckCancellation(id, fixture.root);
    const output: string[] = [];
    expect(
      await waitWorkerCheck(id, fixture.root, 100, { stallMs: 1, pollMs: 1, write: (text) => output.push(text) }),
    ).toBe(143);
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toEqual(record);
    expect(existsSync(workerCheckCancellation(id, fixture.root).file)).toBe(true);
    expect(output.join('')).toContain('automatic restart is disabled');
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(existsSync(fixture.localMarker)).toBe(false);
  } finally {
    restoreWorkerEnvironment(old);
  }
});

test('local cancellation reaps its TERM-resistant detached descendants before returning capacity and preserves a peer', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const id = randomUUID();
  const pids = join(fixture.root, 'owned-pids');
  const peer = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    process.env.REZICS_CHECK_MEMORY = 'off';
    process.env.REZICS_CHECK_SCOPE = 'off';
    const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pids)},process.pid+'\\n'+child.pid+'\\n');setInterval(()=>{},1000);`;
    const completion = runWorkerCheck([process.execPath, '-e', program], fixture.root, false, undefined, 60_000, id);
    for (let attempt = 0; attempt < 300 && !existsSync(pids); attempt++) await Bun.sleep(5);
    expect(existsSync(pids)).toBe(true);
    requestExecutionCancellation(workerCheckCancellation(id, fixture.root));
    expect(await completion).toBe(143);
    const owned = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    expect(owned).toHaveLength(2);
    expect(owned.every((pid) => !existsSync(`/proc/${pid}`))).toBe(true);
    expect(existsSync(`/proc/${peer.pid}`)).toBe(true);
  } finally {
    peer.kill('SIGTERM');
    await new Promise((resolve) => peer.once('close', resolve));
    restoreWorkerEnvironment(old);
  }
});

test('stack-free placement: explicit pure file tests lint and pure type commands default local without a remote slot', async () => {
  expect(await needsStack(['bun', 'test', 'services/importer/tests/media-fence-evidence.test.ts'])).toBe(false);
  expect(await needsStack(['bun', 'test', 'services/importer/tests/media-fence-evidence.test.ts', '-t', 'fence'])).toBe(
    false,
  );
  expect(await needsStack(['bun', 'x', 'oxlint', '.'])).toBe(false);
  expect(await needsStack(['bun', 'x', 'oxfmt', '--check', '.'])).toBe(false);
  expect(await needsStack(['bun', 'run', 'lint'])).toBe(false);
  expect(await needsStack(['bun', 'run', 'format:check'])).toBe(false);
  expect(await needsStack(['bun', 'run', '--cwd', 'services/importer', 'typecheck'])).toBe(false);
  expect(await needsStack(['bun', 'run', '--cwd', 'packages/filter', 'typecheck'])).toBe(false);
  expect(await needsStack(['bun', 'check', '--no-script', '-p', 'packages/filter/tsconfig.json'])).toBe(false);
  expect(await needsStack(['tsc', '--noEmit', '-p', 'packages/filter/tsconfig.json'])).toBe(false);
});

test('stack-free placement: native kernel Auth Web isolated and real compiler-database routes retain stack placement', async () => {
  expect(await needsStack(['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/http/body-limit.test.ts'])).toBe(
    true,
  );
  expect(await needsStack(['bun', 'run', '--cwd=services/auth', 'check'])).toBe(true);
  expect(await needsStack(['bun', 'run', '--cwd', 'apps/auth', 'test'])).toBe(true);
  expect(await needsStack(['bun', 'run', '--cwd', 'apps/web', 'check'])).toBe(true);
  expect(await needsStack(['bun', 'test', 'apps/web/tests/auth-binding.host.test.ts'])).toBe(true);
  expect(await needsStack(['bun', 'apps/web/scripts/check.ts', '--auth-binding-host'])).toBe(true);
  expect(await needsStack(['bun', 'apps/auth/scripts/isolated.ts', 'bun', 'test'])).toBe(true);
  expect(await needsStack(['bun', 'scripts/typecheck.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test', 'scripts/typecheck.test.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test', 'scripts/remote-check.test.ts'])).toBe(true);
});

test('stack-free placement: cwd and env wrappers retain command meaning and ambiguous shell or discovery remains conservative', async () => {
  const importerFile = 'services/importer/tests/media-fence-evidence.test.ts';
  const absoluteImporterFile = join(repository, importerFile);
  expect(await needsStack(['env', 'WRAPPER_KEEP=yes', 'bun', 'test', absoluteImporterFile, '-t', 'fence'])).toBe(false);
  expect(
    await needsStack(['bun', 'test', importerFile, '--test-name-pattern', 'services/kernel/test/native.test.ts']),
  ).toBe(false);
  expect(await needsStack(['bun', 'test', importerFile, '-t', 'services/kernel/test/native.test.ts'])).toBe(false);
  expect(await needsStack(['env', '-u', 'WRAPPER_REMOVE', 'WRAPPER_KEEP=yes', 'bun', 'test', importerFile])).toBe(
    false,
  );
  expect(await needsStack(['bun', 'test', importerFile, 'services/kernel/test'])).toBe(true);
  expect(await needsStack(['bun', 'test', importerFile, '--preload', 'services/kernel/test/preload.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test', importerFile, '--require', 'services/kernel/test/preload.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test', importerFile, '--preload=services/kernel/test/preload.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test', join(repository, 'services/kernel/test/native.test.ts')])).toBe(true);
  expect(await needsStack(['bun', 'test', 'test/native.test.ts'], join(repository, 'services/kernel'))).toBe(true);
  expect(await needsStack(['bun', 'run', '--cwd=services/kernel', 'check'])).toBe(true);
  expect(await needsStack(['sh', '-c', 'bun test services/importer/tests/media-fence-evidence.test.ts'])).toBe(true);
  expect(await needsStack(['bun', 'test'])).toBe(true);
  expect(await needsStack(['bun', 'run', 'scripts/unknown-check.ts'])).toBe(true);

  const fixture = workerFixture();
  const marker = join(fixture.root, 'wrapper-marker');
  const file = join(fixture.root, 'services/importer/tests/wrapper.test.ts');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';\nimport { expect, test } from 'bun:test';\ntest('selected wrapper case', () => { expect(process.env.WRAPPER_KEEP).toBe('yes'); expect(process.env.WRAPPER_REMOVE).toBeUndefined(); appendFileSync(process.env.WORKER_WRAPPER_MARKER!, 'selected\\n'); });\ntest('other wrapper case', () => appendFileSync(process.env.WORKER_WRAPPER_MARKER!, 'other\\n'));\n`,
  );
  const old = { ...process.env };
  try {
    workerEnv(fixture);
    process.env.WRAPPER_REMOVE = 'remove-me';
    process.env.WORKER_WRAPPER_MARKER = marker;
    const command = [
      'env',
      '-u',
      'WRAPPER_REMOVE',
      'WRAPPER_KEEP=yes',
      'bun',
      'test',
      'services/importer/tests/wrapper.test.ts',
      '--test-name-pattern',
      'selected wrapper case',
    ];
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('selected\n');
    expect(existsSync(fixture.remoteEvents)).toBe(false);
    expect(
      resolveRepositoryBun(
        ['env', '-u', 'WRAPPER_REMOVE', 'WRAPPER_KEEP=yes', 'bun', 'test'],
        fixture.root,
        '/pinned/bun',
      ),
    ).toEqual(['env', '-u', 'WRAPPER_REMOVE', 'WRAPPER_KEEP=yes', '/pinned/bun', 'test']);
  } finally {
    restoreWorkerEnvironment(old);
  }
});

test('stack-free placement: a real managed local check completes while every fake remote slot is unavailable with truthful result and memory ownership', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const hosts = join(fixture.root, 'hosts.json');
  const marker = join(fixture.root, 'local-marker');
  const file = 'services/importer/tests/media-fence-evidence.test.ts';
  const testFile = join(fixture.root, file);
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(
    testFile,
    `import { writeFileSync } from 'node:fs';\nimport { expect, test } from 'bun:test';\ntest('local importer evidence', () => { const lease = process.env.REZICS_CHECK_MEMORY_LEASE; expect(lease).toBeTruthy(); writeFileSync(${JSON.stringify(marker)}, lease!); console.log('local importer evidence ran'); });\n`,
  );
  writeFileSync(hosts, JSON.stringify({ hosts: [{ name: 'unavailable', slots: 0 }] }));
  const command = ['bun', 'test', file];
  const commandClass = checkClass(command, fixture.root);
  const holder = await acquireStackSlot(
    'held local memory slot',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: fixture.memory,
    },
    4,
  );
  let id: string | undefined;
  let waiting: Promise<number> | undefined;
  try {
    workerEnv(fixture, hosts);
    expect(existsSync(join(fixture.memory, 'peaks.json'))).toBe(false);
    expect(checkMemoryWeight([], 4)).toBe(4);
    process.env.WORKER_REMOTE_MODE = 'transport';
    id = startWorkerCheck(command, fixture.root);
    const resultDirectory = join(fixture.root, '.temp/goal/checks/results');
    const recordFile = join(resultDirectory, `${id}.json`);
    const recordLog = join(fixture.root, JSON.parse(readFileSync(recordFile, 'utf8')).log as string);
    const report: string[] = [];
    waiting = waitWorkerCheck(id, fixture.root, 10_000, {
      pollMs: 10,
      stallMs: 5_000,
      write: (line) => report.push(line),
    });
    await untilRecorded(() => readFileSync(recordLog, 'utf8').includes(`${commandClass} waiting (4/4 held, 0 ahead)`));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(fixture.remoteEvents)).toBe(false);
    expect(existsSync(fixture.remoteArgs)).toBe(false);
    await holder.release();
    expect(await waiting).toBe(0);
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      id: string;
      argv: string[];
      status: string;
      exitCode: number;
      log: string;
    };
    expect(record).toMatchObject({ id, argv: command, status: 'finished', exitCode: 0 });
    expect(readFileSync(marker, 'utf8')).toMatch(/^\d+\/4$/);
    expect(report.join('')).toContain('check: exit status 0');
    expect(readFileSync(join(fixture.root, record.log), 'utf8')).toContain('local importer evidence ran');
    expect(readFileSync(join(fixture.root, record.log), 'utf8')).toContain('waiting (4/4 held, 0 ahead)');
    expect(readFileSync(join(fixture.root, record.log), 'utf8')).toMatch(/slots [\d,]+ \(4\/4\) after \d+ ms/);
    expect(readFileSync(join(fixture.root, record.log), 'utf8')).not.toContain('remote-check:');
    expect(existsSync(fixture.remoteEvents)).toBe(false);
  } finally {
    await holder.release();
    if (waiting) {
      const status = await waiting.catch(() => 75);
      if (status === 75 && id) stopOwnedWorkerCheck(id, fixture.root);
    }
    restoreWorkerEnvironment(old);
  }
});

test('stack-free placement: native command still reaches existing remote admission and explicit local and already-remote behavior remain compatible', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const hosts = join(fixture.root, 'hosts.json');
  const marker = join(fixture.root, 'local-marker');
  const file = 'services/kernel/test/native-placement.test.ts';
  const testFile = join(fixture.root, file);
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(
    testFile,
    `import { writeFileSync } from 'node:fs';\nimport { expect, test } from 'bun:test';\ntest('native placement fixture', () => { expect(process.env.REZICS_CHECK_MEMORY_LEASE).toBeTruthy(); writeFileSync(${JSON.stringify(marker)}, 'local'); });\n`,
  );
  writeFileSync(hosts, JSON.stringify({ hosts: [{ name: 'available', slots: 1 }] }));
  const command = ['bun', 'test', file];
  const commandClass = checkClass(command, fixture.root);
  try {
    workerEnv(fixture, hosts);
    for (let index = 0; index < 3; index += 1) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(existsSync(marker)).toBe(false);

    rmSync(fixture.remoteEvents);
    expect(await runWorkerCheck(['--local', ...command], fixture.root, false)).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(fixture.remoteEvents)).toBe(false);

    rmSync(marker);
    process.env.KERNEL_CHECK_ON_REMOTE = '1';
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('local');
    expect(existsSync(fixture.remoteEvents)).toBe(false);
  } finally {
    restoreWorkerEnvironment(old);
  }
});

test('worker checks at least 2 GiB run remotely and record the remote peak under their class', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root)).toBe(0);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    const remoteArgv = JSON.parse(readFileSync(fixture.remoteEvents + '.args', 'utf8')) as string[];
    expect(remoteArgv.slice(0, 3)).toEqual(['--memory-gib', '2', fixture.root]);
    expect(JSON.parse(readFileSync(join(fixture.memory, 'peaks.json'), 'utf8'))[commandClass]).toEqual([
      2 * 2 ** 30,
      2 * 2 ** 30,
      2 * 2 ** 30,
      3 * 2 ** 30,
    ]);
    expect(
      readFileSync(
        join(fixture.root, '.temp/goal/checks', readdirSync(join(fixture.root, '.temp/goal/checks'))[0]!),
        'utf8',
      ),
    ).toContain('peak memory 3072 MiB');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('growth profile: a worker check sent to a remote host with GROWTH_PROFILE naming a file inside the worktree runs the remote command with GROWTH_PROFILE set to the same worktree-relative path and passes that path to remote-check as a returned output', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const profile = 'services/kernel/.temp/growth/profile.jsonl';
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.GROWTH_PROFILE = profile;
    process.env.WORKER_REMOTE_PROFILE_OUTPUT = join(fixture.root, profile);
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    const remoteArgs = JSON.parse(readFileSync(fixture.remoteArgs, 'utf8')) as string[];
    expect(remoteArgs.slice(0, 5)).toEqual(['--memory-gib', '2', '--returns', profile, fixture.root]);
    expect(remoteArgs).toContain(profile);
    expect(remoteArgs).toContain('export GROWTH_PROFILE="$PWD/$1"; shift; exec "$@"');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_ARGS',
      'WORKER_REMOTE_PROFILE_OUTPUT',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GROWTH_PROFILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('growth profile: lines already in the local profile file are kept when the returned file arrives', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const profile = 'growth-profile.jsonl';
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.GROWTH_PROFILE = profile;
    process.env.WORKER_REMOTE_PROFILE_OUTPUT = join(fixture.root, profile);
    writeFileSync(join(fixture.root, profile), 'existing growth\n');
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    expect(readFileSync(join(fixture.root, profile), 'utf8')).toBe('existing growth\nremote growth\n');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_ARGS',
      'WORKER_REMOTE_PROFILE_OUTPUT',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GROWTH_PROFILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('growth profile: a GROWTH_PROFILE outside the worktree is a usage error naming the path', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const outside = join(fixture.root, '..', 'outside-growth-profile.jsonl');
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.GROWTH_PROFILE = outside;
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    await expect(runWorkerCheck(command, fixture.root, false)).rejects.toThrow(
      `GROWTH_PROFILE must be inside the worktree: ${outside}`,
    );
    expect(existsSync(fixture.remoteEvents)).toBe(false);
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_ARGS',
      'WORKER_REMOTE_PROFILE_OUTPUT',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GROWTH_PROFILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('growth profile: a worker check without GROWTH_PROFILE passes no extra environment or returned output', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    delete process.env.GROWTH_PROFILE;
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root, false)).toBe(0);
    const remoteArgs = JSON.parse(readFileSync(fixture.remoteArgs, 'utf8')) as string[];
    expect(remoteArgs).toEqual(['--memory-gib', '2', fixture.root, '--', ...command]);
    expect(remoteArgs).not.toContain('--returns');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_ARGS',
      'WORKER_REMOTE_PROFILE_OUTPUT',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GROWTH_PROFILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('remote slot wait heartbeats emitted by the runner reach the local check log', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.WORKER_REMOTE_MODE = 'queued';
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
    expect(await runWorkerCheck(command, fixture.root)).toBe(0);
    const logDirectory = join(fixture.root, '.temp/goal/checks');
    const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
    expect(
      log.match(/remote-check: every check slot is busy; waiting.*check-a 0\/1 free/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('ordinary classes, --local, and unreadable hosts files run locally under the memory lease', async () => {
  for (const mode of ['light', 'local', 'unreadable'] as const) {
    const fixture = workerFixture();
    const old = { ...process.env };
    try {
      workerEnv(fixture, join(fixture.root, 'hosts.json'));
      writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
      const command = localCommand(fixture.localMarker);
      if (mode === 'light') {
        const commandClass = checkClass(command, fixture.root);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
        recordPeak(fixture.memory, commandClass, 1 * 2 ** 30);
      } else if (mode === 'local') command.unshift('--local');
      else process.env.KERNEL_CHECK_REMOTE = join(fixture.root, 'missing-hosts.json');
      expect(await runWorkerCheck(command, fixture.root)).toBe(0);
      expect(readFileSync(fixture.localMarker, 'utf8')).not.toBe('missing');
      expect(() => readFileSync(fixture.remoteEvents, 'utf8')).toThrow();
    } finally {
      for (const key of [
        'REZICS_CHECK_MEMORY',
        'REZICS_CHECK_MEMORY_DIR',
        'REZICS_CHECK_MEMORY_GIB',
        'REZICS_CHECK_SCOPE',
        'WORKER_REMOTE_EVENTS',
        'WORKER_REMOTE_MODE',
        'KERNEL_CHECK_REMOTE',
      ]) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key]!;
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('a class with three sub-256 MiB peaks skips the memory lease and explains the percentile', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture);
    const command = localCommand(fixture.localMarker);
    const commandClass = checkClass(command, fixture.root);
    for (const peak of [100, 120, 200]) recordPeak(fixture.memory, commandClass, peak * 2 ** 20);
    expect(await runWorkerCheck(command, fixture.root)).toBe(0);
    const logDirectory = join(fixture.root, '.temp/goal/checks');
    const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
    expect(log).toContain('local p90 200.0 MiB; skipping local memory lease');
    expect(log).not.toContain('worker-check: waiting');
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a local memory lease wait is appended to the goal wait file while it is waiting', async () => {
  const fixture = workerFixture();
  const leaseDirectory = join(fixture.root, 'lease');
  const waitFile = join(fixture.root, 'goal-wait');
  const old = { ...process.env };
  const holder = await acquireStackSlot('holder', { REZICS_STACK_SLOTS: '1', REZICS_STACK_LEASE_DIR: leaseDirectory });
  try {
    workerEnv(fixture);
    process.env.REZICS_CHECK_MEMORY_DIR = leaseDirectory;
    process.env.REZICS_CHECK_MEMORY_GIB = '1';
    process.env.GOAL_CHECK_WAIT_FILE = waitFile;
    const running = runWorkerCheck(localCommand(fixture.localMarker), fixture.root, false, undefined, 15);
    await untilRecorded(
      () =>
        existsSync(waitFile) &&
        readFileSync(waitFile, 'utf8')
          .trim()
          .split('\n')
          .some((line) => Number(line) > 0),
    );
    await holder.release();
    expect(await running).toBe(0);
    expect(
      readFileSync(waitFile, 'utf8')
        .trim()
        .split('\n')
        .reduce((sum, line) => sum + Number(line), 0),
    ).toBeGreaterThan(0);
  } finally {
    await holder.release();
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GOAL_CHECK_WAIT_FILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a remote transport retry keeps recording the local memory lease wait', async () => {
  const fixture = workerFixture();
  const leaseDirectory = join(fixture.root, 'lease');
  const waitFile = join(fixture.root, 'goal-wait');
  const old = { ...process.env };
  writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
  const command = localCommand(fixture.localMarker);
  const commandClass = checkClass(command, fixture.root);
  for (const peak of [3, 3, 3]) recordPeak(fixture.memory, commandClass, peak * 2 ** 30);
  const holder = await acquireStackSlot(
    'holder',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: leaseDirectory,
    },
    4,
  );
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    process.env.WORKER_REMOTE_MODE = 'transport';
    process.env.REZICS_CHECK_MEMORY_DIR = leaseDirectory;
    process.env.REZICS_CHECK_MEMORY_GIB = '4';
    process.env.GOAL_CHECK_WAIT_FILE = waitFile;
    const running = runWorkerCheck(command, fixture.root, false, undefined, 15);
    await untilRecorded(
      () =>
        existsSync(waitFile) &&
        readFileSync(waitFile, 'utf8')
          .trim()
          .split('\n')
          .some((line) => Number(line) > 0),
    );
    await holder.release();
    expect(await running).toBe(0);
  } finally {
    await holder.release();
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'GOAL_CHECK_WAIT_FILE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a remote transport failure is logged and rerun once locally, but a failed command is not retried', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.WORKER_REMOTE_MODE = 'transport';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(0);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(readFileSync(fixture.localMarker, 'utf8')).not.toBe('missing');
    const logDirectory = join(fixture.root, '.temp/goal/checks');
    const log = readFileSync(join(logDirectory, readdirSync(logDirectory)[0]!), 'utf8');
    expect(log).toContain(
      'remote transport failed: remote-check: connection to host failed during rsync before a result',
    );

    rmSync(fixture.remoteEvents, { force: true });
    rmSync(fixture.localMarker, { force: true });
    process.env.WORKER_REMOTE_MODE = 'failure';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(7);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(() => readFileSync(fixture.localMarker, 'utf8')).toThrow();

    rmSync(fixture.remoteEvents, { force: true });
    process.env.WORKER_REMOTE_MODE = 'failure-75';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root)).toBe(75);
    expect(readFileSync(fixture.remoteEvents, 'utf8')).toBe('remote\n');
    expect(() => readFileSync(fixture.localMarker, 'utf8')).toThrow();
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

function overloadFixture(): string {
  const root = mkdtempSync(join(repository, '.temp/worker-check-overload-'));
  dirs.push(root);
  return root;
}

test('overload rerun: reruns only failing files once under admission, passes on success, and records the rerun', async () => {
  const root = overloadFixture();
  const healthyRuns = join(root, 'healthy-runs');
  const failedRuns = join(root, 'failed-runs');
  writeFileSync(
    join(root, 'healthy.test.ts'),
    `import { test, expect } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
test('healthy file runs only once', () => {
  expect(existsSync(${JSON.stringify(healthyRuns)})).toBe(false);
  writeFileSync(${JSON.stringify(healthyRuns)}, 'ran');
});
`,
  );
  writeFileSync(
    join(root, 'overloaded.test.ts'),
    `import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('transient response', () => {
  const count = existsSync(${JSON.stringify(failedRuns)}) ? Number(readFileSync(${JSON.stringify(failedRuns)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(failedRuns)}, String(count + 1));
  if (count === 0) throw new Error('HTTP 503 deadline_exceeded');
  expect(true).toBe(true);
});
`,
  );
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', 'test', 'healthy.test.ts', 'overloaded.test.ts'], root);
    const record = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
    const status = await waitWorkerCheck(id, root, 10_000);
    if (status !== 0)
      process.stderr.write(`nested overload check log:\n${readFileSync(join(root, record.log), 'utf8')}\n`);
    expect(status).toBe(0);
    const finished = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
    expect(finished.reruns).toBe(1);
    expect(readFileSync(healthyRuns, 'utf8')).toBe('ran');
    expect(readFileSync(failedRuns, 'utf8')).toBe('2');
    const log = readFileSync(join(root, record.log), 'utf8');
    expect(log).toContain('overload rerun files overloaded.test.ts');
    expect(log).toContain('reason: HTTP 503 deadline_exceeded');
    expect(log).toContain(`host: ${hostname()}`);
  });
});

test('overload rerun: a second 503 failure fails and reports both runs reasons', async () => {
  const root = overloadFixture();
  const attempts = join(root, 'attempts');
  const source = `const fs = require('node:fs');
const count = fs.existsSync(${JSON.stringify(attempts)}) ? Number(fs.readFileSync(${JSON.stringify(attempts)}, 'utf8')) : 0;
fs.writeFileSync(${JSON.stringify(attempts)}, String(count + 1));
console.error('(fail) request [1ms]\\n  Error: HTTP 503 ' + (count === 0 ? 'deadline_exceeded' : 'overloaded'));
process.exit(1);`;
  await withQuietAdmission(async () => {
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => (
      out.push(String(chunk)),
      true
    )) as typeof process.stdout.write;
    try {
      expect(await runWorkerCheck(['bun', '-e', source], root)).toBe(1);
    } finally {
      process.stdout.write = write;
    }
    expect(readFileSync(attempts, 'utf8')).toBe('2');
    expect(out.join('')).toContain('HTTP 503 deadline_exceeded');
    expect(out.join('')).toContain('HTTP 503 overloaded');
  });
});

test('overload rerun: any other failure prevents rerunning the command', async () => {
  const root = overloadFixture();
  const attempts = join(root, 'attempts');
  const source = `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(attempts)}, 'ran');
console.error('(fail) overloaded request [1ms]\\n  Error: HTTP 503 overloaded\\n(fail) product defect [1ms]\\n  Error: HTTP 500 internal_error');
process.exit(1);`;
  await withQuietAdmission(async () => {
    expect(await runWorkerCheck(['bun', '-e', source], root)).toBe(1);
    expect(readFileSync(attempts, 'utf8')).toBe('ran');
  });
});

test('overload rerun: unattributed failures rerun the whole command once', async () => {
  const root = overloadFixture();
  const attempts = join(root, 'attempts');
  const source = `const fs = require('node:fs');
const count = fs.existsSync(${JSON.stringify(attempts)}) ? Number(fs.readFileSync(${JSON.stringify(attempts)}, 'utf8')) : 0;
fs.writeFileSync(${JSON.stringify(attempts)}, String(count + 1));
if (count === 0) { console.error('(fail) request [1ms]\\n  Error: HTTP 503 overloaded'); process.exit(1); }
console.log('pass');`;
  await withQuietAdmission(async () => {
    expect(await runWorkerCheck(['bun', '-e', source], root)).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('2');
    const directory = join(root, '.temp/goal/checks');
    const log = readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8');
    expect(log).toContain('overload rerun files whole command (test files could not be attributed)');
  });
});

function recoveryFixture(): string {
  const parent = join(import.meta.dir, '../.temp/worker-check-recovery-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'check-'));
  dirs.push(root);
  return root;
}

async function untilRecorded(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test('a silent verified runner and its command are stopped before the detached rerun completes', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'first-command');
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `
      const fs = require('node:fs');
      if (fs.existsSync(${JSON.stringify(marker)})) { console.error('rerun completed'); process.exit(0); }
      fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
      ],
      root,
    );
    const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
    await untilRecorded(() => existsSync(marker));
    const original = JSON.parse(readFileSync(resultPath, 'utf8'));
    const stale = new Date(Date.now() - 100);
    utimesSync(join(root, original.log), stale, stale);
    const out: string[] = [];
    expect(
      await waitWorkerCheck(id, root, 5_000, {
        stallMs: 50,
        rerunStallMs: 2_000,
        pollMs: 5,
        write: (line) => out.push(line),
      }),
    ).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(result.runnerPid).not.toBe(original.runnerPid);
    expect(result.log).not.toBe(original.log);
    expect(result.reruns).toBe(1);
    expect(out.join('')).toContain('infrastructure failure (log did not grow for 50 ms)');
    const commandPid = readFileSync(marker, 'utf8');
    await untilRecorded(() => {
      try {
        return readFileSync(`/proc/${commandPid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z');
      } catch {
        return true;
      }
    });
  });
});

test('CPU sampling follows parent links, includes descendants and excludes unrelated processes', () => {
  const root = recoveryFixture();
  const stat = (pid: number, parent: number, user: number, system: number) => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(
      join(root, String(pid), 'stat'),
      `${pid} (command with ) parentheses) S ${parent} 0 0 0 0 0 0 0 0 0 ${user} ${system}\n`,
    );
  };
  stat(10, 1, 0, 0);
  stat(11, 10, 110, 20);
  stat(12, 11, 30, 40);
  stat(13, 1, 500, 600);
  mkdirSync(join(root, '14')); // A process that exited before its stat could be read.
  expect(processTreeCpuTicks(10, root)).toBe(200);
  expect(processTreeCpuTicks(11, root)).toBe(200);
  expect(processTreeCpuTicks(99, root)).toBeUndefined();
  expect(processTreeCpuTicks(10, join(root, 'unavailable'))).toBeUndefined();
});

test('local progress accumulates quiet descendant CPU and stops sampling when the command exits', async () => {
  const root = recoveryFixture();
  const procRoot = join(root, 'proc');
  const pidFile = join(root, 'pid');
  const stopFile = join(root, 'stop');
  const log = join(root, 'command.log');
  mkdirSync(procRoot);
  const overrides = {
    REZICS_CHECK_PROGRESS_INTERVAL_MS: '10',
    REZICS_CHECK_PROC_ROOT: procRoot,
    REZICS_CHECK_PROGRESS_PID_FILE: pidFile,
  };
  const old = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    await withQuietAdmission(async () => {
      const running = runWorkerCheck(
        ['bun', '-e', `while (!require('node:fs').existsSync(${JSON.stringify(stopFile)})) await Bun.sleep(5)`],
        root,
        false,
        log,
      );
      try {
        await untilRecorded(() => existsSync(pidFile));
        const pid = Number(readFileSync(pidFile, 'utf8'));
        const stat = (processId: number, parent: number, ticks: number) => {
          mkdirSync(join(procRoot, String(processId)), { recursive: true });
          writeFileSync(
            join(procRoot, String(processId), 'stat'),
            `${processId} (quiet child) S ${parent} 0 0 0 0 0 0 0 0 0 ${ticks} 0\n`,
          );
        };
        stat(pid, 1, 0);
        stat(pid + 1, pid, 125);
        stat(pid + 2, 1, 10_000);
        await untilRecorded(() => readFileSync(log, 'utf8').includes('worker-check: running, 1 CPU seconds'));
        const firstReport = readFileSync(log, 'utf8');
        stat(pid + 1, pid, 165);
        await Bun.sleep(35);
        expect(readFileSync(log, 'utf8')).toBe(firstReport);
        stat(pid + 1, pid, 245);
        await untilRecorded(() => readFileSync(log, 'utf8').includes('worker-check: running, 2 CPU seconds'));
        expect(readFileSync(log, 'utf8')).toBe(
          'worker-check: running, 1 CPU seconds\nworker-check: running, 2 CPU seconds\n',
        );
      } finally {
        writeFileSync(stopFile, '');
        expect(await running).toBe(0);
      }
      const completed = readFileSync(log, 'utf8');
      await Bun.sleep(35);
      expect(readFileSync(log, 'utf8')).toBe(completed);
    });
  } finally {
    for (const key of Object.keys(overrides)) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test('a quiet local command with CPU progress is not stopped as stalled and its runner ends cleanly', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'progress-pid');
  const procRoot = join(root, 'fake-proc');
  mkdirSync(procRoot);
  const oldInterval = process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS;
  const oldProcRoot = process.env.REZICS_CHECK_PROC_ROOT;
  const oldPidFile = process.env.REZICS_CHECK_PROGRESS_PID_FILE;
  process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS = '5';
  process.env.REZICS_CHECK_PROC_ROOT = procRoot;
  process.env.REZICS_CHECK_PROGRESS_PID_FILE = marker;
  try {
    await withQuietAdmission(async () => {
      const id = startWorkerCheck(['bun', '-e', 'const end = Date.now() + 700; while (Date.now() < end) {}'], root);
      const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
      const originalLog = JSON.parse(readFileSync(resultPath, 'utf8')).log as string;
      await untilRecorded(() => existsSync(marker));
      const commandPid = Number(readFileSync(marker, 'utf8'));
      mkdirSync(join(procRoot, String(commandPid)));
      const stat = ['S', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '160', '0'].join(' ');
      const statFile = join(procRoot, String(commandPid), 'stat');
      writeFileSync(statFile, `${commandPid} (quiet-command) ${stat}\n`);
      expect(processTreeCpuTicks(commandPid, procRoot)).toBe(160);
      let fakeTicks = 160;
      const cpuProgress = setInterval(() => {
        fakeTicks += 100;
        const advancingStat = ['S', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', String(fakeTicks), '0'].join(' ');
        writeFileSync(statFile, `${commandPid} (quiet-command) ${advancingStat}\n`);
      }, 20);
      const out: string[] = [];
      const result = await waitWorkerCheck(id, root, 2_000, {
        stallMs: 200,
        pollMs: 5,
        write: (line) => out.push(line),
      });
      clearInterval(cpuProgress);
      const record = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
      const log = readFileSync(join(root, originalLog), 'utf8');
      expect(result, `${out.join('')}\n${log}`).toBe(0);
      expect(out.join('')).not.toContain('infrastructure failure');
      expect(record.reruns).toBeUndefined();
      expect(readFileSync(join(root, record.log), 'utf8')).toContain('worker-check: running, 1 CPU seconds');
      await untilRecorded(() => !existsSync(`/proc/${commandPid}`));
      const runnerPid = record.runnerPid as number;
      await untilRecorded(() => {
        try {
          return readFileSync(`/proc/${runnerPid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z');
        } catch {
          return true;
        }
      });
    });
  } finally {
    if (oldInterval === undefined) delete process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS;
    else process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS = oldInterval;
    if (oldProcRoot === undefined) delete process.env.REZICS_CHECK_PROC_ROOT;
    else process.env.REZICS_CHECK_PROC_ROOT = oldProcRoot;
    if (oldPidFile === undefined) delete process.env.REZICS_CHECK_PROGRESS_PID_FILE;
    else process.env.REZICS_CHECK_PROGRESS_PID_FILE = oldPidFile;
  }
});

test('a quiet local command with no CPU progress is stopped by the stall rule', async () => {
  const root = recoveryFixture();
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'setInterval(() => {}, 1000)'], root);
    const out: string[] = [];
    expect(
      await waitWorkerCheck(id, root, 2_000, {
        stallMs: 50,
        rerunStallMs: 50,
        pollMs: 5,
        write: (line) => out.push(line),
      }),
    ).toBe(1);
    expect(out.join('')).toContain('infrastructure failure (log did not grow for 50 ms)');
    expect(
      readFileSync(
        join(root, JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8')).log),
        'utf8',
      ),
    ).not.toContain('worker-check: running');
  });
});

test('a detached recovery survives a bounded wait and returns its own failing exit status on the same id', async () => {
  const root = recoveryFixture();
  const id = '00000000-0000-4000-8000-000000000007';
  const log = '.temp/goal/checks/original.log';
  mkdirSync(join(root, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(root, log), 'original output\n');
  writeRunningRecord(root, id, log, 2_000_000_000, hostname());
  const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
  const initial = JSON.parse(readFileSync(resultPath, 'utf8'));
  initial.argv = ['bun', '-e', 'await Bun.sleep(300); console.error("rerun failed"); process.exit(7)'];
  writeFileSync(resultPath, JSON.stringify(initial));
  await withQuietAdmission(async () => {
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 50, { pollMs: 5, write: (line) => out.push(line) })).toBe(75);
    expect(out.join('')).toContain('check: still running');
    const rerun = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(rerun.runnerPid).not.toBe(process.pid);
    expect(readFileSync(`/proc/${rerun.runnerPid}/cmdline`, 'utf8')).toContain(`--run\0${id}\0`);
    out.length = 0;
    expect(await waitWorkerCheck(id, root, 5_000, { write: (line) => out.push(line) })).toBe(7);
    expect(out.join('')).toContain('infrastructure failure');
    expect(out.join('')).toContain('check: exit status 7');
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).reruns).toBe(1);
  });
});

test('a second silent runner finishes with infrastructure failure and no third command', async () => {
  const root = recoveryFixture();
  const marker = join(root, 'commands');
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(
      [
        'bun',
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n'); setInterval(() => {}, 1000)`,
      ],
      root,
    );
    const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
    await untilRecorded(() => existsSync(marker));
    const first = JSON.parse(readFileSync(resultPath, 'utf8'));
    const stale = new Date(Date.now() - 100);
    utimesSync(join(root, first.log), stale, stale);
    expect(await waitWorkerCheck(id, root, 5_000, { stallMs: 50, rerunStallMs: 500, pollMs: 5, write: () => {} })).toBe(
      1,
    );
    expect(readFileSync(marker, 'utf8')).toBe('run\nrun\n');
    const final = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(final.status).toBe('finished');
    expect(final.reruns).toBe(1);
    expect(final.infrastructureFailureFinal).toBe(true);
    expect(await waitWorkerCheck(id, root, 0, { write: () => {} })).toBe(1);
  });
});

test('a command exit status 75 is distinguished from a running check', async () => {
  const root = recoveryFixture();
  await withQuietAdmission(async () => {
    const id = startWorkerCheck(['bun', '-e', 'process.exit(75)'], root);
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 5_000, { write: (line) => out.push(line) })).toBe(75);
    expect(out.join('')).toContain('check: exit status 75');
    expect(out.join('')).not.toContain('check: still running');
  });
});

test('memory wait heartbeats keep a queued check alive across successive bounded waits without a recorded pid', async () => {
  const root = recoveryFixture();
  const memory = join(root, 'memory');
  const holder = await acquireStackSlot('holder', { REZICS_STACK_SLOTS: '1', REZICS_STACK_LEASE_DIR: memory });
  const old = { ...process.env };
  const id = '00000000-0000-4000-8000-000000000008';
  const log = '.temp/goal/checks/queued.log';
  const record = { id, cwd: root, status: 'running', log, argv: ['bun', '-e', 'console.error("admitted")'] };
  const resultDirectory = join(root, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(join(resultDirectory, `${id}.json`), JSON.stringify(record));
  Object.assign(process.env, {
    REZICS_CHECK_MEMORY: 'on',
    REZICS_CHECK_MEMORY_DIR: memory,
    REZICS_CHECK_MEMORY_GIB: '1',
    REZICS_CHECK_SCOPE: 'off',
  });
  delete process.env.KERNEL_CHECK_REMOTE;
  const command = runWorkerCheck(record.argv, root, false, join(root, log), 15);
  try {
    await untilRecorded(() => readFileSync(join(root, log), 'utf8').includes('waiting (1/1 held, 0 ahead)'));
    for (let attempt = 0; attempt < 5; attempt++) {
      const out: string[] = [];
      expect(await waitWorkerCheck(id, root, 60, { stallMs: 200, pollMs: 5, write: (line) => out.push(line) })).toBe(
        75,
      );
      expect(out.join('')).toContain('waiting (1/1 held, 0 ahead)');
      expect(JSON.parse(readFileSync(join(resultDirectory, `${id}.json`), 'utf8')).reruns).toBeUndefined();
    }
  } finally {
    await holder.release();
    await command;
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'KERNEL_CHECK_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('a worker already on a check host runs its command locally without relaying again', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  try {
    workerEnv(fixture, join(fixture.root, 'hosts.json'));
    writeFileSync(join(fixture.root, 'hosts.json'), JSON.stringify({ hosts: [] }));
    process.env.KERNEL_CHECK_ON_REMOTE = '1';
    expect(await runWorkerCheck(localCommand(fixture.localMarker), fixture.root, false)).toBe(0);
    expect(existsSync(fixture.localMarker)).toBe(true);
    expect(existsSync(fixture.remoteEvents)).toBe(false);
  } finally {
    for (const key of [
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_DIR',
      'REZICS_CHECK_MEMORY_GIB',
      'REZICS_CHECK_SCOPE',
      'WORKER_REMOTE_EVENTS',
      'WORKER_REMOTE_MODE',
      'KERNEL_CHECK_REMOTE',
      'KERNEL_CHECK_ON_REMOTE',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});
