import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp', { recursive: true });
const launchCount = existsSync('.temp/launch-count') ? Number(readFileSync('.temp/launch-count', 'utf8')) + 1 : 1;
writeFileSync('.temp/launch-count', String(launchCount));
writeFileSync('.temp/launch-' + launchCount + '-args', JSON.stringify(process.argv));
writeFileSync('.temp/attempt-head', spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim());
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session-' + launchCount}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

function delayGitStatusOnce(h: ReturnType<typeof harness>) {
  const oldPath = process.env.PATH, oldQueue = process.env.REZICS_TEST_CAPACITY_QUEUE;
  const oldTimeout = h.settings.policy!.merge.commandTimeoutMs, bin = join(h.root, '.temp', 'slow-git');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ] && [ ! -e "$PWD/.temp/status-timeout" ]; then
  touch "$PWD/.temp/status-timeout"; echo $$ > "$PWD/.temp/status-pid"
  find "$REZICS_TEST_CAPACITY_QUEUE" -maxdepth 1 -type f -print > "$PWD/.temp/status-ticket-seen"
  exec /usr/bin/env bun -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)'
fi
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.REZICS_TEST_CAPACITY_QUEUE = join(h.settings.stateDirectory, 'capacity-queue');
  h.settings.policy!.merge.commandTimeoutMs = 750;
  return {
    restore: () => {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldQueue === undefined) delete process.env.REZICS_TEST_CAPACITY_QUEUE; else process.env.REZICS_TEST_CAPACITY_QUEUE = oldQueue;
      h.settings.policy!.merge.commandTimeoutMs = oldTimeout;
    },
  };
}

async function runAndStop(h: ReturnType<typeof harness>, job: WorkerJob, taskId: string): Promise<void> {
  await job.start(taskId);
  await job.drain();
  await h.tasks.stop(taskId);
}

test('a retry commits stopped attempt leftovers before rebasing and starts on current dev', async () => {
  const h = harness(recordingCli);
  try {
    git(h.root, 'branch', 'dev', 'main');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await runAndStop(h, job, task.id);

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
    await runAndStop(h, job, task.id);

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

test('proof remains fail closed and genuine leftover Git errors keep their task diagnosis', async () => {
  const h = harness(recordingCli);
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    const proof = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: proof.id, attempt: 0 }, (current) => {
      current.brief = { ...current.brief, kind: 'verification' };
    });
    await expect(h.tasks.retry(proof.id)).rejects.toThrow();
    expect(h.store.task(proof.id).currentAttempt).toBe(0);
    expect(h.store.events(proof.id).some((event) => event.kind === 'retry-setup-failed')).toBe(false);

    h.settings.integration.operationsManager = 'operations';
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, inbox);
    const task = h.tasks.dispatch(h.briefFile);
    await runAndStop(h, job, task.id);
    h.store.recordExplicitRetry({ taskId: task.id, attempt: 1 }, () => {}, { evidence: h.briefFile });

    const corruptIndex = join(h.root, '.temp', 'corrupt-index');
    writeFileSync(corruptIndex, 'broken index');
    process.env.GIT_INDEX_FILE = corruptIndex;
    await expect(h.tasks.retry(task.id)).rejects.toThrow('git status:');

    expect([h.store.task(task.id).currentAttempt, h.store.attempts(task.id).length]).toEqual([1, 1]);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toMatchObject({
      status: 'pending', options: { evidence: h.briefFile },
    });
    const failure = JSON.parse(h.store.events(task.id, 1).find((event) => event.kind === 'retry-setup-failed')!.body);
    expect(failure).toMatchObject({
      step: 'checking worktree leftovers',
      diagnostic: { commandText: 'git status --porcelain=v1 --untracked-files=normal', timedOut: false },
    });
    expect(failure.diagnostic.message).toContain('index file smaller than expected');
    expect(inbox.pending(task.brief.manager).map((entry) => entry.event.kind)).toContain('environment');
    expect(inbox.pending('operations')).toHaveLength(0);
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    h.dispose();
  }
});

test('a timed-out leftover inspection retains its durable retry and folds one shared action across host restarts', async () => {
  const h = harness(recordingCli);
  let delayed: ReturnType<typeof delayGitStatusOnce> | undefined;
  try {
    h.settings.integration.operationsManager = 'operations';
    h.settings.policy!.host.recoveryIntervalMs = 300;
    h.settings.policy!.worker.retryIntentLeadMs = 300;
    h.settings.policy!.worker.capacityPauseMs = 300;
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const firstJob = new WorkerJob(h.tasks, { enqueue() {} }, inbox);
    const restartedHost = () =>
      new WorkerJob(
        h.tasks,
        { enqueue() {} },
        new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory),
      );
    const tasks = [h.tasks.dispatch(h.briefFile), h.tasks.dispatch(h.briefFile)];
    for (const task of tasks) {
      await runAndStop(h, firstJob, task.id);
      const worktree = h.store.task(task.id).worktree;
      writeFileSync(join(worktree, 'README.md'), `staged source ${task.id}\n`);
      git(worktree, 'add', 'README.md');
      writeFileSync(join(worktree, 'scripts/typecheck.ts'), `export const source = '${task.id}';\n`);
      mkdirSync(join(worktree, 'product', 'nested'), { recursive: true });
      writeFileSync(join(worktree, 'product', 'nested', 'source.ts'), `export const source = '${task.id}';\n`);
      h.store.recordExplicitRetry({ taskId: task.id, attempt: 1 }, () => {}, { evidence: h.briefFile });
    }
    delayed = delayGitStatusOnce(h);

    for (const [index, task] of tasks.entries()) {
      const hostRestart = restartedHost();
      await hostRestart.runHostTask('retry', task.id);
      if (index === 0) await hostRestart.runHostTask('retry', task.id);
      const worktree = h.store.task(task.id).worktree;
      const intent = h.store.retryIntent({ taskId: task.id, attempt: 1 });
      expect([h.store.task(task.id).currentAttempt, h.store.attempts(task.id).length]).toEqual([1, 1]);
      expect(intent).toMatchObject({ status: 'pending', options: { evidence: h.briefFile } });
      expect(Date.parse(intent!.options.notBefore ?? '')).toBeGreaterThan(Date.now());
      expect(h.store.events(task.id, 1).some((event) => event.kind === 'launch-failed')).toBe(false);
      const failure = JSON.parse(
        h.store.events(task.id, 1).find((event) => event.kind === 'retry-setup-failed')!.body,
      );
      expect(failure).toMatchObject({
        step: 'checking worktree leftovers',
        diagnostic: {
          operation: 'git status',
          commandText: 'git status --porcelain=v1 --untracked-files=normal',
          errorCode: 'ETIMEDOUT',
          timedOut: true,
          timeoutMs: 750,
          signal: 'SIGTERM',
        },
      });
      expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('README.md');
      expect(git(worktree, 'diff', '--name-only')).toBe('scripts/typecheck.ts');
      expect(git(worktree, 'ls-files', '--others', '--exclude-standard')).toBe('product/nested/source.ts');
      const pid = Number(readFileSync(join(worktree, '.temp/status-pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readFileSync(join(worktree, '.temp/status-ticket-seen'), 'utf8')).toContain(task.id);
      const queue = join(h.settings.stateDirectory, 'capacity-queue');
      expect(existsSync(queue) ? readdirSync(queue).filter((name) => name.includes(task.id)) : []).toEqual([]);
    }
    const operationalAlerts = inbox.pending('operations');
    expect(operationalAlerts).toHaveLength(1);
    expect(operationalAlerts[0]).toMatchObject({
      deliveries: 2,
      event: { summary: expect.stringContaining('Investigate shared host I/O pressure') },
    });
    expect(inbox.pending(h.settings.integration.supermanager)).toHaveLength(0);
    expect(
      tasks.every((task) => readFileSync(join(h.store.task(task.id).worktree, '.temp/launch-count'), 'utf8') === '1'),
    ).toBe(true);

    const resumedHost = restartedHost();
    await new Promise((resolve) => setTimeout(resolve, 650));
    resumedHost.resumePendingRetries();
    await resumedHost.drain();
    for (const task of tasks) {
      const worktree = h.store.task(task.id).worktree;
      expect(h.store.task(task.id).currentAttempt).toBe(2);
      expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toMatchObject({
        status: 'started', nextAttempt: 2, options: { evidence: h.briefFile },
      });
      expect(readFileSync(join(worktree, '.temp/launch-count'), 'utf8')).toBe('2');
      expect(readFileSync(join(worktree, '.temp/launch-2-args'), 'utf8')).toContain('fixture-session-1');
      expect(git(worktree, 'show', 'HEAD:README.md')).toBe(`staged source ${task.id}`);
      expect(git(worktree, 'show', 'HEAD:scripts/typecheck.ts')).toBe(`export const source = '${task.id}';`);
      expect(git(worktree, 'show', 'HEAD:product/nested/source.ts')).toBe(`export const source = '${task.id}';`);
    }
    expect(inbox.pending('operations')).toHaveLength(1);
    expect(inbox.pending('operations')[0]!.deliveries).toBe(2);
  } finally {
    delayed?.restore();
    h.dispose();
  }
}, 15_000);

test('a retry aborts a conflicted rebase that the stopped attempt left in its worktree', async () => {
  const h = harness(recordingCli);
  try {
    git(h.root, 'branch', 'dev', 'main');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await runAndStop(h, job, task.id);

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
