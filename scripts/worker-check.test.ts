import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { acquireStackSlot } from './stack-lease.ts';
import {
  remoteCheckCustodyCallbacks,
  requestExecutionCancellation,
  type RemoteCheckSettlement,
  type RemotePhysicalRunReceipt,
} from './remote-check.ts';
import {
  processTreeCpuTicks,
  readWorkerCheckHistory,
  readWorkerCheckCleanupHistory,
  readWorkerCheckRecord,
  runWorkerCheck,
  resolveRepositoryBun,
  scopeRootTypecheck,
  startWorkerCheck,
  startControllerWorkerCheck,
  controllerProofExecutionArgv,
  stopWorkerCheck,
  waitWorkerCheck,
  requestWorkerCheckCancellation,
  workerCheckCancellation,
} from './worker-check.ts';
import { WORKER_CHECK_TESTS_AFTER_LANDING } from '../tools/goal/src/worker-check-budget.ts';
import { checkClass, checkMemoryWeight, recordPeak } from './check-memory.ts';
import {
  controllerProofReservationPath,
  controllerProofStatePath,
  processGroupMembers,
  processTreeMembers,
  registrationPath,
  runnerCommandMatches,
  sameProcess,
  initializeRemoteRunCustody,
  physicalHistoryPath,
  processIdentity,
  remoteRunCustodyPath,
  validControllerProofRegistration,
  withCheckFence,
  writeAtomicJson,
  type ControllerProofBindingV1,
} from './check-custody.ts';

const repository = resolve(import.meta.dir, '..');
const dirs: string[] = [];
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
    'REZICS_CHECK_REMOTE_CUSTODY_FILE',
    'REZICS_CHECK_REMOTE_CUSTODY_ID',
    'REZICS_CHECK_PHYSICAL_RUN_ID',
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

test('an ordinary product attempt refuses a test, native, browser or growth command before any upload', () => {
  const directory = mkdtempSync(join(suiteRoot, 'ordinary-product-'));
  dirs.push(directory);
  const previousBudget = process.env.GOAL_WORKER_CHECK_BUDGET;
  const previousDirectory = process.env.GOAL_WORKER_CHECK_BUDGET_DIR;
  try {
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    writeFileSync(join(directory, 'scripts/worker-check.ts'), '');
    const budget = join(directory, 'runs', 'task', '1.check-host-runs');
    mkdirSync(budget, { recursive: true });
    process.env.GOAL_WORKER_CHECK_BUDGET = '2';
    process.env.GOAL_WORKER_CHECK_BUDGET_DIR = budget;
    for (const command of [
      ['bun', 'test', 'apps/web/tests/library.test.ts'],
      ['bun', 'apps/auth/scripts/isolated.ts', 'bun', 'test'],
      ['npx', 'playwright', 'test'],
      ['env', 'GROWTH_PROFILE=profiles/x', 'bun', 'test', 'x.test.ts'],
    ]) {
      expect(() => startWorkerCheck(command, directory)).toThrow(WORKER_CHECK_TESTS_AFTER_LANDING);
    }
    expect(existsSync(join(directory, '.temp/goal/checks'))).toBe(false);
  } finally {
    if (previousBudget === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET;
    else process.env.GOAL_WORKER_CHECK_BUDGET = previousBudget;
    if (previousDirectory === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET_DIR;
    else process.env.GOAL_WORKER_CHECK_BUDGET_DIR = previousDirectory;
  }
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
  const oldAttempt = process.env.GOAL_ATTEMPT;
  const oldRegistry = process.env.GOAL_CHECK_REGISTRY;
  const oldPriority = process.env.REMOTE_CHECK_PRIORITY;
  const registry = join(directory, 'registry');
  mkdirSync(registry);
  process.env.GOAL_TASK_ID = randomUUID();
  process.env.GOAL_ATTEMPT = '1';
  process.env.GOAL_CHECK_REGISTRY = registry;
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
    if (oldAttempt === undefined) delete process.env.GOAL_ATTEMPT;
    else process.env.GOAL_ATTEMPT = oldAttempt;
    if (oldRegistry === undefined) delete process.env.GOAL_CHECK_REGISTRY;
    else process.env.GOAL_CHECK_REGISTRY = oldRegistry;
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
  const oldAttempt = process.env.GOAL_ATTEMPT;
  const oldRegistry = process.env.GOAL_CHECK_REGISTRY;
  const oldPriority = process.env.REMOTE_CHECK_PRIORITY;
  const registry = join(directory, 'registry');
  mkdirSync(registry);
  process.env.GOAL_TASK_ID = randomUUID();
  process.env.GOAL_ATTEMPT = '1';
  process.env.GOAL_CHECK_REGISTRY = registry;
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
    if (oldAttempt === undefined) delete process.env.GOAL_ATTEMPT;
    else process.env.GOAL_ATTEMPT = oldAttempt;
    if (oldRegistry === undefined) delete process.env.GOAL_CHECK_REGISTRY;
    else process.env.GOAL_CHECK_REGISTRY = oldRegistry;
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

async function deadRunnerIdentity() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  if (!child.pid) throw new Error('fixture runner did not start');
  const identity = processIdentity(child.pid);
  if (!identity) throw new Error('fixture runner identity was unavailable');
  child.kill('SIGKILL');
  await new Promise<void>((resolveWait, reject) => {
    child.once('exit', () => resolveWait());
    child.once('error', reject);
  });
  await untilRecorded(() => processGroupMembers(identity.group).length === 0);
  return identity;
}

async function writeLostRemoteCheck(
  root: string,
  state: 'pending' | 'terminal' | 'empty' | 'missing' | 'mismatched',
): Promise<{ id: string; physicalRunId: string; runnerIdentity: Awaited<ReturnType<typeof deadRunnerIdentity>> }> {
  const id = randomUUID();
  const physicalRunId = randomUUID();
  const taskId = randomUUID();
  const ownership = { taskId, attempt: 1 };
  const argv = ['bun', 'test', 'proof.test.ts'];
  const remoteArgv = ['env', 'REZICS_CHECK_TASK_ID=' + taskId, 'bun', 'test', 'proof.test.ts'];
  const runnerIdentity = await deadRunnerIdentity();
  const log = `.temp/goal/checks/worker-check-${id}.log`;
  mkdirSync(join(root, '.temp/goal/checks/results'), { recursive: true });
  writeFileSync(join(root, log), 'remote check reserved\n');
  writeAtomicJson(join(root, '.temp/goal/checks/results', `${id}.json`), {
    custodyVersion: 1,
    id,
    cwd: root,
    argv,
    ownership,
    status: 'running',
    log,
    physicalRunId,
    runnerIdentity,
    runnerPid: runnerIdentity.pid,
    runnerHost: hostname(),
  });
  writeAtomicJson(physicalHistoryPath(root, id, physicalRunId), {
    version: 1,
    id,
    cwd: root,
    argv,
    remoteArgv,
    ownership,
    physicalRunId,
    runnerHost: hostname(),
    runnerIdentity,
    log,
    status: state === 'terminal' ? 'finished' : 'running',
    remoteExpected: true,
    createdAt: new Date().toISOString(),
    ...(state === 'terminal' ? { exitCode: 0, finishedAt: new Date().toISOString() } : {}),
  });
  if (state !== 'missing') {
    initializeRemoteRunCustody(root, physicalRunId, { checkId: id, ownership, argv, remoteArgv });
    const binding = {
      checkId: id,
      ownership,
      argv,
      remoteArgv,
    };
    const attempts =
      state === 'pending'
        ? [{ host: 'check-a', id: 'reservation-pending', status: 'running', startedAt: new Date().toISOString() }]
        : state === 'terminal'
          ? [
              {
                host: 'check-a',
                id: 'reservation-abandoned',
                status: 'not-started',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
              },
              retainedAttempt('check-b', 'reservation-terminal'),
            ]
          : [];
    writeAtomicJson(remoteRunCustodyPath(root, physicalRunId), {
      version: 1,
      physicalRunId: state === 'mismatched' ? randomUUID() : physicalRunId,
      binding,
      status: state === 'terminal' ? 'terminal' : 'running',
      attempts,
      updatedAt: new Date().toISOString(),
    });
  }
  return { id, physicalRunId, runnerIdentity };
}

function retainedAttempt(host: string, run: string) {
  const native = { schema: 1, host, run, exitCode: 0, lifetimeFailure: null, resources: null };
  const settlement = {
    schema: 1,
    host,
    run,
    native,
    preparedInputs: null,
    returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] },
    cleanup: {
      schema: 1,
      host,
      run,
      status: 'verified',
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    },
    transportChildReaped: true,
  };
  return {
    host,
    id: run,
    status: 'terminal',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    native,
    settlement,
    cleanup: settlement.cleanup,
  };
}

async function withIsolatedTask(root: string, run: () => Promise<void>): Promise<void> {
  const old = { ...process.env };
  const registry = join(root, 'registry');
  mkdirSync(registry);
  process.env.GOAL_TASK_ID = randomUUID();
  process.env.GOAL_ATTEMPT = '1';
  process.env.GOAL_CHECK_REGISTRY = registry;
  try {
    await run();
  } finally {
    for (const key of ['GOAL_TASK_ID', 'GOAL_ATTEMPT', 'GOAL_CHECK_REGISTRY']) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

async function stopFixtureCheck(id: string, root: string): Promise<void> {
  const record = readWorkerCheckRecord(id, root);
  if (!record.ownership || !record.physicalRunId || !record.runnerHost || !record.runnerIdentity)
    throw new Error('fixture check did not publish physical custody');
  if (record.status === 'finished') {
    const identity = record.runnerIdentity;
    await untilRecorded(() => !sameProcess(identity) && processGroupMembers(identity.group).length === 0);
    return;
  }
  await stopWorkerCheck(id, root, {
    ownership: record.ownership,
    physicalRunId: record.physicalRunId,
    runnerHost: record.runnerHost,
    runnerIdentity: record.runnerIdentity,
  });
}

// These positive recovery cases use the public launcher; legacy quarantine fixtures stay incomplete.
async function withRecoveryRunner(
  root: string,
  reruns: 0 | 1,
  run: (record: ReturnType<typeof readWorkerCheckRecord>, interrupt: () => Promise<void>) => Promise<void>,
  replacementSource = `fs.appendFileSync(${JSON.stringify(join(root, 'rerun-marker'))}, ${JSON.stringify('rerun\n')});`,
): Promise<void> {
  await withIsolatedTask(root, async () =>
    withQuietAdmission(async () => {
      const attempts = join(root, 'physical-attempts');
      const ready = join(root, 'command-ready');
      const id = startWorkerCheck(
        [
          'bun',
          '-e',
          `
const fs = require('node:fs');
const attempts = ${JSON.stringify(attempts)};
const n = fs.existsSync(attempts) ? Number(fs.readFileSync(attempts, 'utf8')) + 1 : 1;
fs.writeFileSync(attempts, String(n));
if (n === 1 && ${reruns} === 1) {
  console.error('(fail) request [1ms]\\n  Error: HTTP 503 overloaded');
  process.exit(1);
}
if (n === ${reruns + 1}) {
  ${reruns ? "console.error('last rerun output');" : ''}
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  await Bun.sleep(4000);
  process.exit(90);
}
${replacementSource}
`,
        ],
        root,
      );
      try {
        await untilRecorded(() => existsSync(ready));
        const record = readWorkerCheckRecord(id, root);
        const identity = record.runnerIdentity;
        if (!record.physicalRunId || !identity) throw new Error('fixture runner custody is unavailable');
        expect(readWorkerCheckHistory(id, record.physicalRunId, root)?.runnerIdentity).toEqual(identity);
        expect(record.reruns ?? 0).toBe(reruns);
        await run(record, async () => {
          if (!runnerCommandMatches(identity, join(repository, 'scripts/worker-check.ts'), id, record.physicalRunId!))
            throw new Error('fixture runner identity changed before interruption');
          const tree = processTreeMembers(identity.pid);
          process.kill(identity.pid, 'SIGKILL');
          for (const member of tree) {
            if (member.pid === identity.pid || !sameProcess(member)) continue;
            try {
              process.kill(member.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
          await untilRecorded(
            () => tree.every((member) => !sameProcess(member)) && processGroupMembers(identity.group).length === 0,
          );
        });
      } finally {
        await stopFixtureCheck(id, root);
      }
    }),
  );
}

test('worker-check --wait reruns once when the runner is gone but its result still says running', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-dead-runner-'));
  dirs.push(root);
  await withRecoveryRunner(root, 0, async ({ id, log }, interrupt) => {
    await interrupt();
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 5_000, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(0);
    expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
    expect(out.join('')).toContain(`infrastructure failure (runner process exited) on ${hostname()}`);
    expect(out.join('')).toContain('check: exit status 0');
    const result = JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'));
    expect(result.reruns).toBe(1);
    expect(result.infrastructureFailure).toContain(`old log ${log}`);
  });
});

test('a lost wrapper waits on its exact remote reservation without starting a replacement check', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-retained-pending-'));
  dirs.push(root);
  const { id, physicalRunId } = await writeLostRemoteCheck(root, 'pending');
  const out: string[] = [];
  expect(await waitWorkerCheck(id, root, 30, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(75);
  expect(out.join('')).toContain('owned remote run remains pending');
  expect(readWorkerCheckRecord(id, root).status).toBe('running');
  expect(readWorkerCheckHistory(id, physicalRunId, root)?.status).toBe('running');
  expect(readFileSync(remoteRunCustodyPath(root, physicalRunId), 'utf8')).toContain('reservation-pending');
  expect(existsSync(join(root, 'rerun-marker'))).toBe(false);
});

test('a retained terminal result survives host move and duplicate wake without another physical run', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-retained-terminal-'));
  dirs.push(root);
  const { id, physicalRunId } = await writeLostRemoteCheck(root, 'terminal');
  expect(readWorkerCheckHistory(id, physicalRunId, root)?.status).toBe('finished');
  const first: string[] = [];
  expect(await waitWorkerCheck(id, root, 100, { pollMs: 5, write: (chunk) => first.push(chunk) })).toBe(0);
  const record = readWorkerCheckRecord(id, root);
  expect(record.status).toBe('finished');
  expect(record.physicalRun).toMatchObject({ host: 'check-b', run: 'reservation-terminal', exitCode: 0 });
  expect(readWorkerCheckHistory(id, physicalRunId, root)?.terminalProof).toMatchObject({
    local: true,
    remote: true,
    resultKnown: true,
  });
  expect(await waitWorkerCheck(id, root, 0, { write: () => {} })).toBe(0);
  expect(readWorkerCheckRecord(id, root).physicalRun).toEqual(record.physicalRun);
  expect(record.reruns).toBeUndefined();
  expect(existsSync(join(root, 'rerun-marker'))).toBe(false);
});

test('missing, empty or mismatched physical identity keeps a lost remote check unknown', async () => {
  for (const state of ['missing', 'empty', 'mismatched'] as const) {
    const root = mkdtempSync(join(suiteRoot, `worker-check-retained-${state}-`));
    dirs.push(root);
    const { id, physicalRunId } = await writeLostRemoteCheck(root, state);
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 100, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(75);
    expect(out.join('')).toContain('physical custody is unknown');
    expect(readWorkerCheckRecord(id, root).status).toBe('running');
    expect(readWorkerCheckHistory(id, physicalRunId, root)?.status).toBe('running');
    expect(existsSync(join(root, 'rerun-marker'))).toBe(false);
  }
});

test('a check whose log has been silent for 10 minutes is stopped and rerun once with host and log reported', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-stalled-runner-'));
  dirs.push(root);
  await withRecoveryRunner(root, 0, async ({ id, log, runnerHost, runnerIdentity, physicalRunId }) => {
    const stale = new Date(Date.now() - 25);
    utimesSync(join(root, log), stale, stale);
    const out: string[] = [];
    expect(
      await waitWorkerCheck(id, root, 5_000, {
        pollMs: 5,
        stallMs: 10,
        rerunStallMs: 1_000,
        write: (chunk) => out.push(chunk),
      }),
    ).toBe(0);
    expect(readFileSync(join(root, 'rerun-marker'), 'utf8')).toBe('rerun\n');
    expect(out.join('')).toContain(`infrastructure failure (log did not grow for 10 ms) on ${runnerHost}`);
    expect(out.join('')).toContain('check: exit status 0');
    expect(out.join('')).toContain('log .temp/goal/checks/worker-check-');
    expect(readWorkerCheckRecord(id, root).reruns).toBe(1);
    expect(readWorkerCheckHistory(id, physicalRunId!, root)?.terminalProof).toMatchObject({
      local: true,
      resultKnown: true,
    });
    expect(sameProcess(runnerIdentity!)).toBe(false);
    expect(processGroupMembers(runnerIdentity!.group)).toEqual([]);
  });
});

test('a second interrupted runner finishes as infrastructure failure without a third run', async () => {
  const root = mkdtempSync(join(suiteRoot, 'worker-check-second-runner-'));
  dirs.push(root);
  await withRecoveryRunner(root, 1, async ({ id }, interrupt) => {
    await interrupt();
    const out: string[] = [];
    expect(await waitWorkerCheck(id, root, 100, { pollMs: 5, write: (chunk) => out.push(chunk) })).toBe(1);
    expect(() => readFileSync(join(root, 'rerun-marker'), 'utf8')).toThrow();
    expect(out.join('')).toContain('second runner failed');
    expect(out.join('')).toContain('check: exit status 1');
    expect(
      JSON.parse(readFileSync(join(root, '.temp/goal/checks/results', `${id}.json`), 'utf8'))
        .infrastructureFailureFinal,
    ).toBe(true);
  });
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
  const initialized = spawnSync('git', ['init', '-q', '--separate-git-dir', join(root, '.fixture-git'), root], {
    cwd: root,
    encoding: 'utf8',
  });
  if (initialized.status !== 0) throw new Error(initialized.stderr || 'could not initialize placement fixture');
  const remoteEvents = join(root, 'remote-events');
  const remoteArgs = join(root, 'remote-args.json');
  const localMarker = join(root, 'local-marker');
  writeFileSync(
    join(scripts, 'remote-check.ts'),
    `import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { requestExecutionCancellation } from ${JSON.stringify(join(repository, 'scripts/remote-check.ts'))};
appendFileSync(process.env.WORKER_REMOTE_EVENTS!, 'remote\\n');
appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.args', JSON.stringify(process.argv.slice(2)));
const custodyFile = process.env.REZICS_CHECK_REMOTE_CUSTODY_FILE;
if (custodyFile) {
  if (!existsSync(custodyFile)) throw new Error('remote reservation was not persisted before command dispatch');
  const custody = JSON.parse(readFileSync(custodyFile, 'utf8'));
  if (custody.status !== 'running' || custody.physicalRunId !== process.env.REZICS_CHECK_PHYSICAL_RUN_ID || custody.binding?.checkId !== process.env.REZICS_CHECK_REMOTE_CUSTODY_ID || custody.attempts.length !== 0)
    throw new Error('remote reservation binding was not initialized for this physical check');
  appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.custody-start', JSON.stringify(custody.binding));
}
const markRemoteTerminal = (started = false, exitCode = 0) => {
  const file = process.env.REZICS_CHECK_REMOTE_CUSTODY_FILE;
  const physicalRunId = process.env.REZICS_CHECK_PHYSICAL_RUN_ID;
  if (!file || !physicalRunId) return;
  const custody = JSON.parse(readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  const native = { schema: 1, host: 'check-a', run: 'fixture-run', exitCode, lifetimeFailure: null, resources: null };
  const settlement = { schema: 1, host: 'check-a', run: 'fixture-run', native, preparedInputs: null, returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] }, cleanup: { schema: 1, host: 'check-a', run: 'fixture-run', status: 'verified', supervisorStopped: true, commandGroupTerminal: true, containersRemoved: true, runDirectoryRemoved: true, failures: [] }, transportChildReaped: true };
  const attempts = [{ host: 'check-a', id: 'fixture-run', status: started ? 'terminal' : 'not-started', startedAt: now, endedAt: now, ...(started ? { native, settlement, cleanup: settlement.cleanup } : {}) }];
  writeFileSync(file, JSON.stringify({ ...custody, status: 'terminal', attempts, updatedAt: now }));
};
writeFileSync(process.env.WORKER_REMOTE_ARGS!, JSON.stringify(Bun.argv.slice(2)));
if (process.env.WORKER_REMOTE_PROFILE_OUTPUT) {
  mkdirSync(dirname(process.env.WORKER_REMOTE_PROFILE_OUTPUT), { recursive: true });
  writeFileSync(process.env.WORKER_REMOTE_PROFILE_OUTPUT, 'remote growth\\n');
}
if (process.env.WORKER_REMOTE_MODE === 'transport') {
  markRemoteTerminal();
  writeFileSync(3, JSON.stringify({ nonce: process.env.REMOTE_CHECK_RECEIPT_NONCE, transportFailure:{schema:1,message:'remote-check: connection to host failed during rsync before a result'} })+'\\n');
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  process.exit(75);
}
if (process.env.WORKER_REMOTE_MODE === 'cancel-transport') {
  requestExecutionCancellation({ file: process.env.REMOTE_CHECK_CANCELLATION_FILE!, id: process.env.REMOTE_CHECK_CANCELLATION_ID! });
  markRemoteTerminal();
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
const mode = process.env.WORKER_REMOTE_MODE;
if (mode === 'artifact') {
  const launcherArgs = process.argv.slice(2);
  const separator = launcherArgs.lastIndexOf('--');
  if (separator < 0) process.exit(92);
  const physicalRunId = process.env.REZICS_CHECK_PHYSICAL_RUN_ID!;
  const relativeStage = process.env.REZICS_CHECK_ARTIFACTS_DIR ?? launcherArgs.find(value => value.startsWith('REZICS_CHECK_ARTIFACTS_DIR='))?.slice('REZICS_CHECK_ARTIFACTS_DIR='.length);
  const remoteRoot = process.env.WORKER_ARTIFACT_REMOTE_BASE! + '/run-' + physicalRunId;
  mkdirSync(remoteRoot, { recursive: true });
  symlinkSync(${JSON.stringify(join(repository, 'scripts'))}, remoteRoot + '/scripts', 'dir');
  const artifactModule = await import(${JSON.stringify(join(repository, 'scripts/check-artifacts.ts'))});
  artifactModule.prepareArtifactRun(remoteRoot, physicalRunId);
  const command = Bun.spawn(launcherArgs.slice(separator + 1), {
    cwd: remoteRoot,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await command.exited;
  const remoteStage = remoteRoot + '/' + relativeStage;
  const localStage = process.cwd() + '/' + relativeStage;
  rmSync(localStage, { recursive: true, force: true });
  cpSync(remoteStage, localStage, { recursive: true });
  rmSync(remoteRoot, { recursive: true, force: true });
  appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.artifact-cleanup', 'removed\\n');
  markRemoteTerminal(true, code);
  process.exit(code);
}
const waitForRelease = async () => {
  appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.waiting', 'waiting\\n');
  const started = performance.now();
  while (!existsSync(process.env.WORKER_REMOTE_RELEASE!)) await Bun.sleep(5);
  console.error('remote-check: slot wait ' + ((performance.now() - started) / 1000).toFixed(3) + ' s on check-a');
};
if (mode === 'admission' || mode === 'transport-admission' || mode === 'telemetry') await waitForRelease();
if (mode === 'cancel-admission') {
  appendFileSync(process.env.WORKER_REMOTE_EVENTS! + '.waiting', 'waiting\\n');
  const started = performance.now();
  process.on('SIGTERM', () => {
    console.error('remote-check: slot wait ' + ((performance.now() - started) / 1000).toFixed(3) + ' s (cancelled)');
    process.exit(143);
  });
  await new Promise(() => {});
}
if (mode === 'transport-admission') {
  markRemoteTerminal();
  console.error('remote-check: connection to host failed during rsync before a result');
  console.error('remote-check: transport failure marker');
  await new Promise(resolve => process.stdout.write('x'.repeat(20_000) + '\\n', resolve));
  process.exit(75);
}
if (mode === 'telemetry') {
  process.stderr.write('remote-check: command phase compile 0.');
  await Bun.sleep(5);
  process.stderr.write('250 s\\n');
  console.error('remote-check: command 0.500 s on check-a');
  process.stdout.write('x'.repeat(20_000) + '\\n');
}
if (process.env.WORKER_REMOTE_MODE === 'failure') { markRemoteTerminal(true, 7); process.exit(7); }
if (process.env.WORKER_REMOTE_MODE === 'failure-75') { markRemoteTerminal(true, 75); process.exit(75); }
if (process.env.WORKER_REMOTE_MODE === 'queued') {
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
  console.error('remote-check: every check slot is busy; waiting for a free one (check-a 0/1 free)');
}
console.error('remote-check: run used 2.000 CPU seconds over 1.000 s (2.00 cores), peak memory 3072 MiB on check-a');
markRemoteTerminal(true);
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
      await withIsolatedTask(fixture.root, async () => {
        const id = startWorkerCheck(command, fixture.root);
        const recordFile = join(fixture.root, '.temp/goal/checks/results', `${id}.json`);
        try {
          expect(await waitWorkerCheck(id, fixture.root, 60_000), mode).toBe(124);
          const record = JSON.parse(readFileSync(recordFile, 'utf8'));
          expect(Boolean(record.infrastructureFailure), mode).toBe(mode === 'lifetime-channel');
          expect(existsSync(fixture.localMarker), mode).toBe(false);
          expect(readFileSync(fixture.remoteEvents, 'utf8'), mode).toBe('remote\n');
          if (mode === 'lifetime-channel')
            expect(record.physicalRun).toMatchObject({ host: 'check-a', run: 'fixture-physical', exitCode: 124 });
        } finally {
          await stopFixtureCheck(id, fixture.root);
        }
      });
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
  expect(await needsStack(['bun', 'run', '--cwd', 'apps/web', 'typecheck'])).toBe(false);
  expect(await needsStack(['bun', 'check', '--no-script', '-p', 'tsconfig.json'], join(repository, 'apps/web'))).toBe(
    false,
  );
  expect(await needsStack(['bun', 'check', '--no-script', '-p', 'packages/filter/tsconfig.json'])).toBe(false);
  expect(await needsStack(['tsc', '--noEmit', '-p', 'packages/filter/tsconfig.json'])).toBe(false);
});

test('stack-free placement: native kernel Auth Web isolated and real compiler-database routes retain stack placement', async () => {
  expect(await needsStack(['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/http/body-limit.test.ts'])).toBe(
    true,
  );
  expect(
    await needsStack(['bun', 'check', '--no-script', '-p', 'tsconfig.json'], join(repository, 'services/kernel')),
  ).toBe(true);
  expect(
    await needsStack(['bun', 'check', '--no-script', '-p', 'tsconfig.json'], join(repository, 'services/auth')),
  ).toBe(true);
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

test('worker-check CLI keeps canonical launch, explicit compatibility alias and detached physical resume unambiguous', async () => {
  const root = mkdtempSync(join(import.meta.dir, '../.temp/worker-check-cli-test-'));
  dirs.push(root);
  const old = { ...process.env };
  const cli = join(repository, 'scripts/worker-check.ts');
  const env = cleanTestEnvironment(process.env);
  env.REZICS_CHECK_MEMORY = 'off';
  env.REZICS_CHECK_SCOPE = 'off';
  const invoke = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
  const started = join(root, 'canonical.started');
  const release = join(root, 'canonical.release');
  const command = [
    process.execPath,
    '-e',
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));while(!fs.existsSync(${JSON.stringify(release)}))await Bun.sleep(5)`,
  ];
  try {
    const canonical = invoke(['--', ...command]);
    expect(canonical.status, canonical.stderr).toBe(0);
    const id = canonical.stdout.match(/check: id ([0-9a-f-]{36})/)?.[1];
    expect(id).toBeTruthy();
    const record = readWorkerCheckRecord(id!, root);
    expect(record.physicalRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.runnerIdentity?.pid).toBe(record.runnerPid);
    const cmdline = readFileSync(`/proc/${record.runnerPid}/cmdline`, 'utf8');
    expect(cmdline).toContain(`--run\0${id}\0--physical-run\0${record.physicalRunId}`);
    writeFileSync(release, 'release');
    expect(await waitWorkerCheck(id!, root, 5_000, { pollMs: 10 })).toBe(0);
    expect(existsSync(started)).toBe(true);
    expect(readWorkerCheckHistory(id!, record.physicalRunId!, root)?.status).toBe('finished');

    const aliasMarker = join(root, 'compatibility.started');
    const alias = invoke([
      '--run',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(aliasMarker)},'started')`,
    ]);
    expect(alias.status, alias.stderr).toBe(0);
    const aliasId = alias.stdout.match(/check: id ([0-9a-f-]{36})/)?.[1];
    expect(aliasId).toBeTruthy();
    expect(await waitWorkerCheck(aliasId!, root, 5_000, { pollMs: 10 })).toBe(0);
    expect(existsSync(aliasMarker)).toBe(true);

    const malformedMarker = join(root, 'malformed.must-not-run');
    const malformed = invoke(['--run', 'not-a-valid-id', '--', '/bin/sh', '-c', `touch ${malformedMarker}`]);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain('Invalid check id');
    expect(existsSync(malformedMarker)).toBe(false);

    const empty = invoke(['--run', '--']);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain('--run -- requires a command');
  } finally {
    writeFileSync(release, 'release');
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

test('remote custody accepts a bounded compiler capture argument and rejects an oversized argument', () => {
  const fixture = workerFixture();
  const checkId = randomUUID();
  const physicalRunId = randomUUID();
  const argv = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
  const remoteArgv = ['bun', '-e', 'x'.repeat(38_000)];
  const custodyFile = remoteRunCustodyPath(fixture.root, physicalRunId);

  initializeRemoteRunCustody(fixture.root, physicalRunId, { checkId, argv, remoteArgv });

  const custody = JSON.parse(readFileSync(custodyFile, 'utf8')) as {
    binding: { argv: string[]; remoteArgv: string[] };
  };
  expect(custody.binding).toEqual({ checkId, argv, remoteArgv });
  expect(Buffer.byteLength(JSON.stringify(custody))).toBeLessThan(64 * 1024);
  expect(() =>
    initializeRemoteRunCustody(fixture.root, randomUUID(), {
      checkId,
      argv,
      remoteArgv: ['bun', '-e', 'x'.repeat(48 * 1024 + 1)],
    }),
  ).toThrow('worker-check: invalid remote custody binding');
});

test('managed remote command starts only after its exact wrapper and physical custody is durable', async () => {
  const fixture = workerFixture();
  const hosts = writeHosts(fixture);
  const checkId = randomUUID();
  const physicalRunId = randomUUID();
  const ownership = { taskId: randomUUID(), attempt: 1 };
  const argv = ['bun', 'test', 'services/kernel/test/native-placement.test.ts'];
  const remoteArgv = ['env', `REZICS_CHECK_PHYSICAL_RUN_ID=${physicalRunId}`, ...argv];
  const custodyFile = remoteRunCustodyPath(fixture.root, physicalRunId);
  const commandStarted = join(fixture.root, 'remote-command-started');
  const old = { ...process.env };
  try {
    initializeRemoteRunCustody(fixture.root, physicalRunId, { checkId, ownership, argv, remoteArgv });
    process.env.REZICS_CHECK_REMOTE_CUSTODY_FILE = custodyFile;
    process.env.REZICS_CHECK_REMOTE_CUSTODY_ID = checkId;
    process.env.REZICS_CHECK_PHYSICAL_RUN_ID = physicalRunId;
    const callbacks = remoteCheckCustodyCallbacks(remoteArgv, [], hosts);
    expect(callbacks.allocated).toBeDefined();
    expect(callbacks.completed).toBeDefined();
    expect(callbacks.settled).toBeDefined();
    await callbacks.allocated!({ host: 'check-a', run: 'fixture-run' });

    const beforeCommand = JSON.parse(readFileSync(custodyFile, 'utf8'));
    expect(beforeCommand).toMatchObject({
      physicalRunId,
      binding: { checkId, ownership, argv, remoteArgv, hostsFile: hosts, returns: [] },
      status: 'running',
    });
    expect(beforeCommand.attempts).toHaveLength(1);
    expect(beforeCommand.attempts[0]).toMatchObject({ host: 'check-a', id: 'fixture-run', status: 'running' });
    expect(existsSync(commandStarted)).toBe(false);
    writeFileSync(commandStarted, 'started');
    expect(readFileSync(commandStarted, 'utf8')).toBe('started');

    const native: RemotePhysicalRunReceipt = {
      schema: 1,
      host: 'check-a',
      run: 'fixture-run',
      exitCode: 0,
      lifetimeFailure: null,
      resources: null,
    };
    const cleanup = {
      schema: 1 as const,
      host: 'check-a',
      run: 'fixture-run',
      status: 'verified' as const,
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    };
    const settlement: RemoteCheckSettlement = {
      schema: 1,
      host: 'check-a',
      run: 'fixture-run',
      native,
      preparedInputs: null,
      returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] },
      cleanup,
      transportChildReaped: true,
    };
    await callbacks.completed!(native);
    await callbacks.settled!(settlement);
    const terminal = JSON.parse(readFileSync(custodyFile, 'utf8'));
    expect(terminal).toMatchObject({
      status: 'terminal',
      attempts: [{ status: 'terminal', native, settlement, cleanup }],
    });
  } finally {
    restoreWorkerEnvironment(old);
  }
});

type NativeWorker = {
  pid: number;
  child: ReturnType<typeof spawn>;
  output: () => string;
  wait: () => Promise<number>;
  stop: () => void;
};

function startNativeWorker(
  fixture: ReturnType<typeof workerFixture>,
  argv: string[],
  env: Record<string, string | undefined>,
  logicalCheckId?: string,
): NativeWorker {
  const driver = `import { runWorkerCheck } from ${JSON.stringify(join(repository, 'scripts/worker-check.ts'))};
try { process.exitCode = await runWorkerCheck(JSON.parse(process.env.PLACEMENT_ARGV!), ${JSON.stringify(fixture.root)}, false, undefined, 60_000, process.env.PLACEMENT_LOGICAL_ID); }
catch (error) { console.error(error); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ['--eval', driver], {
    cwd: fixture.root,
    env: {
      ...env,
      PLACEMENT_ARGV: JSON.stringify(argv),
      ...(logicalCheckId ? { PLACEMENT_LOGICAL_ID: logicalCheckId } : {}),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const wait = new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const signals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
      resolveExit(code ?? 128 + (signal ? (signals[signal] ?? 1) : 1));
    });
  });
  return {
    pid: child.pid!,
    child,
    output: () => output,
    wait: () => wait,
    stop: () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    },
  };
}

function placementEnvironment(
  fixture: ReturnType<typeof workerFixture>,
  hostsPath?: string,
  mode = 'success',
): Record<string, string | undefined> {
  const env = cleanTestEnvironment(process.env);
  env.REZICS_CHECK_LEDGER_DIR = join(fixture.root, '.temp/check-ledger');
  for (const key of ['GOAL_TASK_ID', 'REMOTE_CHECK_PRIORITY', 'GOAL_CHECK_WAIT_FILE']) delete env[key];
  env.REZICS_CHECK_MEMORY = 'on';
  env.REZICS_CHECK_MEMORY_DIR = fixture.memory;
  env.REZICS_CHECK_MEMORY_GIB = '4';
  env.REZICS_CHECK_SCOPE = 'off';
  env.WORKER_REMOTE_EVENTS = fixture.remoteEvents;
  env.WORKER_REMOTE_ARGS = fixture.remoteArgs;
  env.WORKER_REMOTE_MODE = mode;
  if (hostsPath === undefined) delete env.KERNEL_CHECK_REMOTE;
  else env.KERNEL_CHECK_REMOTE = hostsPath;
  return env;
}

function writeHosts(fixture: ReturnType<typeof workerFixture>): string {
  const hosts = join(fixture.root, 'hosts.json');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'check-a',
          address: 'ops@check-a.test',
          identity: '/unused',
          memoryMaxGiB: 8,
          cpuQuotaPercent: 800,
          slots: 2,
        },
      ],
    }),
  );
  return hosts;
}

function writeSharedHosts(fixture: ReturnType<typeof workerFixture>, hosts: string): void {
  const shared = join(fixture.root, '.temp/goal/remote-check-hosts.json');
  mkdirSync(join(fixture.root, '.temp/goal'), { recursive: true });
  copyFileSync(hosts, shared);
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}

async function boundedWorkerExit(worker: NativeWorker, timeoutMs = 10_000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      worker.wait(),
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`worker process ${worker.pid} did not exit within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lockedSlots(directory: string, capacity: number): number[] {
  const locked: number[] = [];
  for (let index = 1; index <= capacity; index++) {
    const file = join(directory, `slot-${index}.lock`);
    const result = spawnSync('flock', ['-n', '-E', '75', file, 'true'], { encoding: 'utf8', timeout: 2_000 });
    if (result.status === 75) locked.push(index);
    else if (result.status !== 0) throw new Error(result.stderr || `flock could not inspect ${file}`);
  }
  return locked;
}

function latestLedgerEntries(root: string): any[] {
  const directory = join(root, '.temp/check-ledger');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((day) =>
    readdirSync(join(directory, day))
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(directory, day, file), 'utf8'))),
  );
}

test('stack-free placement: the actual Web compiler invocation runs locally with memory admission and its native result', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const hosts = writeHosts(fixture);
  const web = join(fixture.root, 'apps/web');
  const priorLedger = process.env.REZICS_CHECK_LEDGER_DIR;
  const compilerCommand = resolveRepositoryBun(['bun', 'check', '--no-script', '-p', 'tsconfig.json'], repository);
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: '@fixture/web', private: true, type: 'module' }));
  writeFileSync(
    join(web, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ['source.ts'] }),
  );
  writeFileSync(join(web, 'source.ts'), "export const compilerResult: string = 'checked locally';\n");
  try {
    workerEnv(fixture, hosts);
    process.env.REZICS_CHECK_LEDGER_DIR = join(fixture.root, '.temp/check-ledger');
    const log = join(fixture.root, 'web-compiler.log');
    const status = await runWorkerCheck(compilerCommand, web, false, log);
    if (status !== 0) throw new Error(`Web compiler exited ${status}:\n${readFileSync(log, 'utf8')}`);
    expect(existsSync(fixture.remoteEvents)).toBe(false);
    expect(latestLedgerEntries(fixture.root)).toMatchObject([
      { host: hostname(), terminalStatus: 'passed', exitStatus: 0 },
    ]);
  } finally {
    restoreWorkerEnvironment(old);
    if (priorLedger === undefined) delete process.env.REZICS_CHECK_LEDGER_DIR;
    else process.env.REZICS_CHECK_LEDGER_DIR = priorLedger;
  }
});

test('bounded artifact returns: the real outer wrapper restores inner stack-run bytes before fake remote cleanup', async () => {
  const fixture = workerFixture();
  const old = { ...process.env };
  const hosts = writeHosts(fixture);
  const paths = ['browser captures/frame #1.png', 'browser captures/trace.bin'];
  const expected = [Buffer.from([137, 80, 78, 71, 0, 255, 1]), Buffer.from([0, 3, 0, 4, 254])];
  const logicalCheckId = randomUUID();
  const remoteBase = join(fixture.root, '.temp/fake-check-host');
  const inner = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { stackRun } from ${JSON.stringify(join(repository, 'scripts/stack-run.ts'))};
    const root = process.cwd();
    const paths = JSON.parse(process.env.WORKER_ARTIFACT_PATHS!);
    const code = await stackRun({
      label: 'nested artifact fixture',
      root,
      cwd: ${JSON.stringify(join(repository, 'runs/nested-artifact-fixture'))},
      command: ['true'],
      returns: paths,
    }, async () => {
      if (process.env.WORKER_ARTIFACT_WRITE === '1') {
        for (let index = 0; index < paths.length; index += 1) {
          const output = join(root, paths[index]);
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, Buffer.from(JSON.parse(process.env.WORKER_ARTIFACT_BYTES!)[index]));
        }
      }
      return Number(process.env.WORKER_ARTIFACT_EXIT ?? 0);
    }, process.env);
    process.exitCode = code;
  `;
  const command = ['bun', '-e', inner];
  const commandClass = checkClass(command, fixture.root);
  for (let sample = 0; sample < 3; sample += 1) recordPeak(fixture.memory, commandClass, 2 * 2 ** 30);
  try {
    Object.assign(process.env, placementEnvironment(fixture, hosts, 'artifact'));
    process.env.WORKER_REMOTE_MODE = 'artifact';
    process.env.WORKER_ARTIFACT_REMOTE_BASE = remoteBase;
    process.env.WORKER_ARTIFACT_PATHS = JSON.stringify(paths);
    process.env.WORKER_ARTIFACT_BYTES = JSON.stringify(expected.map((bytes) => [...bytes]));
    process.env.WORKER_ARTIFACT_WRITE = '1';
    const firstPhysicalRun = randomUUID();
    const firstCode = await runWorkerCheck(
      ['--returns', paths[0]!, '--returns', paths[1]!, ...command],
      fixture.root,
      false,
      undefined,
      60_000,
      logicalCheckId,
      0,
      undefined,
      true,
      firstPhysicalRun,
    );
    expect(firstCode).toBe(0);
    expect(readFileSync(join(fixture.root, paths[0]!))).toEqual(expected[0]!);
    expect(readFileSync(join(fixture.root, paths[1]!))).toEqual(expected[1]!);
    expect(existsSync(join(remoteBase, `run-${firstPhysicalRun}`))).toBe(false);
    expect(existsSync(join(fixture.root, '.temp/goal/checks/artifact-returns', firstPhysicalRun))).toBe(false);
    expect(readFileSync(fixture.remoteEvents + '.artifact-cleanup', 'utf8')).toContain('removed');

    process.env.WORKER_ARTIFACT_WRITE = '0';
    const missingPhysicalRun = randomUUID();
    expect(
      await runWorkerCheck(
        ['--returns', paths[0]!, '--returns', paths[1]!, ...command],
        fixture.root,
        false,
        undefined,
        60_000,
        logicalCheckId,
        0,
        undefined,
        true,
        missingPhysicalRun,
      ),
    ).toBe(0);
    expect(() => readFileSync(join(fixture.root, paths[0]!))).toThrow();
    expect(() => readFileSync(join(fixture.root, paths[1]!))).toThrow();
    expect(existsSync(join(remoteBase, `run-${missingPhysicalRun}`))).toBe(false);

    process.env.WORKER_ARTIFACT_WRITE = '1';
    process.env.WORKER_ARTIFACT_EXIT = '7';
    const failedPhysicalRun = randomUUID();
    expect(
      await runWorkerCheck(
        ['--returns', paths[0]!, '--returns', paths[1]!, ...command],
        fixture.root,
        false,
        undefined,
        60_000,
        logicalCheckId,
        0,
        undefined,
        true,
        failedPhysicalRun,
      ),
    ).toBe(7);
    expect(readFileSync(join(fixture.root, paths[0]!))).toEqual(expected[0]!);
    expect(readFileSync(join(fixture.root, paths[1]!))).toEqual(expected[1]!);
    expect(existsSync(join(remoteBase, `run-${failedPhysicalRun}`))).toBe(false);
  } finally {
    restoreWorkerEnvironment(old);
    for (const key of [
      'WORKER_ARTIFACT_REMOTE_BASE',
      'WORKER_ARTIFACT_PATHS',
      'WORKER_ARTIFACT_BYTES',
      'WORKER_ARTIFACT_WRITE',
      'WORKER_ARTIFACT_EXIT',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key]!;
    }
  }
});

test('placement memory: a remotely queued check holds zero local check-memory slots, including shared default hosts discovery and env-prefixed commands', async () => {
  for (const mode of ['shared-default', 'env-prefixed'] as const) {
    const fixture = workerFixture();
    const hosts = writeHosts(fixture);
    writeSharedHosts(fixture, hosts);
    const remoteRelease = join(fixture.root, 'remote.release');
    const localStarted = join(fixture.root, `local-${mode}.started`);
    const localRelease = join(fixture.root, `local-${mode}.release`);
    const local = [
      process.execPath,
      '-e',
      `(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(localStarted)},'started');while(!fs.existsSync(${JSON.stringify(localRelease)}))await Bun.sleep(5)})()`,
    ];
    const commandClass = checkClass(local, fixture.root);
    for (let count = 0; count < 3; count++) recordPeak(fixture.memory, commandClass, 4 * 2 ** 30);
    const env = placementEnvironment(fixture, undefined, 'admission');
    env.WORKER_REMOTE_RELEASE = remoteRelease;
    const argv = mode === 'env-prefixed' ? ['env', '-u', 'KERNEL_RATING_COUNTER_SECRET', ...local] : local;
    const waiting = startNativeWorker(fixture, argv, env);
    try {
      await waitUntil(
        () => existsSync(fixture.remoteEvents + '.waiting') || existsSync(localStarted),
        `worker ${mode} neither reached remote admission nor started its local command`,
      );
      if (existsSync(localStarted)) expect(lockedSlots(fixture.memory, 4)).toEqual([1, 2, 3, 4]);
      expect(existsSync(fixture.remoteEvents + '.waiting'), `worker ${mode} must use remote admission`).toBe(true);
      expect(lockedSlots(fixture.memory, 4)).toEqual([]);
      if (mode === 'env-prefixed') {
        const dispatched = JSON.parse(readFileSync(fixture.remoteArgs, 'utf8')) as string[];
        expect(dispatched.slice(dispatched.indexOf('--') + 1)).toEqual(argv);
      }

      const localProgress = join(fixture.root, `local-progress-${mode}`);
      const progress = startNativeWorker(
        fixture,
        [
          '--local',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(localProgress)}, 'ran')`,
        ],
        env,
      );
      try {
        expect(await boundedWorkerExit(progress)).toBe(0);
        expect(readFileSync(localProgress, 'utf8')).toBe('ran');
        expect(lockedSlots(fixture.memory, 4)).toEqual([]);
      } finally {
        progress.stop();
      }
    } finally {
      writeFileSync(remoteRelease, 'release');
      writeFileSync(localRelease, 'release');
      try {
        expect(await boundedWorkerExit(waiting)).toBe(0);
      } finally {
        waiting.stop();
      }
    }
  }
});

test('placement memory: a local execution is admitted under its measured local memory weight, and genuine remote-to-local fallback acquires that lease only before local execution', async () => {
  const localFixture = workerFixture();
  const localStarted = join(localFixture.root, 'weighted-local.started');
  const localRelease = join(localFixture.root, 'weighted-local.release');
  const localCommand = [
    process.execPath,
    '-e',
    `(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(localStarted)},'started');while(!fs.existsSync(${JSON.stringify(localRelease)}))await Bun.sleep(5)})()`,
  ];
  const weightClass = checkClass(localCommand, localFixture.root);
  for (let count = 0; count < 3; count++) recordPeak(localFixture.memory, weightClass, 2.1 * 2 ** 30);
  const localEnv = placementEnvironment(localFixture, undefined);
  localEnv.REZICS_CHECK_MEMORY_GIB = '4';
  const holder = await acquireStackSlot(
    'placement memory holder',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: localFixture.memory,
    },
    2,
  );
  const weighted = startNativeWorker(localFixture, ['--local', ...localCommand], localEnv);
  try {
    await waitUntil(
      () => readdirSync(localFixture.memory).some((name) => name.startsWith('ticket-')),
      'weighted local execution did not enter memory admission',
    );
    expect(existsSync(localStarted)).toBe(false);
    await holder.release();
    await waitUntil(() => existsSync(localStarted), 'weighted local command did not start after admission released');
    expect(lockedSlots(localFixture.memory, 4)).toHaveLength(3);
  } finally {
    await holder.release();
    writeFileSync(localRelease, 'release');
    try {
      expect(await boundedWorkerExit(weighted)).toBe(0);
    } finally {
      weighted.stop();
    }
  }

  const fallbackFixture = workerFixture();
  const hosts = writeHosts(fallbackFixture);
  const remoteRelease = join(fallbackFixture.root, 'transport.release');
  const localStart = join(fallbackFixture.root, 'fallback.local.started');
  const localDone = join(fallbackFixture.root, 'fallback.local.done');
  const fallbackCommand = [
    process.execPath,
    '-e',
    `(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(localStart)},'started');while(!fs.existsSync(${JSON.stringify(localDone)}))await Bun.sleep(5)})()`,
  ];
  const fallbackClass = checkClass(fallbackCommand, fallbackFixture.root);
  for (let count = 0; count < 3; count++) recordPeak(fallbackFixture.memory, fallbackClass, 4 * 2 ** 30);
  const fallbackEnv = placementEnvironment(fallbackFixture, hosts, 'transport-admission');
  fallbackEnv.WORKER_REMOTE_RELEASE = remoteRelease;
  const blocker = await acquireStackSlot(
    'placement memory fallback blocker',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: fallbackFixture.memory,
    },
    4,
  );
  const fallback = startNativeWorker(fallbackFixture, fallbackCommand, fallbackEnv, 'fallback-logical');
  try {
    await waitUntil(
      () => existsSync(fallbackFixture.remoteEvents + '.waiting'),
      'remote attempt did not reach admission',
    );
    expect(lockedSlots(fallbackFixture.memory, 4)).toEqual([1, 2, 3, 4]);
    expect(existsSync(localStart)).toBe(false);
    writeFileSync(remoteRelease, 'release');
    await waitUntil(
      () => readdirSync(fallbackFixture.memory).filter((name) => name.startsWith('ticket-')).length > 0,
      'local fallback did not request memory admission after transport failure',
    );
    expect(existsSync(localStart)).toBe(false);
    await blocker.release();
    await waitUntil(() => existsSync(localStart), 'local fallback did not start after admission');
    expect(lockedSlots(fallbackFixture.memory, 4)).toHaveLength(4);
  } finally {
    await blocker.release();
    writeFileSync(localDone, 'done');
    writeFileSync(remoteRelease, 'release');
    try {
      expect(await boundedWorkerExit(fallback)).toBe(0);
    } finally {
      fallback.stop();
    }
  }
  const records = latestLedgerEntries(fallbackFixture.root);
  expect(records).toHaveLength(2);
  expect(new Set(records.map((entry) => entry.runId)).size).toBe(2);
  expect(records.map((entry) => entry.logicalCheckId)).toEqual(['fallback-logical', 'fallback-logical']);
  expect(records.find((entry) => entry.host === 'remote')?.slotWaitSeconds).toBeGreaterThan(0);
  expect(records.find((entry) => entry.host !== 'remote')?.slotWaitSeconds).toBeGreaterThan(0);
  expect(records.find((entry) => entry.host !== 'remote')?.phases.command).toBeGreaterThan(0);
}, 30_000);

test('placement memory: actual local and remote admission waits are nonzero in the physical ledger and remain separate from command execution, including long output, cancellation and fallback', async () => {
  const remoteFixture = workerFixture();
  const hosts = writeHosts(remoteFixture);
  const remoteRelease = join(remoteFixture.root, 'telemetry.release');
  const remoteEnv = placementEnvironment(remoteFixture, hosts, 'telemetry');
  remoteEnv.WORKER_REMOTE_RELEASE = remoteRelease;
  const heavyCommand = localCommand(remoteFixture.localMarker);
  const remoteClass = checkClass(heavyCommand, remoteFixture.root);
  for (let count = 0; count < 3; count++) recordPeak(remoteFixture.memory, remoteClass, 4 * 2 ** 30);
  const remote = startNativeWorker(remoteFixture, heavyCommand, remoteEnv, 'remote-wait');
  try {
    await waitUntil(
      () => existsSync(remoteFixture.remoteEvents + '.waiting'),
      'remote telemetry fixture did not queue',
    );
    await Bun.sleep(100);
    writeFileSync(remoteRelease, 'release');
    expect(await boundedWorkerExit(remote)).toBe(0);
  } finally {
    writeFileSync(remoteRelease, 'release');
    remote.stop();
  }
  const remoteRecords = latestLedgerEntries(remoteFixture.root);
  expect(remoteRecords).toHaveLength(1);
  expect(remoteRecords[0].slotWaitSeconds).toBeGreaterThan(0);
  expect(remoteRecords[0].phases.command).toBe(0.5);
  expect(remoteRecords[0].commandPhases.compile).toBe(0.25);
  expect(remoteRecords[0].phases.wrapperTotal).toBeGreaterThanOrEqual(remoteRecords[0].phases.command);

  const localFixture = workerFixture();
  const localStart = join(localFixture.root, 'local-wait.started');
  const localDone = join(localFixture.root, 'local-wait.done');
  const localEnv = placementEnvironment(localFixture);
  const localWaitCommand = [
    process.execPath,
    '-e',
    `(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(localStart)},'started');while(!fs.existsSync(${JSON.stringify(localDone)}))await Bun.sleep(5)})()`,
  ];
  const localHolder = await acquireStackSlot(
    'placement memory local wait holder',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: localFixture.memory,
    },
    4,
  );
  const local = startNativeWorker(localFixture, ['--local', ...localWaitCommand], localEnv, 'local-wait');
  try {
    await waitUntil(
      () => readdirSync(localFixture.memory).some((name) => name.startsWith('ticket-')),
      'local execution did not enter memory admission',
    );
    expect(existsSync(localStart)).toBe(false);
    await Bun.sleep(100);
    await localHolder.release();
    await waitUntil(() => existsSync(localStart), 'local execution did not start after memory admission');
    expect(lockedSlots(localFixture.memory, 4)).toEqual([1, 2, 3, 4]);
    writeFileSync(localDone, 'done');
    expect(await boundedWorkerExit(local)).toBe(0);
  } finally {
    await localHolder.release();
    writeFileSync(localDone, 'done');
    local.stop();
  }
  const localRecords = latestLedgerEntries(localFixture.root);
  expect(localRecords).toHaveLength(1);
  expect(localRecords[0].slotWaitSeconds).toBeGreaterThan(0);
  expect(localRecords[0].phases.command).toBeGreaterThan(0);
  expect(localRecords[0].phases.wrapperTotal).toBeGreaterThanOrEqual(localRecords[0].phases.command);

  const cancelledFixture = workerFixture();
  const cancelHosts = writeHosts(cancelledFixture);
  const cancelledEnv = placementEnvironment(cancelledFixture, cancelHosts, 'cancel-admission');
  const cancelCommand = localCommand(cancelledFixture.localMarker);
  const cancelClass = checkClass(cancelCommand, cancelledFixture.root);
  for (let count = 0; count < 3; count++) recordPeak(cancelledFixture.memory, cancelClass, 4 * 2 ** 30);
  const cancelled = startNativeWorker(cancelledFixture, cancelCommand, cancelledEnv, 'cancel-wait');
  try {
    await waitUntil(
      () => existsSync(cancelledFixture.remoteEvents + '.waiting'),
      'remote cancellation fixture did not queue',
    );
    await Bun.sleep(100);
    cancelled.child.kill('SIGTERM');
    expect(await boundedWorkerExit(cancelled)).toBe(143);
  } finally {
    cancelled.stop();
  }
  const cancelledRecord = latestLedgerEntries(cancelledFixture.root)[0];
  expect(cancelledRecord.terminalStatus).toBe('failed');
  expect(cancelledRecord.exitStatus).toBe(143);
  expect(cancelledRecord.slotWaitSeconds).toBeGreaterThan(0);
  expect(lockedSlots(cancelledFixture.memory, 4)).toEqual([]);
});

test('placement memory: signals, transport failure and spawn failure release only owned leases and preserve inherited ownership, check results and one-rerun rules', async () => {
  const fixture = workerFixture();
  const env = placementEnvironment(fixture);
  const holder = await acquireStackSlot('placement memory inherited holder', {
    REZICS_STACK_SLOTS: '4',
    REZICS_STACK_LEASE_DIR: fixture.memory,
  });
  const inheritedEnv = { ...env, REZICS_CHECK_MEMORY_LEASE: holder.env.REZICS_STACK_SLOT };
  const inherited = startNativeWorker(
    fixture,
    [
      '--local',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(fixture.localMarker)}, process.env.REZICS_CHECK_MEMORY_LEASE)`,
    ],
    inheritedEnv,
  );
  try {
    expect(await boundedWorkerExit(inherited)).toBe(0);
    expect(readFileSync(fixture.localMarker, 'utf8')).toBe(holder.env.REZICS_STACK_SLOT!);
    expect(lockedSlots(fixture.memory, 4)).toEqual([Number(holder.env.REZICS_STACK_SLOT!.split('/')[0])]);
  } finally {
    await holder.release();
    inherited.stop();
  }
  expect(lockedSlots(fixture.memory, 4)).toEqual([]);

  const waitingFixture = workerFixture();
  const waitingEnv = placementEnvironment(waitingFixture);
  const waitingMarker = join(waitingFixture.root, 'cancelled-local-wait.started');
  const waitingCommand = localCommand(waitingMarker);
  const waitingHolder = await acquireStackSlot(
    'placement memory local cancellation holder',
    {
      REZICS_STACK_SLOTS: '4',
      REZICS_STACK_LEASE_DIR: waitingFixture.memory,
    },
    4,
  );
  const waitingWorker = startNativeWorker(waitingFixture, ['--local', ...waitingCommand], waitingEnv, 'local-cancel');
  try {
    await waitUntil(
      () => readdirSync(waitingFixture.memory).some((name) => name.startsWith('ticket-')),
      'local cancellation did not reach memory admission',
    );
    await Bun.sleep(100);
    waitingWorker.child.kill('SIGTERM');
    expect(await boundedWorkerExit(waitingWorker)).toBe(143);
    expect(existsSync(waitingMarker)).toBe(false);
    expect(lockedSlots(waitingFixture.memory, 4)).toEqual([1, 2, 3, 4]);
    const cancelled = latestLedgerEntries(waitingFixture.root)[0];
    expect(cancelled.terminalStatus).toBe('failed');
    expect(cancelled.exitStatus).toBe(143);
    expect(cancelled.slotWaitSeconds).toBeGreaterThan(0);
  } finally {
    await waitingHolder.release();
    waitingWorker.stop();
  }
  expect(lockedSlots(waitingFixture.memory, 4)).toEqual([]);

  const signalFixture = workerFixture();
  const signalEnv = placementEnvironment(signalFixture);
  const started = join(signalFixture.root, 'signal.started');
  const signalCommand = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');process.on('SIGTERM',()=>process.exit(143));setInterval(()=>{},1000)`,
  ];
  const signalRun = startNativeWorker(signalFixture, ['--local', ...signalCommand], signalEnv);
  try {
    await waitUntil(() => existsSync(started), 'local signal command did not start');
    expect(lockedSlots(signalFixture.memory, 4)).toEqual([1, 2, 3, 4]);
    signalRun.child.kill('SIGTERM');
    expect(await boundedWorkerExit(signalRun)).toBe(143);
  } finally {
    signalRun.stop();
  }
  expect(lockedSlots(signalFixture.memory, 4)).toEqual([]);

  const spawnFixture = workerFixture();
  const spawnFailure = startNativeWorker(
    spawnFixture,
    ['/missing/placement-memory-command'],
    placementEnvironment(spawnFixture),
  );
  try {
    expect(await boundedWorkerExit(spawnFailure)).toBe(1);
  } finally {
    spawnFailure.stop();
  }
  expect(lockedSlots(spawnFixture.memory, 4)).toEqual([]);
  const failedRecords = latestLedgerEntries(spawnFixture.root);
  expect(failedRecords).toHaveLength(1);
  expect(failedRecords[0].terminalStatus).toBe('infrastructure-failure');

  const resultFile = join(spawnFixture.root, 'exit-75-count');
  const failure = startNativeWorker(
    spawnFixture,
    [
      '--local',
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(resultFile)}, 'run\\n');process.exit(75)`,
    ],
    placementEnvironment(spawnFixture),
  );
  try {
    expect(await boundedWorkerExit(failure)).toBe(75);
  } finally {
    failure.stop();
  }
  expect(readFileSync(resultFile, 'utf8')).toBe('run\n');
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
    expect(finished.physicalRunId).not.toBe(record.physicalRunId);
    const firstPhysical = readWorkerCheckHistory(id, record.physicalRunId, root);
    const rerunPhysical = readWorkerCheckHistory(id, finished.physicalRunId, root);
    expect(firstPhysical).toMatchObject({ status: 'finished', exitCode: 1 });
    expect(rerunPhysical).toMatchObject({
      status: 'finished',
      exitCode: 0,
      argv: ['bun', 'test', 'overloaded.test.ts'],
    });
    expect(rerunPhysical?.runnerIdentity).not.toEqual(firstPhysical?.runnerIdentity);
    expect(firstPhysical?.terminalProof).toMatchObject({ local: true, resultKnown: true });
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
  await withRecoveryRunner(
    root,
    0,
    async (initial, interrupt) => {
      const { id } = initial;
      const resultPath = join(root, '.temp/goal/checks/results', `${id}.json`);
      await interrupt();
      const out: string[] = [];
      expect(await waitWorkerCheck(id, root, 50, { pollMs: 5, write: (line) => out.push(line) })).toBe(75);
      expect(out.join('')).toContain('check: still running');
      const rerun = JSON.parse(readFileSync(resultPath, 'utf8'));
      expect(rerun.runnerPid).not.toBe(process.pid);
      expect(readFileSync(`/proc/${rerun.runnerPid}/cmdline`, 'utf8')).toContain(`--run\0${id}\0`);
      expect(rerun.id).toBe(id);
      expect(rerun.argv).toEqual(initial.argv);
      expect(rerun.physicalRunId).not.toBe(initial.physicalRunId);
      out.length = 0;
      expect(await waitWorkerCheck(id, root, 5_000, { write: (line) => out.push(line) })).toBe(7);
      expect(out.join('')).toContain('infrastructure failure');
      expect(out.join('')).toContain('check: exit status 7');
      expect(JSON.parse(readFileSync(resultPath, 'utf8')).reruns).toBe(1);
      expect(readFileSync(join(root, 'physical-attempts'), 'utf8')).toBe('2');
      expect(readWorkerCheckHistory(id, initial.physicalRunId!, root)).toMatchObject({
        argv: initial.argv,
        runnerIdentity: initial.runnerIdentity,
        terminalProof: { local: true, resultKnown: false },
      });
      expect(readWorkerCheckHistory(id, rerun.physicalRunId, root)).toMatchObject({
        id,
        argv: initial.argv,
        runnerIdentity: rerun.runnerIdentity,
        status: 'finished',
        exitCode: 7,
      });
    },
    'await Bun.sleep(300); console.error("rerun failed"); process.exit(7)',
  );
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

function reserveControllerProof(root: string, argv: string[]): ControllerProofBindingV1 {
  if (!existsSync(join(root, '.git'))) {
    writeFileSync(join(root, '.gitignore'), '.temp/\n');
    writeFileSync(join(root, 'source.txt'), 'captured source\n');
    git(root, 'init', '-b', 'worker');
    git(root, 'config', 'user.email', 'worker-check@example.test');
    git(root, 'config', 'user.name', 'Worker Check');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture source');
  }
  const registry = join(root, '.temp/registry');
  mkdirSync(registry, { recursive: true });
  const binding: ControllerProofBindingV1 = {
    version: 1,
    token: randomUUID(),
    checkId: randomUUID(),
    goal: 'performance',
    taskId: randomUUID(),
    attempt: 4,
    sourceCommit: git(root, 'rev-parse', 'HEAD'),
    sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    cwd: root,
    argv,
  };
  writeAtomicJson(controllerProofReservationPath(registry, binding.token), { version: 1, state: 'reserved', binding });
  return binding;
}

test('controller proof execution derivation admits only the selected saved wrapper syntax and preserves plain argv', () => {
  const binding = reserveControllerProof(overloadFixture(), [
    'bun',
    'scripts/worker-check.ts',
    '--local',
    '--',
    'bun',
    'test',
    'tests/once.test.ts',
  ]);
  const execution = controllerProofExecutionArgv(binding);
  expect(execution).toEqual(['--local', '--', 'bun', 'test', 'tests/once.test.ts']);
  execution.push('changed.test.ts');
  expect(binding.argv).toEqual([
    'bun',
    'scripts/worker-check.ts',
    '--local',
    '--',
    'bun',
    'test',
    'tests/once.test.ts',
  ]);
  for (const argv of [
    ['bun', 'test', 'tests/once.test.ts'],
    ['bun', '-e', "console.log('scripts/worker-check.ts')", 'scripts/worker-check.ts'],
    ['bun', '--cwd', 'services/kernel', '-e', "console.log('scripts/worker-check.ts')"],
    ['bun', 'test', 'tests/worker-check.ts.test.ts'],
    ['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/once.test.ts'],
    ['--local', process.execPath, '-e', 'process.exit(0)', '', '$literal; `text`'],
  ]) {
    const actual = controllerProofExecutionArgv({ ...binding, argv });
    expect(actual).toEqual(argv);
    expect(actual).not.toBe(argv);
  }
  for (const argv of [
    ...[
      './scripts/worker-check.ts',
      '/foreign/scripts/worker-check.ts',
      'scripts/../scripts/worker-check.ts',
      'foreign/worker-check.ts',
    ].map((path) => ['bun', path, ...binding.argv.slice(2)]),
    ['bun', 'run', ...binding.argv.slice(1)],
    ['env', ...binding.argv],
    ['sh', '-c', binding.argv.join(' ')],
    ['bun', 'alias.ts', ...binding.argv.slice(2)],
    ['bun', '"scripts/worker-check.ts"', ...binding.argv.slice(2)],
    ['bun', 'scripts/worker-check.ts&&echo', '--', 'bun', 'test', 'tests/once.test.ts'],
    ['bun', 'scripts/worker-check.ts', '--', 'bun', 'test', 'tests/once.test.ts'],
    ['bun', 'scripts/worker-check.ts', '--local', '--returns', 'out', '--', 'bun', 'test', 'tests/once.test.ts'],
    ['bun', 'scripts/worker-check.ts', '--local', 'bun', 'test', 'tests/once.test.ts'],
    binding.argv.slice(0, 6),
    [...binding.argv, '--timeout', '1000'],
    [...binding.argv.slice(0, 6), '../escape.test.ts'],
    [...binding.argv.slice(0, 6), '/absolute.test.ts'],
    [...binding.argv.slice(0, 6), '*.test.ts'],
    [...binding.argv.slice(0, 6), 'tests/once.test.ts; echo wrong'],
    [...binding.argv.slice(0, 4), ...binding.argv],
  ])
    expect(() => controllerProofExecutionArgv({ ...binding, argv })).toThrow('unsupported controller proof wrapper');
  expect(() => controllerProofExecutionArgv({ ...binding, attempt: 0 })).toThrow();
});

async function withControllerProofEnvironment(
  binding: ControllerProofBindingV1,
  work: () => Promise<void>,
): Promise<void> {
  const old = { ...process.env };
  const cwd = process.cwd();
  const keys = [
    'GOAL_TASK_ID',
    'GOAL_ATTEMPT',
    'GOAL_CHECK_REGISTRY',
    'REZICS_CHECK_MEMORY',
    'REZICS_CHECK_SCOPE',
    'KERNEL_CHECK_REMOTE',
    'KERNEL_CHECK_ON_REMOTE',
    'REZICS_CHECK_MEMORY_LEASE',
  ];
  try {
    process.chdir(binding.cwd);
    process.env.GOAL_TASK_ID = binding.taskId;
    process.env.GOAL_ATTEMPT = String(binding.attempt);
    process.env.GOAL_CHECK_REGISTRY = join(binding.cwd, '.temp/registry');
    process.env.REZICS_CHECK_MEMORY = 'off';
    process.env.REZICS_CHECK_SCOPE = 'off';
    delete process.env.KERNEL_CHECK_REMOTE;
    delete process.env.KERNEL_CHECK_ON_REMOTE;
    delete process.env.REZICS_CHECK_MEMORY_LEASE;
    await work();
  } finally {
    stopOwnedWorkerCheck(binding.checkId, binding.cwd);
    process.chdir(cwd);
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

test('controller proof exact API and CLI replay uses the preallocated logical UUID and executes original argv once', async () => {
  const root = overloadFixture();
  const counter = join(root, '.temp/counter');
  const binding = reserveControllerProof(root, [
    '--local',
    process.execPath,
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(counter)},JSON.stringify(process.argv.slice(1))+'\\n')`,
    '',
    'two words',
    '$literal; `text`',
  ]);
  await withControllerProofEnvironment(binding, async () => {
    const first = await startControllerWorkerCheck(binding);
    expect(first).toMatchObject({ version: 1, outcome: 'started', binding });
    expect(await waitWorkerCheck(binding.checkId, root, 5_000)).toBe(0);
    const before = readWorkerCheckRecord(binding.checkId, root);
    const replay = await startControllerWorkerCheck(binding);
    expect(replay).toMatchObject({ outcome: 'replayed', binding });
    expect(replay).toHaveProperty('resultPath', join(root, '.temp/goal/checks/results', binding.checkId + '.json'));
    const cli = spawnSync(
      process.execPath,
      [join(repository, 'scripts/worker-check.ts'), '--controller-proof', binding.token, '--', ...binding.argv],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 5_000 },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ outcome: 'replayed', binding });
    expect(readWorkerCheckRecord(binding.checkId, root).physicalRunId).toBe(before.physicalRunId);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual([
      JSON.stringify(['', 'two words', '$literal; `text`']),
    ]);
    const registration = JSON.parse(
      readFileSync(registrationPath(process.env.GOAL_CHECK_REGISTRY!, binding.checkId, before.physicalRunId!), 'utf8'),
    );
    expect(validControllerProofRegistration(registration, binding)).toBe(true);
    for (const changed of [
      { ...registration, checkId: randomUUID() },
      { ...registration, physicalRunId: randomUUID() },
      { ...registration, runnerHost: 'other-host' },
      { ...registration, ownership: { taskId: binding.taskId, attempt: binding.attempt + 1 } },
      { ...registration, runnerIdentity: { ...registration.runnerIdentity, start: '0' } },
      { ...registration, controllerProof: { ...binding, goal: 'web' } },
      { ...registration, extra: true },
      { ...registration, controllerProof: undefined },
    ])
      expect(validControllerProofRegistration(changed, binding)).toBe(false);
  });
});

test('controller proof concurrent exact starts cannot create a duplicate physical incarnation', async () => {
  const root = overloadFixture();
  const marker = join(root, '.temp/once');
  const binding = reserveControllerProof(root, [
    '--local',
    process.execPath,
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x')`,
  ]);
  await withControllerProofEnvironment(binding, async () => {
    const answers = await Promise.all([startControllerWorkerCheck(binding), startControllerWorkerCheck(binding)]);
    expect(answers.filter((answer) => answer.outcome === 'started')).toHaveLength(1);
    expect(answers.every((answer) => ['started', 'replayed', 'unavailable'].includes(answer.outcome))).toBe(true);
    expect(await waitWorkerCheck(binding.checkId, root, 5_000)).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('x');
  });
});

test('controller proof source, argv, cwd, task, attempt, Goal and logical ID mismatches are durable pre-intent refusals', async () => {
  const root = overloadFixture();
  const mutations: Array<(binding: ControllerProofBindingV1) => ControllerProofBindingV1> = [
    (binding) => ({ ...binding, sourceCommit: '0'.repeat(40) }),
    (binding) => ({ ...binding, sourceTree: '0'.repeat(40) }),
    (binding) => ({ ...binding, argv: [...binding.argv, 'changed'] }),
    (binding) => ({ ...binding, cwd: repository }),
    (binding) => ({ ...binding, taskId: randomUUID() }),
    (binding) => ({ ...binding, attempt: binding.attempt + 1 }),
    (binding) => ({ ...binding, goal: 'web' }),
    (binding) => ({ ...binding, checkId: randomUUID() }),
  ];
  for (const mutate of mutations) {
    const binding = reserveControllerProof(root, ['--local', process.execPath, '-e', 'process.exit(99)']);
    await withControllerProofEnvironment(binding, async () => {
      expect(await startControllerWorkerCheck(mutate(binding))).toMatchObject({
        outcome: 'refused-never-started',
        binding,
      });
      expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'refused-never-started', binding });
      const state = JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'));
      expect(state).toMatchObject({ phase: 'refused', physical: [], binding });
      expect(existsSync(join(root, '.temp/goal/checks/results', binding.checkId + '.json'))).toBe(false);
    });
  }
});

test('controller proof validates actual HEAD, tracked contents and initiating ownership rather than caller metadata', async () => {
  const root = overloadFixture();
  for (const fault of ['tracked', 'hidden-tracked', 'staged', 'head', 'tree', 'task', 'attempt', 'cwd']) {
    const binding = reserveControllerProof(root, ['--local', process.execPath, '-e', 'process.exit(99)']);
    await withControllerProofEnvironment(binding, async () => {
      const reservation = controllerProofReservationPath(process.env.GOAL_CHECK_REGISTRY!, binding.token);
      if (fault === 'tracked' || fault === 'hidden-tracked' || fault === 'staged') {
        if (fault === 'hidden-tracked') git(root, 'update-index', '--assume-unchanged', 'source.txt');
        writeFileSync(join(root, 'source.txt'), 'changed source\n');
        if (fault === 'staged') git(root, 'add', 'source.txt');
      } else if (fault === 'head' || fault === 'tree') {
        const changed = { ...binding, [fault === 'head' ? 'sourceCommit' : 'sourceTree']: '0'.repeat(40) };
        writeAtomicJson(reservation, { version: 1, state: 'reserved', binding: changed });
        expect(await startControllerWorkerCheck(changed)).toHaveProperty('outcome', 'refused-never-started');
        return;
      } else if (fault === 'task') process.env.GOAL_TASK_ID = randomUUID();
      else if (fault === 'attempt') process.env.GOAL_ATTEMPT = String(binding.attempt + 1);
      else process.chdir(repository);
      try {
        expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'refused-never-started');
      } finally {
        if (fault === 'hidden-tracked') git(root, 'update-index', '--no-assume-unchanged', 'source.txt');
        if (['tracked', 'hidden-tracked', 'staged'].includes(fault))
          git(root, 'restore', '--staged', '--worktree', 'source.txt');
        process.chdir(root);
      }
    });
  }
});

test('controller proof revoked pre-intent reservations stay refused, while absent or changed tokens cannot borrow custody', async () => {
  const root = overloadFixture();
  const binding = reserveControllerProof(root, ['--local', process.execPath, '-e', 'process.exit(99)']);
  await withControllerProofEnvironment(binding, async () => {
    const path = controllerProofReservationPath(process.env.GOAL_CHECK_REGISTRY!, binding.token);
    writeAtomicJson(path, { version: 1, state: 'revoked', binding });
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'refused-never-started');
    writeAtomicJson(path, { version: 1, state: 'reserved', binding });
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'refused-never-started');
    expect(await startControllerWorkerCheck({ ...binding, token: randomUUID() })).toMatchObject({
      outcome: 'unavailable',
      custody: 'unknown',
    });
    rmSync(path);
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
  });
});

test('controller proof post-intent input changes and missing registration, result or registry retain unknown custody', async () => {
  const root = overloadFixture();
  const marker = join(root, '.temp/once');
  const binding = reserveControllerProof(root, [
    '--local',
    process.execPath,
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x')`,
  ]);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    expect(await waitWorkerCheck(binding.checkId, root, 5_000)).toBe(0);
    const record = readWorkerCheckRecord(binding.checkId, root);
    for (const changed of [
      { ...binding, argv: [...binding.argv, 'changed'] },
      { ...binding, sourceCommit: '0'.repeat(40) },
      { ...binding, goal: 'web' },
    ]) {
      expect(await startControllerWorkerCheck(changed)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    }
    writeFileSync(join(root, 'source.txt'), 'changed after native intent\n');
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    git(root, 'restore', 'source.txt');
    const reservation = controllerProofReservationPath(process.env.GOAL_CHECK_REGISTRY!, binding.token);
    const reused = { ...binding, checkId: randomUUID() };
    await withCheckFence(root, binding.checkId, () =>
      writeAtomicJson(reservation, { version: 1, state: 'reserved', binding: reused }),
    );
    expect(await startControllerWorkerCheck(reused)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    expect(existsSync(join(root, '.temp/goal/checks/results', reused.checkId + '.json'))).toBe(false);
    writeAtomicJson(reservation, { version: 1, state: 'reserved', binding });
    rmSync(registrationPath(process.env.GOAL_CHECK_REGISTRY!, binding.checkId, record.physicalRunId!));
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    rmSync(join(root, '.temp/goal/checks/results', binding.checkId + '.json'));
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    rmSync(process.env.GOAL_CHECK_REGISTRY!, { recursive: true });
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    mkdirSync(process.env.GOAL_CHECK_REGISTRY!);
    writeAtomicJson(reservation, { version: 1, state: 'reserved', binding });
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    expect(readFileSync(marker, 'utf8')).toBe('x');
  });
});

test('controller proof watchdog physical reruns preserve the same token, logical UUID, source and original argv', async () => {
  const root = recoveryFixture();
  const marker = join(root, '.temp/runs');
  const binding = reserveControllerProof(root, [
    '--local',
    process.execPath,
    '-e',
    `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(marker)})){fs.appendFileSync(${JSON.stringify(marker)},'x');process.exit(0)};fs.writeFileSync(${JSON.stringify(marker)},'x');setInterval(()=>{},1000)`,
  ]);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    await untilRecorded(() => existsSync(marker));
    const first = readWorkerCheckRecord(binding.checkId, root);
    const stale = new Date(Date.now() - 100);
    utimesSync(join(root, first.log), stale, stale);
    expect(await waitWorkerCheck(binding.checkId, root, 10_000, { stallMs: 100, rerunStallMs: 2_000, pollMs: 5 })).toBe(
      0,
    );
    const next = readWorkerCheckRecord(binding.checkId, root);
    expect(next).toMatchObject({ controllerProof: binding, id: binding.checkId, argv: binding.argv, reruns: 1 });
    expect(next.physicalRunId).not.toBe(first.physicalRunId);
    expect(readWorkerCheckHistory(binding.checkId, first.physicalRunId!, root)).toMatchObject({
      controllerProof: binding,
      argv: binding.argv,
    });
    expect(readWorkerCheckHistory(binding.checkId, next.physicalRunId!, root)).toMatchObject({
      controllerProof: binding,
      argv: binding.argv,
    });
    const state = JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'));
    expect(state).toMatchObject({ phase: 'intent', binding });
    expect(state.physical.map((run: { physicalRunId: string }) => run.physicalRunId)).toEqual([
      first.physicalRunId,
      next.physicalRunId,
    ]);
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'replayed');
    expect(readFileSync(marker, 'utf8')).toBe('xx');
  });
});

test('controller proof overload subset keeps original argv and distinct physical command histories', async () => {
  const root = overloadFixture();
  const healthy = join(root, '.temp/healthy');
  const failed = join(root, '.temp/failed');
  writeFileSync(
    join(root, 'healthy.test.ts'),
    `import {test} from 'bun:test';
import {appendFileSync} from 'node:fs';
test('healthy',()=>appendFileSync(${JSON.stringify(healthy)},'x'));`,
  );
  writeFileSync(
    join(root, 'overloaded.test.ts'),
    `import {test} from 'bun:test';
import {existsSync,appendFileSync} from 'node:fs';
test('transient',()=>{const first=!existsSync(${JSON.stringify(failed)});appendFileSync(${JSON.stringify(failed)},'x');if(first)throw new Error('HTTP 503 deadline_exceeded')});`,
  );
  const binding = reserveControllerProof(root, ['--local', 'bun', 'test', 'healthy.test.ts', 'overloaded.test.ts']);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    expect(await waitWorkerCheck(binding.checkId, root, 10_000)).toBe(0);
    const record = readWorkerCheckRecord(binding.checkId, root);
    const state = JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'));
    const firstId: string = state.physical[0].physicalRunId;
    expect(state.physical).toHaveLength(2);
    expect(record).toMatchObject({
      controllerProof: binding,
      argv: binding.argv,
      reruns: 1,
      physicalArgv: ['--local', 'bun', 'test', 'overloaded.test.ts'],
    });
    expect(readWorkerCheckHistory(binding.checkId, firstId, root)).toMatchObject({
      controllerProof: binding,
      argv: binding.argv,
      exitCode: 1,
    });
    expect(readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root)).toMatchObject({
      controllerProof: binding,
      argv: ['--local', 'bun', 'test', 'overloaded.test.ts'],
      exitCode: 0,
    });
    expect(readFileSync(healthy, 'utf8')).toBe('x');
    expect(readFileSync(failed, 'utf8')).toBe('xx');
    expect(await startControllerWorkerCheck({ ...binding, argv: record.physicalArgv! })).toMatchObject({
      outcome: 'unavailable',
      custody: 'unknown',
    });
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'replayed');
  });
});

test('controller proof lost durable intent cannot use an old cleanup receipt to claim never-started refusal', async () => {
  const root = recoveryFixture();
  const binding = reserveControllerProof(root, ['--local', process.execPath, '-e', 'process.exit(0)']);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    expect(await waitWorkerCheck(binding.checkId, root, 5_000)).toBe(0);
    const record = readWorkerCheckRecord(binding.checkId, root);
    writeAtomicJson(
      join(root, '.temp/goal/checks/custody/receipts', `${binding.checkId}.${record.physicalRunId}.json`),
      {
        version: 1,
        checkId: binding.checkId,
        physicalRunId: record.physicalRunId,
        disposition: 'stopped',
        localTerminal: true,
        remoteTerminal: null,
        resultTerminal: true,
      },
    );
    rmSync(controllerProofStatePath(root, binding.checkId));
    rmSync(join(root, '.temp/goal/checks/results', binding.checkId + '.json'));
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
  });
});

test('controller proof CLI rejects malformed tokens and missing separators without starting a command', () => {
  const root = overloadFixture();
  const marker = join(root, 'must-not-run');
  for (const args of [
    [
      '--controller-proof',
      '../token',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`,
    ],
    ['--controller-proof', randomUUID(), process.execPath, '-e', 'process.exit(99)'],
    ['--controller-proof', randomUUID(), '--'],
  ]) {
    const result = spawnSync(process.execPath, [join(repository, 'scripts/worker-check.ts'), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--controller-proof requires');
    expect(existsSync(marker)).toBe(false);
  }
});

test('A bound proof whose owned setup fails before command launch retains the exact failure and publishes only positively established immutable physical terminal custody', async () => {
  const root = overloadFixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@fixture-missing-pin' }));
  const marker = join(root, '.temp/must-not-run');
  const binding = reserveControllerProof(root, [
    '--local',
    'bun',
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`,
  ]);
  let diagnostic = '';
  try {
    resolveRepositoryBun(['bun'], root);
  } catch (error) {
    diagnostic = (error as Error).message;
  }
  expect(diagnostic).toContain('ENOENT');
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'started', binding });
    const record = readWorkerCheckRecord(binding.checkId, root);
    expect(record).toMatchObject({ status: 'finished', exitCode: 1, argv: binding.argv, controllerProof: binding });
    expect(readFileSync(join(root, record.log), 'utf8')).toBe(diagnostic + '\n');
    expect(existsSync(marker)).toBe(false);
    expect(sameProcess(record.runnerIdentity!)).toBe(false);
    expect(processGroupMembers(record.runnerIdentity!.group)).toEqual([]);
    const history = readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root);
    expect(history).toMatchObject({
      status: 'finished',
      exitCode: 1,
      remoteExpected: false,
      terminalProof: { local: true, remote: null, resultKnown: true },
    });
    expect(history?.terminalHistory).toHaveLength(1);
    expect(readWorkerCheckCleanupHistory(binding.checkId, record.physicalRunId!, root)).toHaveLength(1);
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'replayed', binding });
    expect(readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root)).toEqual(history);
    const state = JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'));
    expect(state).toMatchObject({ phase: 'intent', binding });
    expect(state.physical).toEqual([{ physicalRunId: record.physicalRunId, argv: binding.argv }]);
  });
});

test('a setup failure with lost registered physical custody remains unknown rather than becoming a never-started refusal', async () => {
  const root = overloadFixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@fixture-missing-pin' }));
  const binding = reserveControllerProof(root, ['--local', 'bun', 'test', 'unreached.test.ts']);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    const record = readWorkerCheckRecord(binding.checkId, root);
    const history = readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root);
    const receipts = readWorkerCheckCleanupHistory(binding.checkId, record.physicalRunId!, root);
    const log = readFileSync(join(root, record.log), 'utf8');
    rmSync(registrationPath(process.env.GOAL_CHECK_REGISTRY!, binding.checkId, record.physicalRunId!));
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'unavailable', custody: 'unknown' });
    expect(readWorkerCheckRecord(binding.checkId, root)).toEqual(record);
    expect(readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root)).toEqual(history);
    expect(readWorkerCheckCleanupHistory(binding.checkId, record.physicalRunId!, root)).toEqual(receipts);
    expect(readFileSync(join(root, record.log), 'utf8')).toBe(log);
  });
});

test('Exact saved repository wrapped originals execute once through the admitted logical invocation without changing original argv or minting a nested check', async () => {
  const root = overloadFixture();
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/worker-check.ts'), "throw new Error('a nested wrapper must never execute');\n");
  const counter = join(root, '.temp/counter');
  writeFileSync(
    join(root, 'once.test.ts'),
    `import {test,expect} from 'bun:test';
test('once',()=>{expect(process.env.REZICS_CHECK_LOCAL_ONLY).toBe('1');require('node:fs').appendFileSync(${JSON.stringify(counter)},'x')});`,
  );
  const binding = reserveControllerProof(root, [
    'bun',
    'scripts/worker-check.ts',
    '--local',
    '--',
    'bun',
    'test',
    'once.test.ts',
  ]);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'started', binding });
    expect(await waitWorkerCheck(binding.checkId, root, 5_000)).toBe(0);
    const record = readWorkerCheckRecord(binding.checkId, root);
    expect(record).toMatchObject({ id: binding.checkId, argv: binding.argv, controllerProof: binding });
    expect(record.physicalArgv).toBeUndefined();
    expect(readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root)?.argv).toEqual([...binding.argv]);
    expect(readdirSync(join(root, '.temp/goal/checks/results'))).toEqual([binding.checkId + '.json']);
    const registration = JSON.parse(
      readFileSync(registrationPath(process.env.GOAL_CHECK_REGISTRY!, binding.checkId, record.physicalRunId!), 'utf8'),
    );
    expect(registration.controllerProof).toEqual(binding);
    expect(validControllerProofRegistration(registration, binding)).toBe(true);
    expect(await startControllerWorkerCheck(binding)).toMatchObject({ outcome: 'replayed', binding });
    expect(readWorkerCheckRecord(binding.checkId, root).physicalRunId).toBe(record.physicalRunId);
    expect(readFileSync(counter, 'utf8')).toBe('x');
    expect(JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8')).physical).toEqual([
      { physicalRunId: record.physicalRunId, argv: binding.argv },
    ]);
  });
});

test('saved wrapper overload reruns derive the physical subset while replay retains the raw original', async () => {
  const root = overloadFixture();
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/worker-check.ts'), "throw new Error('nested wrapper');\n");
  const healthy = join(root, '.temp/healthy');
  const transient = join(root, '.temp/transient');
  writeFileSync(
    join(root, 'healthy.test.ts'),
    `import {test} from 'bun:test';
test('healthy',()=>require('node:fs').appendFileSync(${JSON.stringify(healthy)},'x'));`,
  );
  writeFileSync(
    join(root, 'transient.test.ts'),
    `import {test} from 'bun:test';
test('transient',()=>{const fs=require('node:fs');const first=!fs.existsSync(${JSON.stringify(transient)});fs.appendFileSync(${JSON.stringify(transient)},'x');if(first)throw new Error('HTTP 503 overloaded')});`,
  );
  const binding = reserveControllerProof(root, [
    'bun',
    'scripts/worker-check.ts',
    '--local',
    '--',
    'bun',
    'test',
    'healthy.test.ts',
    'transient.test.ts',
  ]);
  await withControllerProofEnvironment(binding, async () => {
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'started');
    expect(await waitWorkerCheck(binding.checkId, root, 10_000)).toBe(0);
    const record = readWorkerCheckRecord(binding.checkId, root);
    expect(record).toMatchObject({
      argv: binding.argv,
      controllerProof: binding,
      reruns: 1,
      physicalArgv: ['--local', '--', 'bun', 'test', 'transient.test.ts'],
    });
    const state = JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'));
    expect(state.physical).toHaveLength(2);
    expect(state.physical[0].argv).toEqual(binding.argv);
    expect(readWorkerCheckHistory(binding.checkId, record.physicalRunId!, root)?.argv).toEqual(record.physicalArgv);
    expect(readFileSync(healthy, 'utf8')).toBe('x');
    expect(readFileSync(transient, 'utf8')).toBe('xx');
    expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'replayed');
    expect(await startControllerWorkerCheck({ ...binding, argv: record.physicalArgv! })).toMatchObject({
      outcome: 'unavailable',
      custody: 'unknown',
    });
  });
});

test('unsupported wrapper originals and untracked wrapper sources are refused before physical intent', async () => {
  for (const argv of [
    ['bun', './scripts/worker-check.ts', '--local', '--', 'bun', 'test', 'once.test.ts'],
    ['bun', 'scripts/worker-check.ts', '--', 'bun', 'test', 'once.test.ts'],
    ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test', 'once.test.ts'],
  ]) {
    const root = overloadFixture();
    const binding = reserveControllerProof(root, argv);
    await withControllerProofEnvironment(binding, async () => {
      expect(await startControllerWorkerCheck(binding)).toHaveProperty('outcome', 'refused-never-started');
      expect(JSON.parse(readFileSync(controllerProofStatePath(root, binding.checkId), 'utf8'))).toMatchObject({
        phase: 'refused',
        physical: [],
      });
      expect(existsSync(join(root, '.temp/goal/checks/results', binding.checkId + '.json'))).toBe(false);
    });
  }
});

test('fixed lifecycle argv preserves its original binding and cannot start through an unbound producer', async () => {
  const { tmpdir } = await import('node:os');
  const { encodeLifecycleSpec, LIFECYCLE_CHILD } = await import('./check-lifecycle-child.ts');
  const root = mkdtempSync(join(tmpdir(), 'rezics-worker-lifecycle-'));
  try {
    const fields = {
      version: 1 as const,
      token: randomUUID(),
      checkId: randomUUID(),
      goal: 'performance',
      taskId: randomUUID(),
      attempt: 1,
      sourceCommit: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      cwd: root,
    };
    const spec = {
      version: 1 as const,
      checkId: fields.checkId,
      taskId: fields.taskId,
      attempt: fields.attempt,
      sourceCommit: fields.sourceCommit,
      sourceTree: fields.sourceTree,
      nonce: 'c'.repeat(64),
      exitCode: 7 as const,
      lifetimeMs: 1_000,
      runtime: { packageManager: 'bun@fixture', version: Bun.version, revision: Bun.revision },
      childSha256: 'd'.repeat(64),
    };
    const binding: ControllerProofBindingV1 = {
      ...fields,
      argv: ['bun', LIFECYCLE_CHILD, '--probe', encodeLifecycleSpec(spec)],
    };
    expect(controllerProofExecutionArgv(binding)).toEqual(binding.argv);
    expect(await needsStack(binding.argv, root)).toBe(true);
    await expect(runWorkerCheck(binding.argv, root)).rejects.toThrow('controller-bound admission required');
    expect(existsSync(join(root, '.temp/goal/checks/custody/remote'))).toBe(false);
    expect(existsSync(join(root, '.temp/goal/checks/lifecycle'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed wrapper retains rejected producer bytes and manifest when the publication receipt is missing', async () => {
  const fixture = workerFixture(),
    old = { ...process.env };
  const hosts = writeHosts(fixture);
  const approved = JSON.parse(readFileSync(hosts, 'utf8'));
  for (const host of approved.hosts) host.performance = true;
  writeFileSync(hosts, JSON.stringify(approved));
  const physical = randomUUID(),
    logical = randomUUID();
  const inner = `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {dirname,join} from 'node:path';
    import {registerArtifactDeclarations,captureArtifactReturns} from ${JSON.stringify(join(repository, 'scripts/check-artifacts.ts'))};
    import {KERNEL_CLIENT_OUTPUT,encodeOutputTree} from ${JSON.stringify(join(repository, 'scripts/check-output-tree.ts'))};
    const root=process.cwd(), path=KERNEL_CLIENT_OUTPUT.transport;
    const stage=process.env.REZICS_CHECK_ARTIFACTS_DIR, physical=process.env.REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID;
    await registerArtifactDeclarations(root,stage,physical,[path]);
    mkdirSync(join(root,KERNEL_CLIENT_OUTPUT.root),{recursive:true});
    writeFileSync(join(root,KERNEL_CLIENT_OUTPUT.root,'retained.d.ts'),'export type Retained = true;');
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),encodeOutputTree(root,{host:'a',run:'fixture-run',sourceSha256:'a'.repeat(64)}));
    await captureArtifactReturns(root,stage,physical,[path]);
    process.exitCode=1;
  `;
  const command = ['bun', '-e', inner];
  for (let i = 0; i < 3; i++) recordPeak(fixture.memory, checkClass(command, fixture.root), 2 * 2 ** 30);
  try {
    Object.assign(process.env, placementEnvironment(fixture, hosts, 'artifact'));
    process.env.WORKER_REMOTE_MODE = 'artifact';
    process.env.WORKER_ARTIFACT_REMOTE_BASE = join(fixture.root, '.temp/fake-check-host');
    const code = await runWorkerCheck(
      command,
      fixture.root,
      false,
      undefined,
      60_000,
      logical,
      0,
      undefined,
      true,
      physical,
    );
    expect(code).toBe(1);
    const stage = join(fixture.root, '.temp/goal/checks/artifact-returns', physical);
    expect(existsSync(join(stage, 'manifest.json'))).toBe(true);
    expect(readFileSync(join(stage, 'files/000.bin'), 'utf8')).toContain('export type Retained = true;');
    const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
    expect(manifest.physicalRunId).toBe(physical);
    expect(manifest.entries[0].path).toBe('.temp/check-output-tree/kernel-client-v1.bin');
  } finally {
    restoreWorkerEnvironment(old);
    if (old.WORKER_ARTIFACT_REMOTE_BASE === undefined) delete process.env.WORKER_ARTIFACT_REMOTE_BASE;
    else process.env.WORKER_ARTIFACT_REMOTE_BASE = old.WORKER_ARTIFACT_REMOTE_BASE;
  }
});
