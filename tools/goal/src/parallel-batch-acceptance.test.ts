import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('batch member acceptance runs concurrently in separate worktrees at the final batch candidate', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const first = h.dispatch('parallel-first.ts');
    const second = h.dispatch('parallel-second.ts');
    await h.start(first);
    await h.start(second);
    const starts: Array<{ cwd: string; head: string; tree: string; files: string[] }> = [];
    let running = 0;
    let peak = 0;

    await h.train(async (_command, cwd) => {
      running++;
      peak = Math.max(peak, running);
      starts.push({
        cwd,
        head: git(cwd, 'rev-parse', 'HEAD'),
        tree: git(cwd, 'rev-parse', 'HEAD^{tree}'),
        files: ['parallel-first.ts', 'parallel-second.ts'].filter((file) => existsSync(join(cwd, file))),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return { passed: true, output: '', timedOut: false };
    });

    expect(peak).toBe(2);
    expect(new Set(starts.map(({ cwd }) => cwd)).size).toBe(2);
    expect(new Set(starts.map(({ head }) => head)).size).toBe(1);
    expect(starts.every(({ files }) => files.length === 2)).toBe(true);
    expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});

test('a passing batch publishes every member through one dev update', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const first = h.dispatch('atomic-first.ts');
    const second = h.dispatch('atomic-second.ts');
    await h.start(first);
    await h.start(second);

    await h.train(async () => ({ passed: true, output: '', timedOut: false }));

    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
    expect(git(h.root, 'show', 'dev:atomic-first.ts')).toBe('atomic-first.ts');
    expect(git(h.root, 'show', 'dev:atomic-second.ts')).toBe('atomic-second.ts');
    expect(git(h.root, 'rev-parse', 'dev')).toBe(h.outcomes[1]?.mergedCommit);
    expect(git(h.root, 'merge-base', '--is-ancestor', h.outcomes[0]!.mergedCommit!, 'dev')).toBe('');
  } finally {
    h.dispose();
  }
});

test('a failed final-candidate acceptance falls back and is attributed to that member', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const passing = h.dispatch('acceptance-pass.ts', [], ['pass-command']);
    const failing = h.dispatch('acceptance-fail.ts', [], ['fail-command']);
    await h.start(passing);
    await h.start(failing);
    let batchRuns = 0;

    await h.train(async (command, cwd) => {
      if (existsSync(join(cwd, 'acceptance-fail.ts'))) batchRuns++;
      return command[0] === 'fail-command'
        ? { passed: false, output: 'AssertionError: broken member', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    });

    expect(batchRuns).toBeGreaterThan(1);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [passing.id, true],
      [failing.id, false],
    ]);
    expect(h.outcomes.find(({ taskId }) => taskId === failing.id)?.firstFailure?.assertion).toContain(
      'AssertionError: broken member',
    );
    expect(git(h.root, 'show', 'dev:acceptance-pass.ts')).toBe('acceptance-pass.ts');
    expect(() => git(h.root, 'show', 'dev:acceptance-fail.ts')).toThrow();
  } finally {
    h.dispose();
  }
});

test('batch acceptance concurrency respects its configured limit', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchAcceptanceConcurrency = 2;
    const members = ['limited-a.ts', 'limited-b.ts', 'limited-c.ts', 'limited-d.ts'].map((file) => h.dispatch(file));
    for (const member of members) await h.start(member);
    let running = 0;
    let peak = 0;

    await h.train(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return { passed: true, output: '', timedOut: false };
    });

    expect(peak).toBe(2);
    expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true, true, true]);
  } finally {
    h.dispose();
  }
});
