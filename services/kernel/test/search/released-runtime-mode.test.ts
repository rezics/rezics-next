import { expect, test } from 'bun:test';
import { searchWorkerOwnership } from './support/runner-slot.ts';

test('explicit kernelPool refuses child ownership before invoking the pool capability', () => {
  let calls = 0;
  const instrumented = searchWorkerOwnership(() => {
    calls += 1;
    throw new Error('Selecting worker ownership must not acquire a pool');
  });
  expect(instrumented.kind).toBe('in-process');
  expect(() => instrumented.requireOwnedChild()).toThrow('explicit kernelPool capability');
  expect(() => instrumented.requireOwnedChild()).toThrow('in-process instrumentation');
  expect(calls).toBe(0);

  const child = searchWorkerOwnership(undefined);
  expect(child.kind).toBe('owned-child');
  expect(() => child.requireOwnedChild()).not.toThrow();
});
