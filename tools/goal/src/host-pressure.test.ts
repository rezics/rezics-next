import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pressureBrake, workerHeadroomMiB, workerReservationMiB } from './host-pressure.ts';
import { temporaryDirectory } from './test-support.ts';

const healthy = { memoryFull: 0, ioFull: 0 };
test('pressure pauses admission until thirty seconds continuously below both recovery thresholds', () => {
  const paused = pressureBrake({ paused: false }, { memoryFull: 1, ioFull: 0 }, 0);
  expect(paused.paused).toBe(true);
  const cooling = pressureBrake(paused, healthy, 1000);
  expect(pressureBrake(cooling, healthy, 30_999).paused).toBe(true);
  expect(pressureBrake(cooling, healthy, 31_000).paused).toBe(false);
  expect(pressureBrake(cooling, { memoryFull: 0, ioFull: 2 }, 30_000)).toEqual({ paused: true });
  expect(pressureBrake({ paused: false }, { memoryFull: 0, ioFull: 10 }, 0).paused).toBe(true);
});
test('working-set presets and measured peaks reserve future growth without treating the hard ceiling as expected use', () => {
  const directory = temporaryDirectory();
  const put = (path: string, gib: number) => writeFileSync(join(directory.path, path), String(gib * 1024 ** 3));
  try {
    expect(workerReservationMiB('library')).toBe(2048);
    expect(workerReservationMiB('control-plane')).toBe(4096);
    expect(workerReservationMiB()).toBe(4096);
    put('memory.max', 28);
    put('memory.current', 3);
    mkdirSync(join(directory.path, 'rezics-worker-example.scope'));
    put('rezics-worker-example.scope/memory.current', 1);
    put('rezics-worker-example.scope/memory.peak', 5);
    expect(workerHeadroomMiB(1, directory.path)).toBe(21 * 1024);
    expect(workerHeadroomMiB(2, directory.path)).toBe(17 * 1024);
    writeFileSync(join(directory.path, 'memory.current'), 'unknown');
    expect(workerHeadroomMiB(1, directory.path)).toBe(0);
    writeFileSync(join(directory.path, 'memory.max'), 'max');
    expect(workerHeadroomMiB(1, directory.path)).toBe(Infinity);
  } finally {
    directory.close();
  }
});
