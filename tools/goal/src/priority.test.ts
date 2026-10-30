import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StaleAttemptError } from './contracts.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { harness, markdown } from './test-support.ts';

function runtimeFor(h: ReturnType<typeof harness>) {
  return { settings: h.settings, db: h.store.db, store: h.store, tasks: h.tasks, drain: async () => {} } as never;
}

function addManager(
  db: ReturnType<typeof harness>['store']['db'],
  id: string,
  sessionId: string,
  supermanager: string,
) {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get())
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT OR REPLACE INTO manager_sessions (id, state) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, status: 'running', threadId: sessionId, supermanager }),
  );
}

test('Held task with stopped attempt and pending retry can be demoted without stale-attempt error or changing its retry identity', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.tasks.setPriority(task.id, 'critical');
    h.tasks.queueRetry(task.id);
    h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
      current.state = 'held';
    });
    h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (attempt) => {
      attempt.state = 'stopped';
    });

    const before = h.store.task(task.id);
    const attemptBefore = h.store.attempt({ taskId: task.id, attempt: 1 });
    const retryBefore = h.store.retryIntent({ taskId: task.id, attempt: 1 });
    const leasePath = join(h.settings.stateDirectory, 'leases', task.id);
    const leaseExisted = existsSync(leasePath);
    const retryFile = join(before.worktree, '.temp/goal/task-priority');
    expect(retryBefore?.status).toBe('pending');
    expect(readText(retryFile)).toBe('critical\n');

    addManager(h.store.db, before.brief.manager, 'owner-session', 'supermanager');
    await runWorkerCommand('priority', [task.id, 'normal'], {
      runtime: runtimeFor(h),
      env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: before.brief.manager },
    });

    const after = h.store.task(task.id);
    expect(after.state).toBe('held');
    expect(after.sequence).toBe(before.sequence);
    expect(after.currentAttempt).toBe(before.currentAttempt);
    expect(after.brief.markdown).toBe(before.brief.markdown);
    expect(after.brief.criticalPath).toBe(false);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 })).toEqual(attemptBefore);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toEqual(retryBefore);
    expect(existsSync(leasePath)).toBe(leaseExisted);
    expect(readText(retryFile)).toBe('normal\n');
  } finally {
    h.dispose();
  }
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

test('critical dispatch and retry brief escalation require the authenticated supermanager grant flow', async () => {
  const h = harness();
  try {
    const criticalDispatch = join(h.root, '.temp/goal/critical-dispatch.md');
    writeFileSync(criticalDispatch, markdown.replace('criticalPath: false', 'criticalPath: true'));
    expect(() => h.tasks.dispatch(criticalDispatch)).toThrow('critical priority cannot be set by dispatch');
    expect(h.store.tasks()).toHaveLength(0);

    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    const criticalRetry = join(h.root, '.temp/goal/critical-retry.md');
    const criticalText = markdown
      .replace('criticalPath: false', 'criticalPath: true')
      .replace('waiting: []', 'waiting: [linked-work]\ninseparable: true');
    writeFileSync(criticalRetry, criticalText);
    addManager(h.store.db, task.brief.manager, 'owner-session', 'supermanager');
    addManager(h.store.db, 'supermanager', 'super-session', 'root');
    const runtime = runtimeFor(h);
    await expect(
      runWorkerCommand('retry', [task.id, '--brief', criticalRetry], {
        runtime,
        env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: task.brief.manager },
      }),
    ).rejects.toThrow('critical priority requires an active task-bound grant');
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toBeUndefined();

    await runWorkerCommand('priority', ['grant', task.id], {
      runtime,
      env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
    });
    await runWorkerCommand('retry', [task.id, '--brief', criticalRetry], {
      runtime,
      env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: task.brief.manager },
    });
    const updated = h.store.task(task.id);
    expect(updated.state).toBe('ready');
    expect(updated.brief.criticalPath).toBe(true);
    expect(updated.taskClass).toBe('critical-path');
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })?.status).toBe('pending');
    expect(updated.priorityHistory?.at(-1)).toMatchObject({
      value: 'critical',
      setter: task.brief.manager,
      grantor: 'supermanager',
    });
  } finally {
    h.dispose();
  }
});

test('task priority metadata accepts the live generation and rejects a stale generation', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    const current = h.store.task(task.id);
    expect(current.currentAttempt).toBe(1);
    h.tasks.setPriority(task.id, 'critical');
    expect(h.store.task(task.id).brief.criticalPath).toBe(true);
    expect(() =>
      h.store.updatePriorityMetadata({ taskId: task.id, attempt: 0 }, (value) => {
        value.brief.criticalPath = false;
      }),
    ).toThrow(StaleAttemptError);
    expect(h.store.task(task.id).brief.criticalPath).toBe(true);
    await worker.exited;
  } finally {
    h.dispose();
  }
});
