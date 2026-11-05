import { expect, test } from 'bun:test';
import { readerTestRuntime as runtime } from './agent-reader-lifetime.test';

test('Agent preference transport stops after preparation retirement and forwards cancellation to native GET', async () => {
  runtime.reset();
  runtime.setReader('reader-a');
  const preparation = runtime.delayNextPreparation();
  const abandoned = new AbortController();
  const oldRead = runtime.readSettings(abandoned.signal);
  await preparation.entered.promise;
  abandoned.abort();
  preparation.release.resolve(undefined);
  await expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
  expect(runtime.nativeReads).toHaveLength(0);

  const current = new AbortController();
  const freshRead = runtime.readSettings(current.signal);
  await runtime.settle();
  expect(runtime.nativeReads).toHaveLength(1);
  const nativeRead = runtime.nativeReads[0]!;
  expect(nativeRead.signal).toBeDefined();
  current.abort();
  expect(nativeRead.signal?.aborted).toBe(true);
  nativeRead.work.resolve(runtime.result('show'));
  await expect(freshRead).rejects.toMatchObject({ name: 'AbortError' });
});
