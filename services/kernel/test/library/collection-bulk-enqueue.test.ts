import { expect, test } from 'bun:test';
import { enqueueAndDiscardHandle } from '../../src/library/collection-bulk-enqueue.ts';

test('bulk continuation steps discard DBOS client handles before result serialization', async () => {
  const handle = { systemDatabase: { workflowEpoch: 1n }, workflowID: 'bulk-expiry:1' };
  expect(() => JSON.stringify(handle)).toThrow();
  let enqueued = false;

  const result = await enqueueAndDiscardHandle(async () => {
    enqueued = true;
    return handle;
  });

  expect(enqueued).toBe(true);
  expect(result).toBeUndefined();
});

test('bulk continuation steps still surface enqueue failures', async () => {
  const failure = new Error('enqueue rejected');

  await expect(enqueueAndDiscardHandle(async () => Promise.reject(failure))).rejects.toBe(failure);
});
