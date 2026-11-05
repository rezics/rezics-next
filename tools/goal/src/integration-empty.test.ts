import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('integration commits staged or uncommitted worker changes with no commit beyond the base', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    for (const mode of ['--soft', '--mixed'] as const) {
      const file = `worker-${mode.slice(2)}.txt`;
      const task = h.dispatch(file);
      await h.start(task);
      git(task.worktree, 'reset', mode, h.head());
      await h.train();
      expect(h.outcomes.at(-1)?.passed).toBe(true);
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
      expect(git(h.root, 'show', `dev:${file}`)).toBe(file);
    }
  } finally {
    h.dispose();
  }
});

test('ignored paths are dropped unless the brief declares them', async () => {
  const h = integrationHarness();
  try {
    writeFileSync(join(h.root, '.gitignore'), '.temp/\nignored.txt\n');
    git(h.root, 'add', '.gitignore');
    git(h.root, 'commit', '-m', 'Ignore fixture output');
    h.ensureDev();

    const undeclared = h.dispatch('kept.txt');
    await h.start(undeclared);
    writeFileSync(join(undeclared.worktree, 'ignored.txt'), 'drop me');
    git(undeclared.worktree, 'add', '-f', 'ignored.txt');
    git(undeclared.worktree, 'reset', '--soft', h.head());
    await h.train();
    expect(h.outcomes.at(-1)?.passed).toBe(true);
    expect(git(h.root, 'show', 'dev:kept.txt')).toBe('kept.txt');
    expect(() => git(h.root, 'show', 'dev:ignored.txt')).toThrow();

    const declared = h.dispatch('ignored.txt');
    await h.start(declared);
    expect(git(declared.worktree, 'rev-parse', 'HEAD')).toBe(h.head());
    await h.train();
    expect(h.outcomes.at(-1)?.passed).toBe(true);
    expect(git(h.root, 'show', 'dev:ignored.txt')).toBe('ignored.txt');
  } finally {
    h.dispose();
  }
});

test('a change already present on dev integrates without retrying the worker', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('result.txt');
    await h.start(task);
    const dev = h.advanceDev('result.txt', 'result.txt');

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(true);
    expect(outcome.stage).toBe('merge');
    expect(outcome.mergedCommit).toBe(dev);
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.task(task.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});

test('a partial batch member keeps its effective change and the prior sibling before publishing', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.batchSize = 2;
    h.settings.integration.devLandingChecks = false;
    h.ensureDev();
    const sibling = h.dispatch('sibling.txt');
    await h.start(sibling);

    const targetPath = 'target.txt';
    const effectivePath = 'effective.txt';
    const partial = h.dispatch(targetPath);
    writeFileSync(join(partial.worktree, effectivePath), 'worker effective change');
    git(partial.worktree, 'add', '--', effectivePath);
    git(partial.worktree, 'commit', '-qm', 'Add effective sibling file');
    await h.start(partial);
    h.advanceDev(targetPath, targetPath);

    await h.train();

    const siblingOutcome = h.outcomes.find((outcome) => outcome.taskId === sibling.id)!;
    const partialOutcome = h.outcomes.find((outcome) => outcome.taskId === partial.id)!;
    expect(siblingOutcome.passed).toBe(true);
    expect(partialOutcome.passed).toBe(true);
    expect(partialOutcome.mergedCommit).toBe(siblingOutcome.mergedCommit);
    expect(partialOutcome.mergedCommit).toBe(git(h.root, 'rev-parse', 'refs/heads/dev'));
    expect(h.store.task(sibling.id)).toMatchObject({ state: 'integrated', integratedCommit: partialOutcome.mergedCommit });
    expect(h.store.task(partial.id)).toMatchObject({ state: 'integrated', integratedCommit: partialOutcome.mergedCommit });
    expect(git(h.root, 'show', 'dev:sibling.txt')).toBe('sibling.txt');
    expect(git(h.root, 'show', 'dev:target.txt')).toBe('target.txt');
    expect(git(h.root, 'show', 'dev:effective.txt')).toBe('worker effective change');
  } finally {
    h.dispose();
  }
}, 60_000);
