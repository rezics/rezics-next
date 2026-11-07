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
      void lateQuery.then(
        () => pendingQueries.delete(lateQuery),
        () => {},
      );
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
  expect(await drained).toEqual({ errors: [queryFailure, setupFailure], omittedErrors: 0 });
  expect(pendingQueries.size).toBe(0);
  expect(setupTasks.size).toBe(0);
});

test('settles every pending task while retaining only bounded secondary failures', async () => {
  let settled = 0;
  const pending = new Set<Promise<void>>(
    Array.from({ length: 21 }, (_, index) =>
      Promise.reject(new Error(`pending ${index}`)).finally(() => {
        settled++;
      }),
    ),
  );
  const drained = await drainCaptureWork(pending);

  expect(settled).toBe(21);
  expect(drained.errors).toHaveLength(16);
  expect(drained.omittedErrors).toBe(5);
  expect(pending.size).toBe(0);
  expect(drained.errors[0]).toMatchObject({ message: 'pending 0' });
  expect(drained.errors.at(-1)).toMatchObject({ message: 'pending 15' });
});
