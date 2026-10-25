import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('integration refuses a branch that adds nothing beyond its base and does not release its dependents', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature');
    await h.start(task);
    // The worker's commit is undone, as when a worker leaves its work staged but uncommitted.
    git(h.store.task(task.id).worktree, 'reset', '--soft', h.head());
    const dependent = h.dispatch('next', [task.id]);
    const devBefore = h.head();
    await h.train(async () => ({ passed: true, output: '', timedOut: false }));
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.head()).toBe(devBefore);
    expect(h.store.task(dependent.id).state).toBe('held');
  } finally { h.dispose(); }
});
