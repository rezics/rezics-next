import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
const merged = (taskId: string, commit: string): GateOutcome => ({ taskId, attempt: 1, passed: true, stage: 'merge',
  mergedCommit: commit, logPath: 'fixture', hostMs: 1, changedFiles: ['result.txt'], diffLines: 1 });

test('a held task starts from dev after its dependency integrates there', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(secondBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${first.id}]`));
    const second = h.tasks.dispatch(secondBrief);
    await job.start(first.id);
    // Simulate the dependency being integrated into dev after the second task was dispatched.
    writeFileSync(join(h.root, 'dependency.txt'), 'merged\n');
    git(h.root, 'add', 'dependency.txt'); git(h.root, 'commit', '-qm', 'Merge the dependency');
    const main = git(h.root, 'rev-parse', 'main'), oldDev = git(h.root, 'rev-parse', 'dev');
    git(h.root, 'update-ref', 'refs/heads/dev', main, oldDev);
    const dev = git(h.root, 'rev-parse', 'dev');
    job.onGateOutcome(merged(first.id, dev)); await job.drain();
    const released = h.store.task(second.id);
    expect(released.currentAttempt).toBe(1);
    expect(released.base).toBe(dev);
    expect(existsSync(join(released.worktree, 'dependency.txt'))).toBe(true);
  } finally { h.dispose(); }
});
