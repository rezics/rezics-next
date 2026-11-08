import { expect, test } from 'bun:test';
import { workerMemoryHigh } from './worker-slice.ts';
const GiB = 1024 ** 3;
test('operator high/hard limits survive adaptive launches and stale environment overrides', () => {
  const limits = `MemoryHigh=${24 * GiB}\nMemoryMax=${28 * GiB}\n`;
  expect(workerMemoryHigh(32, limits)).toBe('24G');
  expect(workerMemoryHigh(16, limits)).toBe('24G');
  expect(workerMemoryHigh(40, limits, true)).toBe('24G');
  expect(workerMemoryHigh(20, limits, true)).toBe('20G');
});
test('adaptive high cannot exceed a finite hard max even when no high was configured', () => {
  expect(workerMemoryHigh(32, `MemoryHigh=infinity\nMemoryMax=${28 * GiB}`)).toBe('28G');
  expect(workerMemoryHigh(16, 'MemoryHigh=infinity\nMemoryMax=infinity')).toBe('16G');
});
