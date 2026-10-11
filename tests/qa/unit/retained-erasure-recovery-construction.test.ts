import { expect, test } from 'bun:test';
import { constructRetainedErasureCandidatesInOrder } from '../fault-recovery/retained-erasure-recovery-fixture.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('candidate construction waits for the prior candidate readiness before starting the next', async () => {
  const firstReady = deferred<void>();
  const firstEntered = deferred<void>();
  const starts: string[] = [];
  const constructing = constructRetainedErasureCandidatesInOrder(
    ['before', 'after-account', 'after-authority'],
    async cut => {
      starts.push(cut);
      if (cut === 'before') {
        firstEntered.resolve();
        await firstReady.promise;
      }
      return `${cut}:ready`;
    },
  );

  await firstEntered.promise;
  expect(starts).toEqual(['before']);
  firstReady.resolve();
  await expect(constructing).resolves.toEqual([
    'before:ready', 'after-account:ready', 'after-authority:ready',
  ]);
  expect(starts).toEqual(['before', 'after-account', 'after-authority']);
});

test('a failed candidate prevents later starts and preserves the original construction error', async () => {
  const constructionFailure = new Error('candidate readiness failed');
  const starts: string[] = [];
  const allocated: string[] = [];
  const constructing = constructRetainedErasureCandidatesInOrder(
    ['before', 'after-account', 'after-authority'],
    async cut => {
      starts.push(cut);
      if (cut === 'after-account') throw constructionFailure;
      allocated.push(cut);
      return `${cut}:ready`;
    },
  );

  await expect(constructing).rejects.toBe(constructionFailure);
  expect(starts).toEqual(['before', 'after-account']);
  expect(allocated).toEqual(['before']);
});
