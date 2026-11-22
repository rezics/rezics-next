import { expect, test } from 'bun:test';
import { createPackageInstallations } from './package-installations';

test('cancels only the selected attempt and drains the operation that has begun committing', async () => {
  const installs = createPackageInstallations();
  const staged = Promise.withResolvers<void>();
  const cancelCleanup = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const downloading = installs.run('download', async ({ signal }) => {
    staged.resolve();
    await cancelCleanup.promise;
    signal?.throwIfAborted();
  });
  const committing = installs.run('commit', async ({ signal, beginCommit }) => {
    beginCommit?.();
    commit.resolve();
    await published.promise;
    expect(signal?.aborted).toBeFalse();
  });
  await Promise.all([staged.promise, commit.promise]);

  expect(installs.cancel('stale')).toBeFalse();
  expect(installs.cancel('commit')).toBeFalse();
  expect(installs.cancel('download')).toBeTrue();
  let finished = false;
  const drained = installs.abandon().then(() => {
    finished = true;
  });
  cancelCleanup.resolve();
  expect(await downloading).toBeFalse();
  expect(installs.cancel('download')).toBeFalse();
  expect(finished).toBeFalse();
  published.resolve();
  expect(await committing).toBeTrue();
  await drained;
});
