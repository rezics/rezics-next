import { afterEach, expect, test } from 'bun:test';
import { readControlPolicy } from './policy.ts';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDirectoryLease } from './lease.ts';
import { parseBrief } from './briefs.ts';
import { bootSmokeEnvironment } from './verification.ts';
import {
  bootSmokeRepairBrief,
  classifyRun,
  devVerificationState,
  placeInWorkspace,
  VERIFY_CONCURRENCY,
  verifyDev,
  withTreeBun,
  type BootSmokeRepair,
} from './dev-verifier.ts';
import type { DevVerifierFinding, DevVerifierRun, Settings, Task } from './types.ts';

const roots: string[] = [];
const repositoryRoot = join(import.meta.dir, '../../..');
const repositoryPackageManager = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
  packageManager: string;
}).packageManager;
const repositoryBunPackage = join(repositoryRoot, 'node_modules/bun');
const repositoryBunBinary = join(repositoryBunPackage, 'bin/bun.exe');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'goal-dev-verifier-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'services', 'kernel'), { recursive: true });
  writeFileSync(join(root, 'services', 'kernel', 'base.ts'), 'export const base = true;\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'typecheck.ts'), 'process.exit(0);\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(root, 'toolchain/bin'), { recursive: true });
  writeFileSync(
    join(root, 'toolchain/package.json'),
    JSON.stringify({ name: 'bun', version: repositoryPackageManager.slice('bun@'.length), bin: { bun: 'bin/bun.exe' } }),
  );
  writeFileSync(join(root, 'toolchain/bin/bun.exe'), `#!/bin/sh\nexec '${repositoryBunBinary}' "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'verifier-fixture',
      packageManager: repositoryPackageManager,
      dependencies: { bun: 'file:./toolchain' },
    }),
  );
  const lock = spawnSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (lock.status !== 0) throw new Error(lock.stderr);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', 'dev');
  git(root, 'branch', 'dev-verified');
  return root;
}
function commit(root: string, path: string, content: string, message: string): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  git(root, 'add', path);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}
function setup(root: string, tasks: Task[] = []) {
  const stateDirectory = join(root, '.state'),
    worktreeRoot = join(root, '.trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const updates: string[] = [];
  const runs = new Map<string, DevVerifierRun>();
  const findings: DevVerifierFinding[] = [];
  const store = {
    tasks: () => tasks,
    task: (id: string) => tasks.find((task) => task.id === id)!,
    updateTask: ({ taskId }: { taskId: string }, update: (task: Task) => void) => {
      const task = tasks.find((item) => item.id === taskId)!;
      update(task);
      updates.push(taskId);
      return task;
    },
    devVerifierRun: (key: string) => runs.get(key),
    saveDevVerifierRun: (run: DevVerifierRun) => runs.set(run.key, run),
    devVerifierFindings: () => findings,
    saveDevVerifierFinding: (finding: DevVerifierFinding) => findings.push(finding),
  };
  const inboxEvents: any[] = [];
  const settings = {
    mainCheckout: root,
    stateDirectory,
    worktreeRoot,
    integrationBranch: 'dev',
    affectedTests: [{ paths: ['services/kernel/**'], command: ['affected-check'] }],
  } as unknown as Settings;
  return { settings, store, updates, inbox: { deliver: (event: any) => inboxEvents.push(event) }, inboxEvents };
}
function landedTask(from: string, commitHead: string, id = 'kernel-task'): Task {
  return {
    id,
    sequence: 1,
    state: 'integrated',
    worktree: '',
    branch: 'worker/task',
    base: from,
    taskClass: 'mechanical',
    currentAttempt: 1,
    createdAt: '',
    integratedBase: from,
    integratedCommit: commitHead,
    integratedCommits: [commitHead],
    brief: {
      id,
      goal: 'kernel',
      manager: 'kernel-manager',
      kind: 'implementation',
      paths: ['services/kernel/**'],
      target: 'dev',
      acceptance: { command: ['acceptance', id], tests: [], failing: true },
    } as any,
  } as Task;
}

test('classifies check outcomes and runs Web tests from their workspace', () => {
  expect(classifyRun({ passed: true, timedOut: false, output: '' })).toBe('pass');
  expect(classifyRun({ passed: false, timedOut: false, output: 'assertion failed' })).toBe('fail');
  expect(classifyRun({ passed: false, timedOut: true, output: 'ETIMEDOUT' })).toBe('infrastructure');
  expect(
    classifyRun({
      passed: false,
      timedOut: false,
      output: `pinned Bun: absent installed package for ${repositoryPackageManager}`,
    }),
  ).toBe('infrastructure');
  const result = { passed: false, timedOut: false, output: 'error: first assertion\nerror: second assertion' };
  expect(classifyRun(result, readControlPolicy({ verifier: { findingAssertions: 1 } }).verifier)).toBe(
    'infrastructure',
  );
  expect(classifyRun(result)).toBe('fail');

  expect(
    placeInWorkspace(
      { command: ['env', 'NO_COLOR=1', 'bun', 'test', 'apps/web/tests/example.test.ts'], closure: ['apps/web/**'] },
      new Set(['apps/web/bunfig.toml']),
    ),
  ).toEqual({
    command: ['env', 'NO_COLOR=1', 'bun', 'test', 'tests/example.test.ts'],
    closure: ['apps/web/**'],
    cwd: 'apps/web',
  });
});

test('uses the candidate pinned Bun and falls back to the installed producer artifact only when absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-pinned-bun-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  const producer = join(root, 'producer');
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ packageManager: repositoryPackageManager }));
  mkdirSync(join(candidate, 'node_modules'), { recursive: true });
  symlinkSync(repositoryBunPackage, join(candidate, 'node_modules/bun'), 'dir');
  mkdirSync(join(producer, 'node_modules'), { recursive: true });
  symlinkSync(repositoryBunPackage, join(producer, 'node_modules/bun'), 'dir');

  let command = withTreeBun(['bun', 'test', 'tests/example.test.ts'], candidate, producer);
  expect(command[0]).toBe('env');
  expect(command[2]).toBe(join(candidate, 'node_modules/bun/bin/bun.exe'));
  expect(command[1]).toContain(
    `PATH=${join(candidate, 'node_modules/.bin')}:${join(producer, 'node_modules/.bin')}:`,
  );

  rmSync(join(candidate, 'node_modules/bun'));
  command = withTreeBun(['bun', 'test', 'tests/example.test.ts'], candidate, producer);
  expect(command[2]).toBe(join(producer, 'node_modules/bun/bin/bun.exe'));
});

test('reports unavailable candidate Bun instead of falling back to the ambient command', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-unavailable-bun-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: repositoryPackageManager }));
  expect(() => withTreeBun(['bun', 'test'], root)).toThrow('absent installed package');
});

test.each([false, true])('bootstraps a fresh pinned tree (install fails: %s)', async (fails) => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  mkdirSync(join(root, 'toolchain/bin'), { recursive: true });
  writeFileSync(
    join(root, 'toolchain/package.json'),
    JSON.stringify({ name: 'bun', version: Bun.version, bin: { bun: 'bin/bun.exe' } }),
  );
  writeFileSync(join(root, 'toolchain/bin/bun.exe'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: `bun@${Bun.version}`, dependencies: { bun: 'file:./toolchain' } }),
  );
  const lock = spawnSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(lock.status, lock.stderr).toBe(0);
  if (fails) writeFileSync(join(root, 'bun.lock'), 'invalid lockfile');
  git(root, 'add', 'package.json', 'bun.lock', 'toolchain');
  git(root, 'commit', '-m', 'pin Bun on dev');
  const landing = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', '-f', 'dev', landing);
  git(root, 'checkout', '--detach', base);
  expect(existsSync(join(root, 'node_modules/.bin/bun'))).toBe(false);
  const ctx = setup(root);
  let checks = 0;
  const runGate = async (command: readonly string[], cwd: string) => {
    expect(command).toContain(join(cwd, 'node_modules/bun/bin/bun.exe'));
    const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
    checks++;
    return { passed: result.status === 0, output: result.stdout + result.stderr, timedOut: false };
  };
  // Keep successful setup evidence across a restart, but request the check again in a new tree.
  const store = {
    ...ctx.store,
    devVerifierRun: (key: string) => {
      const run = ctx.store.devVerifierRun(key);
      return run?.evidence.command.includes('install') ? run : undefined;
    },
  };
  for (let restart = 0; restart < 2; restart++) {
    git(root, 'branch', '-f', 'dev-verified', base);
    await verifyDev({ ...ctx, store, runGate });
  }
  expect(checks).toBe(fails ? 0 : 2);
  const findings = ctx.store.devVerifierFindings();
  if (fails) {
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.result === 'infrastructure')).toBe(true);
  } else expect(findings).toEqual([]);
  const logs = readdirSync(ctx.settings.stateDirectory).filter((name) => name.startsWith('dev-verify-install-'));
  expect(logs).toHaveLength(2);
  for (const log of logs) {
    expect(readFileSync(join(ctx.settings.stateDirectory, log), 'utf8')).toContain(
      `$ ${process.execPath} install --frozen-lockfile`,
    );
  }
});

test('reuses a failed verifier check while its workspace inputs stay unchanged', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const changed = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', landing);
  const ctx = setup(root);
  let failedCalls = 0;
  const runGate = async (command: readonly string[], cwd: string) => {
    if (command.includes('affected-check')) {
      const hasChange = git(cwd, 'ls-files').includes('services/kernel/change.ts');
      if (hasChange) failedCalls++;
      return hasChange
        ? { passed: false, output: 'assertion failed', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  };

  await verifyDev({ ...ctx, runGate });
  expect(ctx.store.devVerifierFindings?.().some((finding) => finding.result === 'fail')).toBe(true);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);

  const docs = commit(root, 'docs/readme.md', 'Updated.\n', 'docs');
  git(root, 'branch', '-f', 'dev', docs);
  await verifyDev({ ...ctx, runGate });
  expect(failedCalls).toBe(1);
});

test('worker-owned briefs keep affected verification without inventing an acceptance command', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const changed = true;\n', 'outcome');
  git(root, 'branch', '-f', 'dev', landing);
  const task = landedTask(base, landing);
  task.brief.acceptance = { command: [], tests: [], failing: true, workerOwned: true };
  const ctx = setup(root, [task]);
  const commands: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(commands).toContain('affected-check');
  expect(commands).not.toContain('');
  expect(commands.some((command) => command.startsWith('acceptance'))).toBe(false);
  expect(devVerificationState(root).behind).toBe(0);
});

test('passes all work since dev-verified once and advances the ref to the captured dev head', async () => {
  const root = repo();
  const first = commit(root, 'services/kernel/one.ts', 'export const one = 1;\n', 'landing one');
  const second = commit(root, 'services/kernel/two.ts', 'export const two = 2;\n', 'landing two');
  git(root, 'branch', '-f', 'dev', second);
  const ctx = setup(root, [
    landedTask(git(root, 'rev-parse', 'dev-verified'), first),
    landedTask(git(root, 'rev-parse', 'dev-verified'), second, 'task-two'),
  ]);
  const commands: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(second);
  expect(commands.some((command) => command.endsWith('scripts/typecheck.ts'))).toBe(true);
  expect(commands).toContain('affected-check');
  expect(commands).toContain('acceptance kernel-task');
  expect(commands).toContain('acceptance task-two');
  expect(devVerificationState(root).behind).toBe(0);
});

import './dev-verifier-ownership.test.ts';

test('failure bisects workspace suspects, reverts only the culprit, returns its task with the log, and advances verified', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const good = commit(root, 'services/kernel/good.ts', 'export const good = true;\n', 'good landing');
  const bad = commit(root, 'services/kernel/bad.ts', 'export const bad = false;\n', 'bad landing');
  git(root, 'branch', '-f', 'dev', bad);
  const unrelatedCommit = commit(root, 'docs/readme.md', 'docs\n', 'unrelated landing');
  git(root, 'branch', '-f', 'dev', unrelatedCommit);
  const tasks = [
    landedTask(base, good, 'good'),
    landedTask(base, bad, 'bad'),
    {
      ...landedTask(base, unrelatedCommit, 'docs'),
      brief: { ...landedTask(base, unrelatedCommit, 'docs').brief, paths: ['docs/**'] },
    } as Task,
  ];
  const ctx = setup(root, tasks);
  const runGate = async (command: readonly string[], cwd: string, logPath: string) => {
    const files = git(cwd, 'ls-files');
    if (command.includes('affected-check') && files.includes('services/kernel/bad.ts')) {
      writeFileSync(logPath, 'assertion failed');
      return { passed: false, output: 'assertion failed', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  };
  await verifyDev({ ...ctx, runGate });
  expect(spawnSync('git', ['cat-file', '-e', `dev:${'services/kernel/bad.ts'}`], { cwd: root }).status).not.toBe(0);
  expect(git(root, 'show', `dev:${'services/kernel/good.ts'}`)).toContain('good');
  expect(ctx.updates).toEqual(['bad']);
  expect(ctx.inboxEvents[0].managerId).toBe('kernel-manager');
  expect(ctx.inboxEvents[0].evidencePath).toBeTruthy();
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(git(root, 'rev-parse', 'dev'));
});

test('promotion candidates use dev-verified while worker bases use the dev head', async () => {
  const taskSource = await Bun.file(new URL('./tasks.ts', import.meta.url)).text();
  const promotionSource = await Bun.file(new URL('./promotion.ts', import.meta.url)).text();
  expect(taskSource).not.toContain('existingVerifiedBranch');
  expect(promotionSource).toContain("'dev-verified'");
});

test('infrastructure failure reruns only that command and never reverts a landing', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const change = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', landing);
  const ctx = setup(root, [landedTask(base, landing)]);
  const calls: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command, _cwd, logPath) => {
      calls.push(command.join(' '));
      if (calls.length === 1) writeFileSync(logPath, 'ETIMEDOUT');
      return calls.length === 1
        ? { passed: false, output: 'ETIMEDOUT', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    },
  });
  expect(calls.filter((command) => command.endsWith('scripts/typecheck.ts'))).toHaveLength(2);
  expect(calls.filter((command) => command === 'affected-check')).toHaveLength(1);
  expect(calls.filter((command) => command === 'acceptance kernel-task')).toHaveLength(1);
  expect(git(root, 'rev-parse', 'dev')).toBe(landing);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(landing);
});

test.each([undefined, 1])('runs every check within verifier concurrency %s', async (concurrency) => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  const tasks: Task[] = [];
  let head = base;
  for (let index = 0; index < 8; index++) {
    head = commit(root, `services/kernel/file-${index}.ts`, `export const value = ${index};\n`, `landing ${index}`);
    tasks.push(landedTask(base, head, `task-${index}`));
  }
  git(root, 'branch', '-f', 'dev', head);
  const ctx = setup(root, tasks);
  if (concurrency !== undefined) ctx.settings.policy = readControlPolicy({ verifier: { concurrency } });
  const commands: string[] = [];
  let running = 0,
    highest = 0;
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      running++;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(highest).toBe(concurrency ?? VERIFY_CONCURRENCY);
  for (let index = 0; index < 8; index++) expect(commands).toContain(`acceptance task-${index}`);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(head);
});

const KERNEL_BOOT = 'services/kernel/test/boot/kernel-boots.test.ts';
function bootRepo() {
  const root = repo();
  commit(root, KERNEL_BOOT, 'test("boot", () => {});\n', 'boot test');
  git(root, 'branch', '-f', 'dev');
  git(root, 'branch', '-f', 'dev-verified');
  return root;
}

test('A new dev head whose Kernel entry throws on import gets a boot finding within one verifier cycle, even while older heads are still queued, and the owner of the breaking commit receives an urgent repair dispatch.', async () => {
  const root = bootRepo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const older = commit(root, 'services/kernel/good.ts', 'export const good = true;\n', 'older landing');
  const breaking = commit(root, 'services/kernel/broken.ts', 'throw new Error("import");\n', 'kernel import throw');
  git(root, 'branch', '-f', 'dev', breaking);
  const tasks = [landedTask(base, older, 'older'), landedTask(base, breaking, 'breaking')];
  const ctx = setup(root, tasks);
  ctx.settings.bootSmoke = { tests: [KERNEL_BOOT] };
  const repairs: BootSmokeRepair[] = [];
  const dispatchedBriefs: ReturnType<typeof parseBrief>[] = [];
  const order: string[] = [];
  const run = async (command: readonly string[], cwd: string) => {
    if (command.some((part) => part.includes('kernel-boots'))) {
      order.push('boot');
      const files = git(cwd, 'ls-files');
      return files.includes('services/kernel/broken.ts')
        ? { passed: false, output: 'error: Kernel entry threw on import', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    }
    if (command[0] === 'acceptance') order.push('queued');
    return { passed: true, output: '', timedOut: false };
  };
  const dispatchRepair = (repair: BootSmokeRepair) => {
    repairs.push(repair);
    dispatchedBriefs.push(parseBrief(bootSmokeRepairBrief(repair), { version: 1, areas: {} }));
    if (!repair.existingTaskId)
      tasks.push({
        id: 'boot-repair',
        state: 'ready',
        brief: {
          urgent: true,
          markdown: `Boot-smoke repair for \`${repair.test}\``,
          goal: 'kernel',
          manager: 'kernel-manager',
        },
      } as Task);
  };
  await verifyDev({ ...ctx, runGate: run, dispatchRepair });
  expect(order[0]).toBe('boot');
  expect(order).toContain('queued');
  expect(
    ctx.store
      .devVerifierFindings()
      .some((finding) => finding.status === 'new' && finding.reason.includes('Boot smoke')),
  ).toBe(true);
  expect(repairs).toHaveLength(1);
  expect(dispatchedBriefs[0]?.riskAreas).toEqual([]);
  expect(repairs[0]).toMatchObject({ test: KERNEL_BOOT, commit: breaking });
  expect(repairs[0]!.existingTaskId).toBeUndefined();
  expect(repairs[0]!.owner.id).toBe('breaking');
  expect(repairs[0]!.error).toContain('Kernel entry threw on import');
  expect(bootSmokeRepairBrief(repairs[0]!).includes('"urgent": true')).toBe(true);
  expect(git(root, 'rev-parse', 'dev')).toBe(breaking);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
  await verifyDev({ ...ctx, runGate: run, dispatchRepair });
  expect(repairs).toHaveLength(2);
  expect(repairs[1]!.existingTaskId).toBe('boot-repair');
});

test('boot-smoke repair briefs retain owner risk areas and pass dispatch validation', () => {
  const repair = {
    test: KERNEL_BOOT,
    commit: 'broken-head',
    error: 'Error: kernel did not boot',
    owner: {
      brief: {
        goal: 'auth',
        manager: 'auth-manager',
        paths: ['services/auth/**'],
        riskAreas: ['authorization'],
      },
    } as Task,
  } as BootSmokeRepair;

  expect(
    parseBrief(bootSmokeRepairBrief(repair), {
      version: 1,
      areas: { authorization: ['**/auth/**'] },
    }).riskAreas,
  ).toEqual(['authorization']);
});

test('Boot smoke runs outside worker slots and never delays a landing.', async () => {
  const root = bootRepo();
  const landing = commit(root, 'services/kernel/ok.ts', 'export const ok = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', landing);
  const ctx = setup(root, [landedTask(git(root, 'rev-parse', 'dev-verified'), landing)]);
  ctx.settings.bootSmoke = { tests: [KERNEL_BOOT] };
  const train = join(ctx.settings.stateDirectory, 'train.lease');
  let trainFree = false;
  await verifyDev({
    ...ctx,
    runBootSmoke: async () => {
      const env = bootSmokeEnvironment({ KERNEL_CHECK_REMOTE: 'hosts.json', REMOTE_CHECK_PRIORITY: 'landing' });
      expect(env.KERNEL_CHECK_REMOTE).toBeUndefined();
      expect(env.REMOTE_CHECK_PRIORITY).toBeUndefined();
      acquireDirectoryLease(train).release();
      trainFree = true;
      expect(existsSync(join(ctx.settings.stateDirectory, 'capacity-queue'))).toBe(false);
      return { passed: true, output: '', timedOut: false };
    },
    runGate: async () => ({ passed: true, output: '', timedOut: false }),
  });
  expect(trainFree).toBe(true);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(landing);
});

test('one existing-failure probe leaves unsampled prefixes unproven without reverting a landing', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const tasks: Task[] = [];
  let head = base;
  for (let index = 0; index < 4; index++) {
    head = commit(root, `services/kernel/probe-${index}.ts`, `export const value = ${index};\n`, `prefix ${index}`);
    tasks.push(landedTask(base, head, `probe-${index}`));
  }
  git(root, 'branch', '-f', 'dev', head);
  const ctx = setup(root, tasks);
  ctx.settings.policy = readControlPolicy({ verifier: { existingProbes: 1 } });
  const probed: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command, cwd) => {
      if (command[0] !== 'affected-check') return { passed: true, output: '', timedOut: false };
      probed.push(git(cwd, 'rev-parse', 'HEAD'));
      return { passed: false, output: 'error: retained assertion', timedOut: false };
    },
  });
  expect(probed.sort()).toEqual([base, head, tasks[0]!.integratedCommit!].sort());
  expect(ctx.store.devVerifierFindings().some((finding) => finding.status === 'unknown')).toBe(true);
  expect(ctx.updates).toEqual([]);
  expect(git(root, 'rev-parse', 'dev')).toBe(head);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
});
