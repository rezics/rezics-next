import { expect, test } from 'bun:test';
import { activeTestWallMs } from '../../../scripts/qa/test-wall.ts';

test('Realm source preparation between completed shards does not spend the test wall', () => {
  expect(activeTestWallMs([
    { start: 0, end: 18_000 },
    { start: 30_000, end: 93_000 },
    { start: 1_330_000, end: 1_656_000 },
  ], [])).toBe(407_000);
});

test('parallel tests count their overlap once and exclude only admission inside their union', () => {
  const tests = [{ start: 300, end: 500 }, { start: 0, end: 200 }, { start: 100, end: 250 }];
  const waits = [{ start: -10, end: 25 }, { start: 20, end: 50 },
    { start: 240, end: 310 }, { start: 450, end: 600 }];
  expect(activeTestWallMs(tests, waits)).toBe(330);
  expect(tests[0]).toEqual({ start: 300, end: 500 });
});

test('an empty or unfinished test interval charges no test time', () => {
  expect(activeTestWallMs([], [{ start: 0, end: 100 }])).toBe(0);
  expect(activeTestWallMs([{ start: 10, end: 10 }], [])).toBe(0);
});
