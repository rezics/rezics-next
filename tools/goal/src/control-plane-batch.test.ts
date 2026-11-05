import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { MergeTrain, type IntegrationCheck } from './merge-train.ts';
import { integrationHarness } from './test-support.ts';

test('a batched landing removes its train-batch candidate tree', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    (h.settings as typeof h.settings & { integrationChecks: IntegrationCheck[] }).integrationChecks = [
      { paths: ['**'], command: ['true'] },
    ];
    const first = h.dispatch('batch-a.ts');
    const second = h.dispatch('batch-b.ts');
    await h.start(first);
    await h.start(second);
    await h.train(async () => ({ passed: true, output: '', timedOut: false }));
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
    expect(git(h.root, 'worktree', 'list', '--porcelain')).not.toContain('train-batch-');
    expect(readdirSync(h.settings.worktreeRoot).some((name) => name.startsWith('train-batch-'))).toBe(false);
    expect(existsSync(first.worktree)).toBe(true);
  } finally {
    h.dispose();
  }
}, 60_000);
