import { expect, test } from 'bun:test';
import type { Runtime } from './config.ts';
import { run } from './cli.ts';
import type { WorkerStore } from './store.ts';
import type { Settings, Task } from './types.ts';
import { WorkerTasks } from './tasks.ts';
import { temporaryDirectory } from './test-support.ts';

test('diagnostics are read-only, tolerate unknown dependencies and use controller readiness', async () => {
  const temporary = temporaryDirectory();
  const previousLog = console.log;
  const previousManager = process.env.GOAL_MANAGER;
  const output: string[] = [];
  let mutations = 0;
  const mutate = () => { mutations++; };
  const task = (id: string, state: Task['state'], after: unknown = []) =>
    ({ id, brief: { after }, state, currentAttempt: 1 }) as unknown as Task;
  const expected = [
    ['missing', 'unknown', false], ['malformed', 'unknown', false], ['invalid-state', 'unknown', false],
    ['same-target', 'integrated', true], ['cross-visible', 'integrated', true],
    ['cross-waiting', 'integrated', false], ['merged', 'merged', true], ['running', 'running', false],
    ['cross-unrecorded', 'integrated', true],
  ];
  const held = task('held', 'held', expected.map(([id]) => id));
  const all = [held, task('healthy', 'ready'), task('bad-after', 'held', 'invalid'), task('bad-id', 'held', [null])];
  const db = {
    query: (sql: string) => ({
      all: () => [], get: () => sql.includes('manager_sessions') ? { id: 'operator' } : null, run: mutate,
    }),
    close() {},
  } as unknown as Runtime['db'];
  const store = {
    db, tasks: () => all, task: () => held,
    dependency(id: string) {
      if (id === 'missing') return undefined;
      if (id === 'malformed') throw new Error('malformed dependency');
      if (id === 'invalid-state') return { state: 'invalid' };
      if (id === 'merged' || id === 'running') return { state: id };
      return {
        state: 'integrated', target: id.startsWith('cross-') ? 'stabilize' : undefined,
        task_commit: id === 'cross-visible' ? 'refs/heads/dev' : id === 'cross-unrecorded' ? undefined : '0'.repeat(40),
      };
    },
    retryIntent: () => ({ status: 'pending' }), attempts: () => [], records: () => [],
  } as unknown as WorkerStore;
  const settings = {
    stateDirectory: temporary.path, mainCheckout: process.cwd(), integrationBranch: 'dev',
  } as Settings;
  const tasks = Object.assign(Object.create(WorkerTasks.prototype), { settings, store }) as WorkerTasks;
  const runtime = {
    db, settings, store, tasks, job: { drain: mutate, start: mutate }, recoverOrphans: mutate,
  } as unknown as Runtime;

  process.env.GOAL_MANAGER = 'operator';
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  try {
    for (const args of [['status'], ['status', 'held'], ['attempts'], ['attempts', '--json'], ['report']])
      expect(await run(args, () => runtime)).toBe(0);
  } finally {
    console.log = previousLog;
    if (previousManager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = previousManager;
    temporary.close();
  }

  const status = JSON.parse(output[0]!);
  const heldStatus = status.tasks[0];
  expect(heldStatus.dependencies.map(({ id, state, ready }: { id: string; state: string; ready: boolean }) =>
    [id, state, ready])).toEqual(expected);
  expect(heldStatus.waitingFor).toEqual(expected.filter(([, , ready]) => !ready).map(([id]) => id));
  expect(heldStatus.pendingRetry).toEqual({ reason: 'dependencies', waitingFor: heldStatus.waitingFor });
  expect(JSON.parse(output[1]!)).toMatchObject(heldStatus);
  expect(status.tasks.map(({ id }: Task) => id)).toEqual(all.map(({ id }) => id));
  for (const malformed of status.tasks.slice(2))
    expect(malformed.dependencies).toMatchObject([{ state: 'unknown', ready: false }]);
  expect(mutations).toBe(0);
});
