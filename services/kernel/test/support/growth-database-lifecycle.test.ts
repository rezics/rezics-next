import { expect, test } from 'bun:test';
import { createGrowthDatabaseLifecycle } from './growth-capture.ts';

test('setup failure closes every acquired pool and reports cleanup failures with the setup error', async () => {
  const lifecycle = createGrowthDatabaseLifecycle();
  const closed: string[] = [];
  const setupError = new Error('probe failed');
  const cleanupError = new Error('socket refused');

  await expect(
    lifecycle.setup(async () => {
      lifecycle.acquire('instrumented pool', () => ({ end: async () => void closed.push('instrumented') }));
      lifecycle.acquire('admin pool', () => ({
        end: async () => {
          closed.push('admin');
          throw cleanupError;
        },
      }));
      throw setupError;
    }),
  ).rejects.toMatchObject({
    message: expect.stringContaining('probe failed'),
    errors: [setupError, expect.objectContaining({ message: expect.stringContaining('admin pool') })],
  });
  expect(closed.sort()).toEqual(['admin', 'instrumented']);
});

test('close is repeatable, drains every pool after a failure, and rejects new acquisitions', async () => {
  const lifecycle = createGrowthDatabaseLifecycle();
  const closed: string[] = [];
  let acquiredAfterClose = false;
  lifecycle.acquire('library pool', () => ({
    end: async () => {
      closed.push('library');
      throw new Error('close failed');
    },
  }));
  lifecycle.acquire('admin pool', () => ({ end: async () => void closed.push('admin') }));

  const closing = lifecycle.close();
  expect(lifecycle.close()).toBe(closing);
  expect(() =>
    lifecycle.acquire('late pool', () => {
      acquiredAfterClose = true;
      return { end: async () => {} };
    }),
  ).toThrow('Growth database is closed');
  await expect(closing).rejects.toMatchObject({
    message: expect.stringContaining('library pool failed to close: close failed'),
  });
  expect(closed.sort()).toEqual(['admin', 'library']);
  expect(acquiredAfterClose).toBe(false);
});

test('close drains admitted checks in order before releasing pools', async () => {
  const lifecycle = createGrowthDatabaseLifecycle();
  const events: string[] = [];
  let poolClosed = false;
  lifecycle.acquire('admin pool', () => ({ end: async () => void (poolClosed = true) }));

  let startFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
  let releaseFirst!: () => void;
  const firstBlock = new Promise<void>((resolve) => (releaseFirst = resolve));
  const first = lifecycle.runExclusiveCheck(async () => {
    events.push('first:start');
    startFirst();
    await firstBlock;
    lifecycle.assertOpen();
    events.push('first:capture');
    events.push('first:end');
  });
  await firstStarted;

  let startSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => (startSecond = resolve));
  let releaseSecond!: () => void;
  const secondBlock = new Promise<void>((resolve) => (releaseSecond = resolve));
  const second = lifecycle.runExclusiveCheck(async () => {
    events.push('second:start');
    startSecond();
    await secondBlock;
    lifecycle.assertOpen();
    events.push('second:capture');
    events.push('second:end');
  });
  const closing = lifecycle.close();

  expect(events).toEqual(['first:start']);
  expect(() => lifecycle.runExclusiveCheck(async () => {})).toThrow('Growth database is closed');
  expect(() => lifecycle.assertOpen()).toThrow('Growth database is closed');
  expect(poolClosed).toBe(false);

  releaseFirst();
  await secondStarted;
  expect(events).toEqual(['first:start', 'first:capture', 'first:end', 'second:start']);
  expect(poolClosed).toBe(false);

  releaseSecond();
  await Promise.all([first, second, closing]);
  expect(events).toEqual(['first:start', 'first:capture', 'first:end', 'second:start', 'second:capture', 'second:end']);
  expect(poolClosed).toBe(true);
});
