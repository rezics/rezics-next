import { expect, test } from 'bun:test';
import { createGrowthDatabaseLifecycle } from './growth-capture.ts';
import { checkGrowth, openGrowthDatabase } from './growth.ts';

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

test('close waits for queued native checkGrowth measurements before shutting down their pools', async () => {
  const database = await openGrowthDatabase();
  const scales = [1, 8, 64] as const;
  const bounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;
  let startFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let startSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => (startSecond = resolve));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  let third: Promise<unknown> | undefined;
  const measurementError = new Error('native measurement failed');

  const measuredCheck = (name: string, signal: () => void, gate: Promise<void>) =>
    checkGrowth(database, {
      name,
      scales,
      bounds,
      warmups: 0,
      repetitions: 1,
      seededRelations: [],
      grow: async () => {},
      operation: async (db, scale) => {
        const result = await db.pool.query<{ answer: number }>('SELECT $1::integer AS answer', [scale]);
        if (scale === 1) {
          signal();
          await gate;
        }
        return result;
      },
      verify: async (_db, scale, _repetition, value) => {
        expect(value).toMatchObject({ rows: [{ answer: scale }] });
      },
    });

  try {
    const firstReport = measuredCheck('queued close first native measurement', startFirst, firstGate);
    first = firstReport;
    await firstStarted;
    const secondReport = measuredCheck('queued close second native measurement', startSecond, secondGate);
    second = secondReport;
    const failedMeasurement = checkGrowth(database, {
      name: 'queued close failed native measurement',
      scales,
      bounds,
      warmups: 0,
      repetitions: 1,
      seededRelations: [],
      grow: async () => {},
      operation: async (db) => {
        await db.pool.query('SELECT 9001 AS answer');
        throw measurementError;
      },
    });
    third = failedMeasurement;

    let closeSettled = false;
    const closing = database.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseFirst();
    await secondStarted;
    expect(closeSettled).toBe(false);
    releaseSecond();
    const [firstResult, secondResult] = await Promise.all([firstReport, secondReport]);
    await expect(failedMeasurement).rejects.toBe(measurementError);
    await closing;

    for (const report of [firstResult, secondResult]) {
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
    }
    expect(closeSettled).toBe(true);
  } finally {
    releaseFirst();
    releaseSecond();
    await Promise.allSettled([first, second, third]);
    await database.close();
  }
});
