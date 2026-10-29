import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completionChecker } from './completion.ts';
import { gateRunner, git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const failsWith = (file: string) => [
  'bun',
  '-e',
  `if (require('fs').existsSync(${JSON.stringify(file)})) { console.error('AssertionError: incompatible feature'); process.exit(1); }`,
];
const requires = (file: string) => [
  'bun',
  '-e',
  `if (!require('fs').existsSync(${JSON.stringify(file)})) { console.error('AssertionError: missing feature'); process.exit(1); }`,
];
const ancestor = (cwd: string, older: string, newer: string) =>
  expect(git(cwd, 'merge-base', older, newer)).toBe(older);

test('a passing worker branch runs its acceptance before integrating into dev and main does not move', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const task = h.dispatch('feature', [], failsWith('feature'));
    await h.start(task);
    const worker = h.head(task.branch);
    let gates = 0;
    await h.train(async () => {
      gates++;
      return { passed: true, output: '', timedOut: false };
    });
    expect(gates).toBe(1);
    expect(h.head('main')).toBe(main);
    expect(h.head()).toBe(worker);
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.head(task.branch)).toBe(worker);
    expect(git(h.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(existsSync(join(h.root, 'feature'))).toBe(false);
  } finally {
    h.dispose();
  }
});

test('integration into dev refuses undeclared risk changes, unions Markdown and refuses other conflicts', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const scope = h.dispatch('allowed');
    await h.start(scope);
    mkdirSync(join(scope.worktree, 'auth'), { recursive: true });
    writeFileSync(join(scope.worktree, 'auth/outside'), 'undeclared');
    git(scope.worktree, 'add', 'auth/outside');
    git(scope.worktree, 'commit', '-qm', 'Outside scope in a risk area');
    await h.train(undefined, false);
    expect(h.outcomes[0]?.stage).toBe('scope');
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.head()).toBe(main);
    expect(h.head('main')).toBe(main);
    const conflict = h.dispatch('README.md');
    await h.start(conflict);
    const dev = h.advanceDev('README.md', 'Integration change\n');
    await h.train(undefined, false);
    expect(h.outcomes[1]?.passed).toBe(true);
    expect(h.store.task(conflict.id).state).toBe('integrated');
    const readme = git(h.root, 'show', 'dev:README.md');
    expect(readme).toContain('Integration change');
    expect(readme).toContain('README.md');
    expect(readFileSync(h.outcomes[1]!.logPath, 'utf8')).toContain('Markdown union: README.md');
    ancestor(h.root, dev, h.head());
    expect(h.head('main')).toBe(main);
    const other = h.dispatch('result.txt');
    await h.start(other);
    const conflictedDev = h.advanceDev('result.txt', 'Integration change\n');
    await h.train(undefined, false);
    expect(h.outcomes[2]?.stage).toBe('rebase');
    expect(h.outcomes[2]?.passed).toBe(false);
    expect(h.outcomes[2]?.conflictedFiles).toContain('result.txt');
    expect(h.head()).toBe(conflictedDev);
    expect(h.head('main')).toBe(main);
  } finally {
    h.dispose();
  }
});

test('new tasks and retries branch from dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const retry = h.dispatch('own');
    await h.start(retry);
    await h.tasks.stop(retry.id);
    const dev = h.advanceDev('dependency');
    const fresh = h.dispatch('fresh');
    await h.job.start(retry.id);
    await h.job.drain();
    expect(h.store.task(fresh.id).base).toBe(dev);
    expect(h.head(fresh.branch)).toBe(dev);
    const resumed = h.store.task(retry.id);
    expect(resumed.currentAttempt).toBe(2);
    ancestor(h.root, dev, h.head(resumed.branch));
    expect(readFileSync(join(resumed.worktree, 'dependency'), 'utf8')).toBe('dependency');
    expect(readFileSync(join(resumed.worktree, 'own'), 'utf8')).toBe('own');
  } finally {
    h.dispose();
  }
});

test('a held task is released when its dependency integrates into dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const first = h.dispatch('dependency');
    const second = h.dispatch('dependent', [first.id]);
    expect(h.store.task(second.id).state).toBe('held');
    await h.start(first);
    await h.train();
    expect(h.store.task(second.id).currentAttempt).toBe(1);
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(second.id).base).toBe(h.head());
    expect(existsSync(join(second.worktree, 'dependency'))).toBe(true);
    expect(h.head('main')).toBe(main);
    expect(h.inbox).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('dev is created from main when missing', async () => {
  const h = integrationHarness();
  try {
    const main = h.head('main');
    expect(git(h.root, 'branch', '--list', 'dev')).toBe('');
    const task = h.dispatch('feature');
    // Branch creation precedes any worker commit, so this checks the exact initial base.
    expect(git(h.root, 'branch', '--list', 'dev').trim()).toBe('dev');
    expect(h.head()).toBe(main);
    expect(h.store.task(task.id).base).toBe(main);
    await h.start(task);
    await h.train();
    ancestor(h.root, main, h.head());
    expect(h.head('main')).toBe(main);
    expect(h.store.task(task.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});

test('promotion gates the dev head and fast-forwards main and marks every task in the batch merged', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha', [], requires('alpha'));
    const second = await h.seed('beta', [], requires('beta'));
    const dev = h.head(),
      main = h.head('main');
    h.settings.gate = requires('README.md');
    const checks: { head: string; command: readonly string[] }[] = [];
    const run = gateRunner();
    await h.promote(async (command, cwd, log) => {
      checks.push({ head: git(cwd, 'rev-parse', 'HEAD'), command });
      return run(command, cwd, log);
    });
    expect(checks).toEqual(
      expect.arrayContaining(
        [h.settings.gate, first.brief.acceptance.command, second.brief.acceptance.command].map((command) => ({
          head: dev,
          command,
        })),
      ),
    );
    expect(h.head('main')).toBe(dev);
    ancestor(h.root, main, dev);
    expect(h.store.task(first.id).state).toBe('merged');
    expect(h.store.task(second.id).state).toBe('merged');
    expect(readFileSync(join(h.root, 'beta'), 'utf8')).toBe('beta');
    expect(git(h.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(h.inbox).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('a failing stabilize candidate stays on dev for a fix without reverting tasks', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad');
    const last = await h.seed('omega');
    const dev = h.head(), main = h.head('main');
    h.settings.gate = failsWith('bad');
    h.settings.promotionParallelism = 2;
    let active = 0,
      peak = 0;
    const checked = new Set<string>();
    const run = gateRunner();
    await h.promote(async (command, cwd, log) => {
      checked.add(git(cwd, 'rev-parse', 'HEAD'));
      peak = Math.max(peak, ++active);
      try {
        return await run(command, cwd, log);
      } finally {
        active--;
      }
    });
    expect(checked).toEqual(new Set([dev]));
    expect(peak).toBe(1);
    expect(peak).toBeLessThanOrEqual(2);
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(main);
    expect(git(h.root, 'show', 'dev:bad')).toBe('bad');
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit, last]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
    expect(h.inbox.map((event) => event.kind)).toEqual(['environment']);
  } finally {
    h.dispose();
  }
});

test('a failing stabilize candidate leaves its dependent tasks integrated pending a fix', async () => {
  const h = integrationHarness();
  try {
    const culprit = await h.seed('bad', [], failsWith('bad'));
    const direct = await h.seed('direct', [culprit.id]);
    const transitive = await h.seed('transitive', [direct.id]);
    const independent = await h.seed('independent');
    const dev = h.head(), main = h.head('main');
    await h.promote();
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(main);
    expect(git(h.root, 'show', 'dev:independent')).toBe('independent');
    for (const dependent of [direct, transitive]) {
      expect(h.store.task(dependent.id).state).toBe('integrated');
      expect(h.store.task(dependent.id).currentAttempt).toBe(1);
      expect(h.store.task(dependent.id).brief.after).toEqual(dependent.brief.after);
    }
    expect(h.store.task(independent.id).state).toBe('integrated');
    expect(h.store.task(culprit.id).currentAttempt).toBe(1);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally {
    h.dispose();
  }
});

test('a promotion failure that main shares is an environment failure and reverts nothing', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const second = await h.seed('beta');
    const dev = h.head(),
      main = h.head('main');
    h.settings.gate = ['bun', '-e', "console.error('AssertionError: service unavailable'); process.exit(1)"];
    await h.promote();
    expect(h.head()).toBe(dev);
    expect(h.head('main')).toBe(main);
    for (const task of [first, second]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
    expect(h.inbox.map((event) => event.kind)).toContain('environment');
    expect(git(h.root, 'log', '--format=%s', `${main}..dev`)).not.toContain('Revert');
  } finally {
    h.dispose();
  }
});

test('a goal with integrated tasks is still in flight and completion is judged on main', async () => {
  const h = integrationHarness();
  try {
    const integrated = await h.seed('integrated');
    const last = h.dispatch('last');
    await h.start(last);
    // A terminal sibling exercises the existing dependency-aware goal-idle notification.
    h.store.updateTask({ taskId: last.id, attempt: 1 }, (task) => {
      task.brief.after = [integrated.id];
    });
    const check = completionChecker({
      ...h.settings,
      condition: () => ({ taskIds: h.tasks.completionScope('fixture'), gate: requires('integrated') }),
      mergedTasks: async () =>
        new Set(
          h.store
            .tasks()
            .filter((task) => task.state === 'merged')
            .map((task) => task.id),
        ),
    });
    expect((await check('fixture')).passed).toBe(false);
    h.job.onGateOutcome({
      taskId: last.id,
      attempt: 1,
      passed: true,
      stage: 'merge',
      mergedCommit: h.head('main'),
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: ['last'],
      diffLines: 1,
    });
    await h.job.drain();
    expect(h.inbox.filter((event) => event.kind === 'goal-idle')).toEqual([]);
    // Even a merged state cannot make a dev-only feature pass the completion gate on main.
    h.store.updateTask({ taskId: integrated.id, attempt: 1 }, (task) => {
      task.state = 'merged';
    });
    expect((await check('fixture')).passed).toBe(false);
    git(h.root, 'merge', '--ff-only', 'dev');
    expect((await check('fixture')).passed).toBe(true);
  } finally {
    h.dispose();
  }
});

test("a landing that changes another Goal's declared file tells that Goal; a file of its own Goal tells no one", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const owner = h.dispatch('owned.txt');
    h.store.updateTask({ taskId: owner.id, attempt: 0 }, (task) => {
      task.brief.goal = 'other';
      task.brief.manager = 'other';
    });
    h.dispatch('mine.txt');
    const task = h.dispatch('feature');
    await h.start(task);
    for (const file of ['owned.txt', 'mine.txt'])
      writeFileSync(join(task.worktree, file), 'changed outside the declared paths');
    git(task.worktree, 'add', 'owned.txt', 'mine.txt');
    git(task.worktree, 'commit', '-qm', 'Outside changes');
    await h.train(undefined, false);
    expect(h.store.task(task.id).state).toBe('integrated');
    const told = h.store.db
      .query("SELECT manager, json_extract(event, '$.summary') AS summary FROM manager_inbox")
      .all() as { manager: string; summary: string }[];
    const notices = told.filter((event) => event.summary.includes('changed files your tasks declare'));
    expect(notices.map((event) => event.manager)).toEqual(['other']);
    expect(notices[0]!.summary).toContain('owned.txt');
    expect(notices[0]!.summary).not.toContain('mine.txt');
  } finally {
    h.dispose();
  }
});
