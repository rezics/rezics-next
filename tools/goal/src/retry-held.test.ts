import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
const merged = (taskId: string, commit: string): GateOutcome => ({ taskId, attempt: 1, passed: true, stage: 'merge',
  mergedCommit: commit, logPath: 'fixture', hostMs: 1, changedFiles: ['dependency.txt'], diffLines: 1 });

test('a retry whose reshaped brief waits for an unintegrated task holds, keeps its commits, and resumes on dev after integration', async () => {
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
    const main = git(h.root, 'rev-parse', 'main'), oldDev = git(h.root, 'rev-parse', 'dev');
    git(h.root, 'update-ref', 'refs/heads/dev', main, oldDev);
    const dev = git(h.root, 'rev-parse', 'dev');
    job.onGateOutcome(merged(dependency.id, dev)); await job.drain();

    const resumed = h.store.task(task.id);
    expect(resumed.currentAttempt).toBe(2);
    expect(resumed.base).toBe(dev);
    expect(existsSync(join(resumed.worktree, 'dependency.txt'))).toBe(true);
    expect(spawnSync('git', ['merge-base', '--is-ancestor', dev, 'HEAD'], { cwd: resumed.worktree }).status).toBe(0);
    expect(git(resumed.worktree, 'log', '--format=%s', `${dev}..HEAD`)).toContain('Complete fixture');
  } finally { h.dispose(); }
});

test('a task stopped after its worker exited can be held behind an unmerged task', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id); await job.drain();
    // A worker that reports itself blocked leaves its attempt exited and the task stopped.
    h.store.updateTask({ taskId: task.id, attempt: 1 }, t => { t.state = 'stopped'; });
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('exited');
    const dependency = h.tasks.dispatch(h.briefFile);
    const reshaped = join(h.root, '.temp/goal/reshaped.md');
    writeFileSync(reshaped, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    await job.start(task.id, { brief: reshaped }); await job.drain();
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
  } finally { h.dispose(); }
});

test('a stopped task retried after its dependencies integrate starts from a base that contains them', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const dependency = h.tasks.dispatch(h.briefFile);
    const waiting = join(h.root, '.temp/goal/waiting.md');
    writeFileSync(waiting, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    const task = h.tasks.dispatch(waiting);
    expect(h.store.task(task.id).state).toBe('held');
    h.store.updateTask({ taskId: task.id, attempt: 0 }, t => { t.state = 'stopped'; });
    await job.start(dependency.id); await job.drain();
    const oldDev = git(h.root, 'rev-parse', 'dev');
    const tree = join(h.root, '.temp/goal/dev-integration');
    mkdirSync(join(h.root, '.temp/goal'), { recursive: true });
    git(h.root, 'worktree', 'add', '--detach', tree, oldDev);
    try {
      writeFileSync(join(tree, 'dependency.txt'), 'integrated\n');
      git(tree, 'add', 'dependency.txt'); git(tree, 'commit', '-qm', 'Integrate the dependency');
      const dev = git(tree, 'rev-parse', 'HEAD');
      git(h.root, 'update-ref', 'refs/heads/dev', dev, oldDev);
      job.onGateOutcome(merged(dependency.id, dev)); await job.drain();
      expect(h.store.task(dependency.id).state).toBe('integrated');
      expect(h.store.task(task.id).state).toBe('stopped');

      await job.start(task.id, { brief: waiting }); await job.drain();
      const started = h.store.task(task.id);
      expect(started.currentAttempt).toBe(1);
      expect(started.base).toBe(dev);
      expect(existsSync(join(started.worktree, 'dependency.txt'))).toBe(true);
      expect(spawnSync('git', ['merge-base', '--is-ancestor', dev, 'HEAD'], { cwd: started.worktree }).status).toBe(0);
    } finally { git(h.root, 'worktree', 'remove', '--force', tree); }
  } finally { h.dispose(); }
});

test('a held task accepts a reshaped brief and stays held while its dependency is unmerged', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const dependency = h.tasks.dispatch(h.briefFile);
    const waiting = join(h.root, '.temp/goal/waiting.md');
    writeFileSync(waiting, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    const task = h.tasks.dispatch(waiting);
    expect(h.store.task(task.id).state).toBe('held');
    const reshaped = join(h.root, '.temp/goal/reshaped.md');
    writeFileSync(reshaped, `${markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)}\nCost: one point read.\n`);
    await job.start(task.id, { brief: reshaped }); await job.drain();
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).currentAttempt).toBe(0);
    expect(h.store.task(task.id).brief.markdown).toContain('Cost: one point read.');
  } finally { h.dispose(); }
});

test('a reshape that only records a held contract does not wait for host capacity', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id); await job.drain();
    await h.tasks.stop(task.id);
    // A host with no free worker slot.
    writeFileSync(join(h.tasks.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));
    const dependency = h.tasks.dispatch(h.briefFile);
    const reshaped = join(h.root, '.temp/goal/reshaped.md');
    writeFileSync(reshaped, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    await Promise.race([
      job.start(task.id, { brief: reshaped }).then(() => job.drain()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('waited for host capacity')), 10_000)),
    ]);
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).brief.markdown).toContain(dependency.id);
  } finally { h.dispose(); }
});
