import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('a dependent starts from dev when its dependency landed after dev-verified, and has the dependency code', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const verifiedBefore = h.head();
    git(h.root, 'update-ref', 'refs/heads/dev-verified', verifiedBefore);
    const dependency = await h.seed('dependency-file');
    h.store.updateTask({ taskId: dependency.id, attempt: h.store.task(dependency.id).currentAttempt }, (current) => {
      current.integratedCommit = h.head();
    });
    const dependent = h.dispatch('dependent-file', [dependency.id], ['true']);
    await h.start(dependent);

    const started = h.store.task(dependent.id);
    expect(git(h.root, 'merge-base', '--is-ancestor', h.store.task(dependency.id).integratedCommit!, started.base)).toBe('');
    expect(existsSync(join(started.worktree, 'dependency-file'))).toBe(true);
  } finally {
    h.dispose();
  }
});

test('a dependent whose dependencies are all verified starts from dev-verified', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dependency = await h.seed('dependency-file');
    h.store.updateTask({ taskId: dependency.id, attempt: h.store.task(dependency.id).currentAttempt }, (current) => {
      current.integratedCommit = h.head();
    });
    git(h.root, 'update-ref', 'refs/heads/dev-verified', h.head());
    const verified = h.head();
    h.advanceDev('unverified-change');
    const dependent = h.dispatch('dependent-file', [dependency.id], ['true']);
    await h.start(dependent);

    expect(h.store.task(dependent.id).base).toBe(verified);
  } finally {
    h.dispose();
  }
});
