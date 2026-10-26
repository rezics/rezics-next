import { expect, test } from 'bun:test';
import { capture, scheduleFiles } from '../scripts/check.ts';

test('schedules files in order with bounded concurrency', async () => {
  const started: string[] = [];
  let active = 0;
  let maximum = 0;
  const outcomes = await scheduleFiles(['a', 'b', 'c', 'd', 'e'], 2, {
    create: async () => undefined,
    run: async (file) => {
      started.push(file);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, file === 'a' ? 20 : 1));
      active -= 1;
      return file;
    },
    drop: async () => undefined,
  });

  expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(maximum).toBe(2);
  expect(outcomes.map(({ file, output }) => [file, output])).toEqual([
    ['a', 'a'],
    ['b', 'b'],
    ['c', 'c'],
    ['d', 'd'],
    ['e', 'e'],
  ]);
});

test('drops every created database and attributes runner failures to files', async () => {
  const created: string[] = [];
  const dropped: string[] = [];
  const outcomes = await scheduleFiles(['ok', 'bad', 'also-ok'], 2, {
    create: async (_file, database) => {
      created.push(database);
    },
    run: async (file) => {
      if (file === 'bad') throw new Error('test failed');
      return `${file} output`;
    },
    drop: async (_file, database) => {
      dropped.push(database);
    },
  });

  expect(dropped).toEqual(created);
  expect(outcomes.map(({ file, error }) => [file, error?.message])).toEqual([
    ['ok', undefined],
    ['bad', 'test failed'],
    ['also-ok', undefined],
  ]);
});

test('test file processes overlap instead of blocking the pool one at a time', async () => {
  const startedAt = performance.now();
  const outcomes = await scheduleFiles(['a', 'b', 'c'], 3, {
    create: async () => undefined,
    run: (file) => capture('sh', ['-c', `sleep 0.5; echo ${file}`]),
    drop: async () => undefined,
  });

  expect(outcomes.map(({ output }) => output)).toEqual([
    { status: 0, output: 'a\n' },
    { status: 0, output: 'b\n' },
    { status: 0, output: 'c\n' },
  ]);
  expect(performance.now() - startedAt).toBeLessThan(1000);
});
