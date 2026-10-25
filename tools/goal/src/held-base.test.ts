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

test('a held task starts from the main that contains the work it waited for', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(secondBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${first.id}]`));
    const second = h.tasks.dispatch(secondBrief);
    await job.start(first.id);
    // The train merged the first task, so main moved on after the second task was dispatched.
    writeFileSync(join(h.root, 'dependency.txt'), 'merged\n');
    git(h.root, 'add', 'dependency.txt'); git(h.root, 'commit', '-qm', 'Merge the dependency');
    const main = git(h.root, 'rev-parse', 'main');
    job.onGateOutcome(merged(first.id, main)); await job.drain();
    const released = h.store.task(second.id);
    expect(released.currentAttempt).toBe(1);
    expect(released.base).toBe(main);
    expect(existsSync(join(released.worktree, 'dependency.txt'))).toBe(true);
  } finally { h.dispose(); }
});
