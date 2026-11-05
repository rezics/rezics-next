import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkClass,
  checkMemoryCapacity,
  checkMemoryWeight,
  memoryLeaseDirectory,
  readPeaks,
  recordPeak,
  recordScopedPeak,
} from './check-memory.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('capacity follows configured, slice high, and total memory fallbacks', () => {
  expect(checkMemoryCapacity({ REZICS_CHECK_MEMORY_GIB: '12' })).toBe(12);
  expect(checkMemoryCapacity({}, String(24 * 2 ** 30))).toBe(18);
  expect(checkMemoryCapacity({}, 'infinity', 100 * 2 ** 30)).toBe(35);
  expect(checkMemoryCapacity({}, null, 64 * 2 ** 30)).toBe(22);
  expect(memoryLeaseDirectory({})).toBe('/tmp/rezics-check-memory');
  expect(memoryLeaseDirectory({ REZICS_CHECK_MEMORY_DIR: '/tmp/test-lease' })).toBe('/tmp/test-lease');
});

test('classifies commands and reduces test files to their workspace', () => {
  const root = '/workspace/project';
  expect(checkClass(['bun', 'run', 'typecheck'], root)).toBe('bun run typecheck');
  expect(checkClass(['bun', 'run', '--cwd', 'apps/web', 'build'], root)).toBe('bun run --cwd apps/web build');
  expect(checkClass(['bun', 'test', 'services/kernel/test/x.test.ts'], root)).toBe('bun test services/kernel');
  expect(checkClass(['bun', 'test', 'scripts/a.test.ts', 'scripts/b.test.ts'], root)).toBe('bun test scripts');
});

test('weight uses rounded-up 90th percentile of up to 20 peaks with a three-peak warmup', () => {
  const gib = 2 ** 30;
  expect(checkMemoryWeight([9 * gib, 2 * gib], 16)).toBe(4);
  expect(checkMemoryWeight([1 * gib, 2 * gib, 3 * gib], 16)).toBe(3);
  expect(
    checkMemoryWeight(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * gib),
      4,
    ),
  ).toBe(4);
  expect(
    checkMemoryWeight(
      [1, 2, 3].map((n) => n * 2 ** 30),
      1,
    ),
  ).toBe(1);
  expect(
    checkMemoryWeight(
      [100, 120, 200].map((n) => n * 2 ** 20),
      16,
    ),
  ).toBe(0);
  expect(
    checkMemoryWeight(
      [100, 120, 256].map((n) => n * 2 ** 20),
      16,
    ),
  ).toBe(1);
  expect(checkMemoryWeight([100 * 2 ** 20, 120 * 2 ** 20], 16)).toBe(4);
});

test('records only the last 20 peaks and no more than 200 classes using atomic replacement', () => {
  const directory = mkdtempSync('/tmp/check-memory-test-');
  dirs.push(directory);
  for (let i = 0; i < 22; i++) recordPeak(directory, 'bun test', i + 1);
  expect(readPeaks(directory)['bun test']).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
  for (let i = 0; i < 205; i++) recordPeak(directory, `class-${i}`, 1);
  expect(Object.keys(JSON.parse(readFileSync(join(directory, 'peaks.json'), 'utf8'))).length).toBe(200);
});

test('a scope peak file is recorded under its command class', () => {
  const directory = mkdtempSync('/tmp/check-memory-peak-test-');
  dirs.push(directory);
  const peakFile = join(directory, 'scope-peak');
  const gib = 2 ** 30;
  writeFileSync(peakFile, String(2.5 * gib));
  expect(recordScopedPeak(directory, 'bun run typecheck', peakFile)).toBe(2.5 * gib);
  expect(readPeaks(directory)['bun run typecheck']).toEqual([2.5 * gib]);
  expect(recordScopedPeak(directory, 'missing', join(directory, 'missing'))).toBeUndefined();
});
