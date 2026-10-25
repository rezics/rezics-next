import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
const merged = (taskId: string, commit: string): GateOutcome => ({ taskId, attempt: 1, passed: true, stage: 'merge',
  mergedCommit: commit, logPath: 'fixture', hostMs: 1, changedFiles: ['dependency.txt'], diffLines: 1 });

test('a retry whose reshaped brief waits for an unmerged task holds, keeps its commits, and resumes on main after the merge', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id); await job.drain();
    await h.tasks.stop(task.id);
    const own = git(h.store.task(task.id).worktree, 'rev-parse', 'HEAD');
    const dependency = h.tasks.dispatch(h.briefFile);
    const reshaped = join(h.root, '.temp/goal/reshaped.md');
    writeFileSync(reshaped, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    await job.start(task.id, { brief: reshaped }); await job.drain();
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(git(h.store.task(task.id).worktree, 'rev-parse', 'HEAD')).toBe(own);

    await job.start(dependency.id); await job.drain();
    writeFileSync(join(h.root, 'dependency.txt'), 'merged\n');
    git(h.root, 'add', 'dependency.txt'); git(h.root, 'commit', '-qm', 'Merge the dependency');
    const main = git(h.root, 'rev-parse', 'main');
    job.onGateOutcome(merged(dependency.id, main)); await job.drain();

    const resumed = h.store.task(task.id);
    expect(resumed.currentAttempt).toBe(2);
    expect(resumed.base).toBe(main);
    expect(existsSync(join(resumed.worktree, 'dependency.txt'))).toBe(true);
    expect(spawnSync('git', ['merge-base', '--is-ancestor', main, 'HEAD'], { cwd: resumed.worktree }).status).toBe(0);
    expect(git(resumed.worktree, 'log', '--format=%s', `${main}..HEAD`)).toContain('Complete fixture');
  } finally { h.dispose(); }
});
