import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { harness } from './test-support.ts';

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};

const recordingCli = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp', { recursive: true });
writeFileSync('.temp/attempt-head', spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim());
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('a retry commits stopped attempt leftovers before rebasing and starts on current dev', async () => {
  const h = harness(recordingCli);
  try {
    git(h.root, 'branch', 'dev', 'main');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    await job.drain();
    await h.tasks.stop(task.id);

    const worktree = h.store.task(task.id).worktree;
    writeFileSync(join(worktree, 'README.md'), 'leftover tracked change\n');
    writeFileSync(join(worktree, 'leftover.txt'), 'leftover untracked change\n');
    mkdirSync(join(h.root, '.temp', 'dev-change'), { recursive: true });
    const devTree = join(h.root, '.temp', 'dev-change');
    git(h.root, 'worktree', 'add', '--detach', devTree, 'dev');
    writeFileSync(join(devTree, 'dev.txt'), 'current dev\n');
    git(devTree, 'add', 'dev.txt');
    git(devTree, 'commit', '-m', 'Advance dev');
    const oldDev = git(h.root, 'rev-parse', 'dev');
    const currentDev = git(devTree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/dev', currentDev, oldDev);
    git(h.root, 'worktree', 'remove', '--force', devTree);

    await job.start(task.id);
    await job.drain();

    const retried = h.store.task(task.id);
    expect(retried.currentAttempt).toBe(2);
    expect(retried.base).toBe(currentDev);
    expect(git(worktree, 'log', '--format=%s', `${currentDev}..HEAD`)).toContain('wip: leftovers from attempt 1');
    const startedAt = (await Bun.file(join(worktree, '.temp', 'attempt-head')).text()).trim();
    expect(git(worktree, 'show', `${startedAt}:README.md`)).toBe('leftover tracked change');
    expect(git(worktree, 'show', `${startedAt}:leftover.txt`)).toBe('leftover untracked change');
    expect(
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', currentDev, startedAt], { cwd: worktree }).exitCode,
    ).toBe(0);
  } finally {
    h.dispose();
  }
});

test('a retry setup failure reports an environment event to the owning manager', async () => {
  const h = harness();
  try {
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, inbox);
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    await job.drain();
    await h.tasks.stop(task.id);

    h.settings.integrationBranch = 'invalid branch name';
    await expect(job.start(task.id)).rejects.toThrow();

    expect(h.store.events(task.id).some((event) => event.kind === 'launch-failed')).toBe(true);
    const events = inbox.pending(task.brief.manager).map((entry) => entry.event);
    expect(events).toHaveLength(1);
    expect(events[0]!.managerId).toBe(task.brief.manager);
    expect(events[0]!.kind).toBe('environment');
    expect(events[0]!.summary).toContain('retry setup');
    expect(events[0]!.summary).toContain('invalid branch name');
  } finally {
    h.dispose();
  }
});

test('a retry aborts a conflicted rebase that the stopped attempt left in its worktree', async () => {
  const h = harness(recordingCli);
  try {
    git(h.root, 'branch', 'dev', 'main');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    await job.drain();
    await h.tasks.stop(task.id);

    const worktree = h.store.task(task.id).worktree;
    const otherTree = join(h.root, '.temp', 'other');
    git(h.root, 'worktree', 'add', '-b', 'other', otherTree, 'main');
    writeFileSync(join(otherTree, 'result.txt'), 'conflicting\n');
    git(otherTree, 'add', 'result.txt');
    git(otherTree, 'commit', '-m', 'Conflict with the task');
    git(h.root, 'worktree', 'remove', '--force', otherTree);
    expect(Bun.spawnSync(['git', 'rebase', 'other'], { cwd: worktree }).exitCode).not.toBe(0);
    expect(git(worktree, 'branch', '--show-current')).toBe('');

    await job.start(task.id);
    await job.drain();

    const retried = h.store.task(task.id);
    expect(retried.currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).failureKind ?? null).toBeNull();
    expect(git(worktree, 'branch', '--show-current')).toBe(task.branch);
    expect(git(worktree, 'show', 'HEAD:result.txt')).toBe('accepted');
  } finally {
    h.dispose();
  }
});
