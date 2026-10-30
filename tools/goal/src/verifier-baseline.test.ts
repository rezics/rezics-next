import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { WorkerStore } from './store.ts';
import { openDb } from './db.ts';
import { verifyDev } from './dev-verifier.ts';
import type { Task } from './types.ts';
import { gateRunner, type GateRunner } from './merge.ts';

const roots: string[] = [];
const temporaryRoot = join(import.meta.dir, '../../../.temp/goal-verifier-baseline');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function repository(): string {
  mkdirSync(temporaryRoot, { recursive: true });
  const root = join(temporaryRoot, `case-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'services/kernel'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'services/kernel/base.ts'), 'export const base = true;\n');
  writeFileSync(join(root, 'scripts/typecheck.ts'), 'process.exit(0);\n');
  writeFileSync(
    join(root, 'scripts/legacy-failure.ts'),
    "console.error('AssertionError: existing acceptance failure'); process.exitCode = 1;\n",
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'dev', base);
  git(root, 'branch', 'dev-verified', base);
  return root;
}

function commit(root: string, path: string, content: string, message: string): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  git(root, 'add', '--', path);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function task(
  id: string,
  base: string,
  commitHead: string,
  paths = ['services/kernel/**'],
  acceptance = ['bun', '-e', 'process.exit(0)'],
): Task {
  const value = {
    id,
    sequence: 1,
    briefPath: '',
    state: 'integrated',
    worktree: '',
    branch: `worker/${id}`,
    base,
    taskClass: 'mechanical',
    currentAttempt: 0,
    createdAt: new Date(0).toISOString(),
    integratedBase: base,
    integratedCommit: commitHead,
    integratedCommits: [commitHead],
    brief: {
      goal: 'kernel',
      manager: `${id}-manager`,
      kind: 'implementation',
      paths,
      riskAreas: [],
      acceptance: { command: acceptance, tests: [], failing: true },
      estimate: { lines: 1, files: 1 },
      criticalPath: false,
      waiting: [],
      after: [],
      inseparable: false,
      citesSources: false,
      hostileInput: false,
      markdown: '',
    },
  } as unknown as Task;
  return value;
}

function context(root: string, tasks: Task[] = [], affectedCommand = ['affected-check']) {
  const stateDirectory = join(root, '.state');
  const worktreeRoot = join(stateDirectory, 'trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const store = new WorkerStore(openDb(join(stateDirectory, 'goal.sqlite')));
  for (const [index, item] of tasks.entries())
    store.db.query('INSERT INTO worker_tasks VALUES (?,?,?,?)').run(item.id, index + 1, item.currentAttempt, JSON.stringify(item));
  const events: any[] = [];
  const settings = {
    mainCheckout: root,
    stateDirectory,
    worktreeRoot,
    integrationBranch: 'dev',
    affectedTests: [{ paths: ['services/kernel/**'], command: affectedCommand }],
  } as any;
  return {
    settings,
    store,
    events,
    stateDirectory,
    inbox: { deliver: (event: any) => events.push(event) },
    close: () => store.db.close(),
  };
}

function runner(
  run: (command: readonly string[], cwd: string, log: string) => Promise<{ passed: boolean; output: string; timedOut: boolean }>,
): GateRunner {
  return async (command, cwd, log) => {
    const result = await run(command, cwd, log);
    mkdirSync(join(log, '..'), { recursive: true });
    writeFileSync(log, result.output);
    return result;
  };
}

test('an existing baseline failure is recorded durably while a healthy landing advances verified exactly once', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const healthy = commit(root, 'services/kernel/healthy.ts', 'export const healthy = true;\n', 'healthy landing');
  git(root, 'update-ref', 'refs/heads/dev', healthy, base);
  const affected = ['bun', '-e', "console.error('AssertionError: old kernel failure'); process.exitCode = 1;"];
  const ctx = context(root, [task('healthy', base, healthy)], affected);
  let affectedCalls = 0;
  const runGate = gateRunner(10_000, ctx.stateDirectory);
  const observeGate: GateRunner = async (command, cwd, log) => {
    if (command.join(' ') === affected.join(' ')) affectedCalls++;
    return runGate(command, cwd, log);
  };

  try {
    await verifyDev({ ...ctx, runGate: observeGate });
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(healthy);
    const reflog = git(root, 'reflog', '--format=%H', 'refs/heads/dev-verified').split('\n');
    expect(reflog[0]).toBe(healthy);
    expect(reflog[1]).toBe(base);
    expect(affectedCalls).toBe(2);
    expect(ctx.store.devVerifierFindings()).toMatchObject([
      { status: 'existing', baseCommit: base, headCommit: healthy, assertion: 'AssertionError: old kernel failure' },
    ]);

    ctx.close();
    const reopened = new WorkerStore(openDb(join(ctx.stateDirectory, 'goal.sqlite')));
    expect(reopened.devVerifierFindings()).toMatchObject([
      { status: 'existing', baseCommit: base, headCommit: healthy, assertion: 'AssertionError: old kernel failure' },
    ]);
    await verifyDev({ ...ctx, store: reopened, runGate: observeGate });
    expect(affectedCalls).toBe(2);
    reopened.db.close();
  } finally {
    try {
      ctx.close();
    } catch {}
  }
});

test('a restarted verifier does not repeat prefix probes for an unchanged existing finding', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const first = commit(root, 'services/kernel/first.ts', 'export const first = true;\n', 'first healthy landing');
  const second = commit(root, 'services/kernel/second.ts', 'export const second = true;\n', 'second healthy landing');
  const third = commit(root, 'services/kernel/third.ts', 'export const third = true;\n', 'third healthy landing');
  git(root, 'update-ref', 'refs/heads/dev', second, base);
  const ctx = context(root, [task('first', base, first), task('second', base, second), task('third', base, third)]);
  let moved = false;
  let prefixRuns = 0;
  const runGate = runner(async (command, cwd) => {
    const revision = git(cwd, 'rev-parse', 'HEAD');
    if (revision === first && command.includes('affected-check')) prefixRuns++;
    if (!moved && revision === second) {
      moved = true;
      git(root, 'update-ref', 'refs/heads/dev', third, second);
    }
    return command.includes('affected-check')
      ? { passed: false, output: 'AssertionError: stable existing finding\n', timedOut: false }
      : { passed: true, output: '', timedOut: false };
  });

  try {
    await verifyDev({ ...ctx, runGate });
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
    expect(prefixRuns).toBe(1);
    ctx.close();
    const restarted = new WorkerStore(openDb(join(ctx.stateDirectory, 'goal.sqlite')));
    await verifyDev({ ...ctx, store: restarted, runGate });
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(third);
    expect(prefixRuns).toBe(1);
    restarted.db.close();
  } finally {
    try {
      ctx.close();
    } catch {}
  }
});

test('baseline equivalence never creates a task verification receipt for a failed acceptance command', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/acceptance-owner.ts', 'export const landed = true;\n', 'landing');
  git(root, 'update-ref', 'refs/heads/dev', landing, base);
  const ctx = context(root, [task('acceptance-owner', base, landing, ['services/kernel/**'], ['bun', 'scripts/legacy-failure.ts'])], ['true']);
  const runGate = gateRunner(10_000, ctx.stateDirectory);

  try {
    await verifyDev({ ...ctx, runGate });
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(landing);
    const row = ctx.store.db
      .query("SELECT count(*) AS count FROM flow_events WHERE task_id=? AND stage='verification' AND action='verified'")
      .get('acceptance-owner') as { count: number };
    expect(row.count).toBe(0);
    expect(ctx.store.devVerifierFindings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'existing', assertion: 'AssertionError: existing acceptance failure' }),
      ]),
    );
  } finally {
    ctx.close();
  }
});

test('a head assertion added beside a matching baseline assertion remains new and routes to its landing', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const bad = commit(root, 'services/kernel/bad.ts', 'export const bad = true;\n', 'bad landing');
  git(root, 'update-ref', 'refs/heads/dev', bad, base);
  const affected = [
    'bun',
    '-e',
    "import { existsSync } from 'node:fs'; console.error('AssertionError: baseline A'); if (existsSync('services/kernel/bad.ts')) console.error('AssertionError: newly introduced B'); process.exitCode = 1;",
  ];
  const ctx = context(root, [task('bad', base, bad)], affected);
  const runGate = gateRunner(10_000, ctx.stateDirectory);

  try {
    await verifyDev({ ...ctx, runGate });
    const findings = ctx.store.devVerifierFindings().filter((item) => item.headCommit === bad);
    expect(findings.map((item) => [item.assertion, item.status])).toContainEqual(['AssertionError: baseline A', 'existing']);
    expect(findings.map((item) => [item.assertion, item.status])).toContainEqual(['AssertionError: newly introduced B', 'new']);
    expect(ctx.store.task('bad').state).toBe('stopped');
    expect(ctx.events.map((event) => event.taskId)).toEqual(['bad']);
    expect(git(root, 'rev-parse', 'dev')).not.toBe(bad);
  } finally {
    ctx.close();
  }
});

test('a new failure after an existing assertion passes in an intermediate prefix selects only the later owner', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const healthy = commit(root, 'services/kernel/healthy.ts', 'export const healthy = true;\n', 'healthy prefix');
  const bad = commit(root, 'services/kernel/bad.ts', 'export const bad = true;\n', 'bad resolution');
  git(root, 'update-ref', 'refs/heads/dev', bad, base);
  const affected = [
    'bun',
    '-e',
    "import { existsSync } from 'node:fs'; console.error('AssertionError: existing A'); if (existsSync('services/kernel/bad.ts')) console.error('AssertionError: resolution B'); process.exitCode = 1;",
  ];
  const ctx = context(root, [task('healthy', base, healthy), task('bad', base, bad)], affected);
  const runGate = gateRunner(10_000, ctx.stateDirectory);

  try {
    await verifyDev({ ...ctx, runGate });
    expect(ctx.store.task('healthy').state).toBe('integrated');
    expect(ctx.store.task('bad').state).toBe('stopped');
    expect(ctx.events.map((event) => event.taskId)).toEqual(['bad']);
    expect(git(root, 'show', `dev:services/kernel/healthy.ts`)).toContain('healthy');
    const reports = ctx.store.devVerifierFindings().filter((item) => item.headCommit === bad);
    expect(reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertion: 'AssertionError: existing A', status: 'existing' }),
        expect.objectContaining({ assertion: 'AssertionError: resolution B', status: 'new', taskId: 'bad' }),
      ]),
    );
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(git(root, 'rev-parse', 'dev'));
  } finally {
    ctx.close();
  }
});

test('a passing infrastructure retry cannot hide another unresolved new failure', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const first = commit(root, 'services/kernel/first.ts', 'export const first = true;\n', 'first landing');
  const second = commit(root, 'services/kernel/second.ts', 'export const second = true;\n', 'second landing');
  git(root, 'update-ref', 'refs/heads/dev', second, base);
  const ctx = context(root, [task('first', base, first), task('second', base, second)], ['infra-check']);
  ctx.settings.affectedTests.push({ paths: ['services/kernel/**'], command: ['new-check'] });
  const headInfraCalls = new Map<string, number>();
  const runGate = runner(async (command, cwd) => {
    const revision = git(cwd, 'rev-parse', 'HEAD');
    if (command.includes('infra-check')) {
      if (revision === second) {
        const count = (headInfraCalls.get(revision) ?? 0) + 1;
        headInfraCalls.set(revision, count);
        if (count === 1) return { passed: false, output: 'ETIMEDOUT while connecting to check host', timedOut: false };
      }
      return { passed: true, output: '', timedOut: false };
    }
    if (command.includes('new-check')) {
      const files = git(cwd, 'ls-files');
      return files.includes('services/kernel/first.ts') || files.includes('services/kernel/second.ts')
        ? { passed: false, output: 'AssertionError: new shared failure\n', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  });

  try {
    await verifyDev({ ...ctx, runGate });
    expect(headInfraCalls.get(second)).toBe(2);
    expect(ctx.store.task('first').state).toBe('stopped');
    expect(ctx.store.task('second').state).toBe('integrated');
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
    expect(ctx.store.devVerifierFindings().some((item) => item.status === 'new' && item.assertion.includes('new shared failure'))).toBe(true);
  } finally {
    ctx.close();
  }
});

test('missing baseline commands, baseline setup failures, and exhausted transport failures stay unknown', async () => {
  const missingRoot = repository();
  const missingBase = git(missingRoot, 'rev-parse', 'dev-verified');
  const missingHead = commit(
    missingRoot,
    'services/kernel/new.test.ts',
    "console.error('AssertionError: new acceptance failed');\n",
    'add acceptance command',
  );
  git(missingRoot, 'update-ref', 'refs/heads/dev', missingHead, missingBase);
  const missingContext = context(
    missingRoot,
    [task('new-acceptance', missingBase, missingHead, ['services/kernel/**'], ['bun', 'test', 'services/kernel/new.test.ts'])],
  );
  const missingCalls: string[] = [];
  const missingRunner = runner(async (command) => {
    missingCalls.push(command.join(' '));
    return command.some((argument) => argument.includes('new.test.ts'))
      ? { passed: false, output: 'AssertionError: new acceptance failed\n', timedOut: false }
      : { passed: true, output: '', timedOut: false };
  });

  try {
    await verifyDev({ ...missingContext, runGate: missingRunner });
    expect(missingContext.store.devVerifierFindings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'unknown', reason: expect.stringContaining('absent at the exact verified baseline') }),
      ]),
    );
    expect(missingCalls.some((command) => command.includes('new.test.ts'))).toBe(true);
    expect(git(missingRoot, 'rev-parse', 'dev-verified')).toBe(missingBase);
  } finally {
    missingContext.close();
  }

  const setupRoot = repository();
  writeFileSync(join(setupRoot, 'package.json'), '{"name":"baseline-fixture","private":true}\n');
  writeFileSync(join(setupRoot, 'bun.lock'), 'this is not a bun lock\n');
  git(setupRoot, 'add', 'package.json', 'bun.lock');
  git(setupRoot, 'commit', '-m', 'add broken baseline install fixture');
  const setupBase = git(setupRoot, 'rev-parse', 'HEAD');
  git(setupRoot, 'branch', '-f', 'dev', setupBase);
  git(setupRoot, 'branch', '-f', 'dev-verified', setupBase);
  const setupHead = commit(setupRoot, 'services/kernel/setup-change.ts', 'export const changed = true;\n', 'fix install setup');
  git(setupRoot, 'rm', 'bun.lock', 'package.json');
  git(setupRoot, 'commit', '-m', 'remove broken baseline lock');
  const finalSetupHead = git(setupRoot, 'rev-parse', 'HEAD');
  git(setupRoot, 'update-ref', 'refs/heads/dev', finalSetupHead, setupBase);
  const setupContext = context(setupRoot, [task('setup-change', setupBase, finalSetupHead)]);
  const setupRunner = runner(async () => ({ passed: false, output: 'AssertionError: new failure after setup', timedOut: false }));
  try {
    await verifyDev({ ...setupContext, runGate: setupRunner });
    expect(setupContext.store.devVerifierFindings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'unknown', reason: expect.stringContaining('Baseline dependency setup failed') }),
      ]),
    );
    expect(git(setupRoot, 'rev-parse', 'dev-verified')).toBe(setupBase);
    expect(readdirSync(setupContext.stateDirectory).filter((name) => name.startsWith('dev-verify-install-'))).toHaveLength(1);
    setupContext.close();
    const restarted = new WorkerStore(openDb(join(setupContext.stateDirectory, 'goal.sqlite')));
    await verifyDev({ ...setupContext, store: restarted, runGate: setupRunner });
    expect(readdirSync(setupContext.stateDirectory).filter((name) => name.startsWith('dev-verify-install-'))).toHaveLength(1);
    restarted.db.close();
  } finally {
    try {
      setupContext.close();
    } catch {}
  }

  const infraRoot = repository();
  const infraBase = git(infraRoot, 'rev-parse', 'dev-verified');
  const infraHead = commit(infraRoot, 'services/kernel/infra-change.ts', 'export const changed = true;\n', 'infra landing');
  git(infraRoot, 'update-ref', 'refs/heads/dev', infraHead, infraBase);
  const infraContext = context(infraRoot, [task('infra-change', infraBase, infraHead)]);
  const transportCalls: string[] = [];
  const infraRunner = runner(async (command, cwd) => {
    if (command.includes('affected-check')) {
      const revision = git(cwd, 'rev-parse', 'HEAD');
      transportCalls.push(revision);
      return revision === infraBase
        ? { passed: false, output: 'RemoteTransportError: SSH connection reset', timedOut: false }
        : { passed: false, output: 'AssertionError: baseline comparison unavailable', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  });
  try {
    await verifyDev({ ...infraContext, runGate: infraRunner });
    expect(transportCalls).toEqual([infraBase, infraBase, infraBase]);
    expect(infraContext.store.devVerifierFindings()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'unknown' })]),
    );
    expect(infraContext.events).toHaveLength(0);
    expect(git(infraRoot, 'rev-parse', 'dev-verified')).toBe(infraBase);
  } finally {
    infraContext.close();
  }

  // Keep this binding live so the accepted contract records that the head's setup commit is also in the range.
  expect(setupHead).not.toBe(setupBase);
});

test('concurrent dev and verified ref moves win their compare-and-swap', async () => {
  for (const movedRef of ['dev', 'dev-verified'] as const) {
    const root = repository();
    const base = git(root, 'rev-parse', 'dev-verified');
    const target = commit(root, 'services/kernel/change.ts', 'export const change = true;\n', 'landing');
    git(root, 'update-ref', 'refs/heads/dev', target, base);
    const ctx = context(root, [task('change', base, target)]);
    let moved = false;
    let expectedMovedHead = '';
    const runGate = runner(async (_command, cwd) => {
      if (!moved && git(cwd, 'rev-parse', 'HEAD') === target) {
        moved = true;
        if (movedRef === 'dev') {
          const tree = join(ctx.stateDirectory, 'concurrent-dev');
          git(root, 'worktree', 'add', '--detach', tree, target);
          writeFileSync(join(tree, 'services/kernel/concurrent.ts'), 'export const concurrent = true;\n');
          git(tree, 'add', 'services/kernel/concurrent.ts');
          git(tree, 'commit', '-m', 'concurrent dev update');
          expectedMovedHead = git(tree, 'rev-parse', 'HEAD');
          git(root, 'update-ref', 'refs/heads/dev', expectedMovedHead, target);
          git(root, 'worktree', 'remove', '--force', tree);
        } else {
          const tree = join(ctx.stateDirectory, 'concurrent-verified');
          git(root, 'worktree', 'add', '--detach', tree, base);
          mkdirSync(join(tree, 'docs'), { recursive: true });
          writeFileSync(join(tree, 'docs/concurrent.md'), 'concurrent verifier update\n');
          git(tree, 'add', 'docs/concurrent.md');
          git(tree, 'commit', '-m', 'concurrent verified update');
          expectedMovedHead = git(tree, 'rev-parse', 'HEAD');
          git(root, 'update-ref', 'refs/heads/dev-verified', expectedMovedHead, base);
          git(root, 'worktree', 'remove', '--force', tree);
        }
      }
      return { passed: true, output: '', timedOut: false };
    });
    try {
      await verifyDev({ ...ctx, runGate });
      expect(moved).toBe(true);
      expect(git(root, `rev-parse`, `refs/heads/${movedRef}`)).toBe(expectedMovedHead);
      if (movedRef === 'dev') expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
    } finally {
      ctx.close();
    }
  }
});

test('a new assertion without a task in the verified range remains unowned and unadvanced', async () => {
  const root = repository();
  const base = git(root, 'rev-parse', 'dev-verified');
  const head = commit(root, 'services/kernel/unowned.ts', 'export const unowned = true;\n', 'unowned change');
  git(root, 'update-ref', 'refs/heads/dev', head, base);
  const ctx = context(root);
  const runGate = runner(async (command, cwd) =>
    command.includes('affected-check') && git(cwd, 'ls-files').includes('services/kernel/unowned.ts')
      ? { passed: false, output: 'AssertionError: unowned new assertion\n', timedOut: false }
      : { passed: true, output: '', timedOut: false },
  );

  try {
    await verifyDev({ ...ctx, runGate });
    expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
    expect(ctx.events).toHaveLength(0);
    const finding = ctx.store.devVerifierFindings().find((item) => item.headCommit === head);
    expect(finding).toMatchObject({ status: 'new', headCommit: head });
    expect(finding).not.toHaveProperty('taskId');
  } finally {
    ctx.close();
  }
});
