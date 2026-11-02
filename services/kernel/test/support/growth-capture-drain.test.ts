import { expect, test } from 'bun:test';
import { drainCaptureWork } from './growth-capture-drain.ts';

test('drains failed work and tasks registered while draining', async () => {
  const queryFailure = new Error('captured query failed');
  const setupFailure = new Error('late setup failed');
  const pendingQueries = new Set<Promise<void>>([Promise.reject(queryFailure)]);
  const setupTasks = new Set<Promise<void>>();
  let rejectLate!: (error: unknown) => void;
  const lateQuery = new Promise<void>((_resolve, reject) => {
    rejectLate = reject;
  });
  setupTasks.add(
    Promise.resolve().then(() => {
      pendingQueries.add(lateQuery);
      void lateQuery.then(() => pendingQueries.delete(lateQuery), () => {});
    }),
  );

  const drained = drainCaptureWork(pendingQueries, setupTasks);
  let complete = false;
  void drained.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);

  rejectLate(setupFailure);
  expect(await drained).toEqual([queryFailure, setupFailure]);
  expect(pendingQueries.size).toBe(0);
  expect(setupTasks.size).toBe(0);
});
