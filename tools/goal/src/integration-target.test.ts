import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MergeTrain } from './merge-train.ts';
import { git, type GateRunner } from './merge.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { integrationHarness, markdown } from './test-support.ts';

const success: GateRunner = async () => ({ passed: true, output: '', timedOut: false });

function dispatch(h: ReturnType<typeof integrationHarness>, file: string, goal = 'control-plane', manager?: string) {
  const briefFile = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  const text = markdown
    .replace('goal: fixture', `goal: ${goal}${manager ? `\nmanager: ${manager}` : ''}`)
    .replace('paths: [result.txt]', `paths: [${file}]`)
    .replace('command: [bun, test]', 'command: ["true"]');
  writeFileSync(briefFile, text);
  const task = h.tasks.dispatch(briefFile);
  mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: file }));
  return task;
}

async function train(
  h: ReturnType<typeof integrationHarness>,
  runGate: GateRunner = success,
  hooks: { beforeIntegrationAdvance?: () => void; beforePromotionAdvance?: () => void } = {},
): Promise<void> {
  await new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        h.outcomes.push(outcome);
        h.job.onGateOutcome(outcome);
      },
    },
    runGate,
    ...hooks,
  }).run();
  await h.job.drain();
}

function addCommit(h: ReturnType<typeof integrationHarness>, branch: string, files: Record<string, string>): string {
  const base = h.head(branch);
  const tree = join(h.settings.worktreeRoot, `branch-update-${crypto.randomUUID()}`);
  mkdirSync(h.settings.worktreeRoot, { recursive: true });
  git(h.root, 'worktree', 'add', '--detach', tree, base);
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      writeFileSync(join(tree, file), content);
    }
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', `Advance ${branch}`);
    const commit = git(tree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', `refs/heads/${branch}`, commit, base);
    return commit;
  } finally {
    git(h.root, 'worktree', 'remove', '--force', tree);
  }
}

test('a control-plane task whose changes all lie under tools/goal integrates into main, and main then reaches stabilize and dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);
    const checks: string[][] = [];

    await train(h, async (command) => {
      checks.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });

    const main = h.head('main');
    const stabilize = h.head('stabilize');
    const dev = h.head('dev');
    expect(main).not.toBe(base);
    expect(git(h.root, 'show', 'main:tools/goal/src/hotfix.ts')).toBe('tools/goal/src/hotfix.ts');
    expect(git(h.root, 'rev-parse', 'stabilize^2')).toBe(main);
    expect(git(h.root, 'rev-parse', 'dev^2')).toBe(stabilize);
    expect(git(h.root, 'merge-base', '--is-ancestor', main, stabilize)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilize, dev)).toBe('');
    expect(checks).toEqual(
      expect.arrayContaining([
        ['bun', 'install', '--frozen-lockfile'],
        ['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'],
        ['bun', 'run', '--cwd', 'tools/goal', 'typecheck'],
        ['bun', 'test', '--timeout', '30000', 'tools/goal/src'],
      ]),
    );
    // A train worktree starts with nothing installed, so the installs come before the checks that need them.
    const index = (command: string[]) => checks.findIndex((check) => JSON.stringify(check) === JSON.stringify(command));
    expect(index(['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'])).toBeLessThan(
      index(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']),
    );
    expect(h.store.task(task.id).state).toBe('merged');
    expect(h.outcomes[0]?.mergedCommit).toBe(main);
    // The control plane runs from the main checkout's files, so they must be the landed tree, not just the ref.
    expect(readFileSync(join(h.root, 'tools/goal/src/hotfix.ts'), 'utf8')).toBe('tools/goal/src/hotfix.ts');
    expect(git(h.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  } finally {
    h.dispose();
  }
});

test('a control-plane task moved onto a newer dev still integrates into main with only its own changes', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);
    // Another goal lands on dev, and a retry moves the branch onto it; the recorded base stays the original one.
    addCommit(h, 'dev', { 'docs/other-goal.md': 'other goal\n' });
    git(task.worktree, 'rebase', '--quiet', 'dev');

    await train(h);

    expect(git(h.root, 'show', 'main:tools/goal/src/hotfix.ts')).toBe('tools/goal/src/hotfix.ts');
    expect(git(h.root, 'ls-tree', '--name-only', 'main', 'docs/other-goal.md')).toBe('');
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});

test('a control-plane task with any changed file outside tools/goal integrates into dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const task = dispatch(h, 'tools/goal/src/mixed.ts');
    await h.start(task);
    mkdirSync(join(task.worktree, 'docs'), { recursive: true });
    writeFileSync(join(task.worktree, 'docs/control-plane-note.md'), 'outside control-plane path\n');
    git(task.worktree, 'add', 'docs/control-plane-note.md');
    git(task.worktree, 'commit', '-m', 'Add an out-of-scope control-plane file');
    const checks: string[][] = [];

    await train(h, async (command) => {
      checks.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });

    expect(h.head('main')).toBe(main);
    expect(git(h.root, 'show', 'dev:tools/goal/src/mixed.ts')).toBe('tools/goal/src/mixed.ts');
    expect(git(h.root, 'show', 'dev:docs/control-plane-note.md')).toBe('outside control-plane path');
    expect(checks).toEqual([]);
    expect(h.store.task(task.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});

test('a task from another goal continues to integrate into dev even when it changes tools/goal', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const task = dispatch(h, 'tools/goal/src/other-goal.ts', 'fixture');
    await h.start(task);
    const checks: string[][] = [];

    await train(h, async (command) => {
      checks.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });

    expect(h.head('main')).toBe(main);
    expect(git(h.root, 'show', 'dev:tools/goal/src/other-goal.ts')).toBe('tools/goal/src/other-goal.ts');
    expect(checks).toEqual([]);
    expect(h.store.task(task.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});

test('a downstream merge conflict aborts without moving its target and notifies both managers', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('dev');
    git(h.root, 'branch', 'stabilize', base);
    addCommit(h, 'stabilize', { 'tools/goal/src/conflict.ts': 'stabilize side\n' });
    const stabilize = h.head('stabilize');
    const task = dispatch(h, 'tools/goal/src/conflict.ts', 'control-plane', 'control-manager');
    await h.start(task);

    await train(h);

    expect(h.head('main')).not.toBe(base);
    expect(h.head('stabilize')).toBe(stabilize);
    expect(h.head('dev')).toBe(base);
    expect(h.outcomes[0]?.passed).toBe(true);
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    for (const manager of ['control-manager', h.settings.integration.supermanager]) {
      const notices = inbox.read(manager).map((entry) => entry.event.summary);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('conflicts with stabilize');
      expect(notices[0]).toContain('tools/goal/src/conflict.ts');
    }
  } finally {
    h.dispose();
  }
});

test('a target that advances during a control-plane merge is preserved by compare-and-swap retry', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);
    let raced = false;
    let racedHead = '';

    await train(h, success, {
      beforePromotionAdvance: () => {
        if (raced) return;
        raced = true;
        racedHead = addCommit(h, 'stabilize', { 'tools/goal/src/concurrent.ts': 'concurrent stabilize change\n' });
      },
    });

    const stabilize = h.head('stabilize');
    const dev = h.head('dev');
    expect(raced).toBe(true);
    expect(git(h.root, 'merge-base', '--is-ancestor', racedHead, stabilize)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('main'), stabilize)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilize, dev)).toBe('');
    expect(git(h.root, 'show', 'dev:tools/goal/src/concurrent.ts')).toBe('concurrent stabilize change');
  } finally {
    h.dispose();
  }
});

test('a main advance during control-plane checks is preserved by compare-and-swap retry', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);
    let raced = false;
    let racedHead = '';
    let checkRuns = 0;

    await train(
      h,
      async () => {
        checkRuns++;
        return { passed: true, output: '', timedOut: false };
      },
      {
        beforeIntegrationAdvance: () => {
          if (raced) return;
          raced = true;
          writeFileSync(join(h.root, 'main-concurrent.txt'), 'concurrent main change\n');
          git(h.root, 'add', 'main-concurrent.txt');
          git(h.root, 'commit', '-m', 'Advance main during landing');
          racedHead = h.head('main');
        },
      },
    );

    const main = h.head('main');
    const stabilize = h.head('stabilize');
    const dev = h.head('dev');
    expect(raced).toBe(true);
    expect(checkRuns).toBe(8); // Four control-plane checks, run again after the compare-and-swap retry.
    expect(git(h.root, 'merge-base', '--is-ancestor', racedHead, main)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', main, stabilize)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilize, dev)).toBe('');
    expect(git(h.root, 'show', 'dev:main-concurrent.txt')).toBe('concurrent main change');
  } finally {
    h.dispose();
  }
});

test('a control-plane test file that fails in the suite under load and passes alone does not keep the task off main', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);
    const runs: string[][] = [];

    await train(h, async (command) => {
      runs.push([...command]);
      if (JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', 'tools/goal/src']))
        return {
          passed: false,
          output: 'tools/goal/src/flaky.test.ts:\n(fail) a timing test [5000.00ms]\n 1 fail',
          timedOut: false,
        };
      return { passed: true, output: '', timedOut: false };
    });

    expect(runs).toContainEqual(['bun', 'test', '--timeout', '30000', 'tools/goal/src/flaky.test.ts']);
    expect(git(h.root, 'show', 'main:tools/goal/src/hotfix.ts')).toBe('tools/goal/src/hotfix.ts');
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});

test('a control-plane test file that fails alone too keeps the task off main', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);

    await train(h, async (command) =>
      command[1] === 'test'
        ? {
            passed: false,
            output: 'tools/goal/src/broken.test.ts:\n(fail) a real failure [1.00ms]\n 1 fail',
            timedOut: false,
          }
        : { passed: true, output: '', timedOut: false },
    );

    expect(h.head('main')).toBe(main);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.store.task(task.id).state).not.toBe('merged');
  } finally {
    h.dispose();
  }
});

test('failed control-plane checks keep the task off main', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const task = dispatch(h, 'tools/goal/src/hotfix.ts');
    await h.start(task);

    await train(h, async (command) =>
      command[1] === 'test'
        ? { passed: false, output: 'AssertionError: control-plane suite failed', timedOut: false }
        : { passed: true, output: '', timedOut: false },
    );

    expect(h.head('main')).toBe(main);
    expect(h.head('dev')).toBe(main);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('AssertionError: control-plane suite failed');
    expect(h.store.task(task.id).state).not.toBe('merged');
  } finally {
    h.dispose();
  }
});
