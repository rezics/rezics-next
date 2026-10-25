import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadSettings } from './config.ts';
import { WorkerJob } from './job.ts';
import { workerEnvironment } from './launch.ts';
import type { ProcessIdentity } from './process.ts';
import { harness } from './test-support.ts';

function deadIdentity(): ProcessIdentity {
  return { pid: 2_147_483_647, start: 'dead-incarnation', boot: 'dead-boot', group: 2_147_483_647 };
}

test('the store always lives in the state directory', () => {
  const h = harness();
  try {
    const settings = loadSettings({ cwd: h.root, env: {
      GOAL_STATE_DIRECTORY: '.temp/test-state', GOAL_DATABASE_PATH: '.temp/live/goal.sqlite',
    } });
    expect(settings.databasePath).toBe(join(h.root, '.temp/test-state/goal.sqlite'));
  } finally { h.dispose(); }
});

test("adoption skips an attempt whose run log is outside its own state directory", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, attempt => {
      attempt.driver = deadIdentity();
      attempt.logPath = join(h.root, '.temp/another-state', 'run.jsonl');
    });
    const before = h.store.events(task.id);

    await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans();

    expect(h.store.events(task.id)).toEqual(before);
    expect(h.store.attempt(worker.attempt).state).toBe('running');
  } finally { h.dispose(); }
});

test('workers do not receive the live store location', () => {
  const pool = { name: 'fixture', cli: 'codex' as const, classes: ['codex'], configDirectory: '/account', command: 'codex',
    allowanceKey: 'fixture', policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 60000 } };
  const env = workerEnvironment(pool, { GOAL_TASK_ID: 'task', GOAL_ATTEMPT: '3' }, {
    GOAL_DATABASE_PATH: '/live/goal.sqlite', GOAL_STATE_DIRECTORY: '/live', GOAL_WORKTREE_ROOT: '/live/worktrees',
  });
  expect(env.GOAL_TASK_ID).toBe('task');
  expect(env.GOAL_ATTEMPT).toBe('3');
  expect(env.GOAL_DATABASE_PATH).toBeUndefined();
  expect(env.GOAL_STATE_DIRECTORY).toBeUndefined();
  expect(env.GOAL_WORKTREE_ROOT).toBeUndefined();
});
