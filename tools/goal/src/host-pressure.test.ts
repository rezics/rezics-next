import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pressureBrake,
  reclaimableFileMiB,
  reclaimCleanFileCache,
  reclaimCleanFileCacheEvidence,
  workerHeadroomMiB,
  workerMemoryCurrentMiB,
  workerReservationMiB,
  workerScopeIncarnation,
} from './host-pressure.ts';
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

test('five worker scopes retain actual usage and active reserves while proven parked checks release only their reserve', () => {
  const directory = temporaryDirectory();
  const gib = (value: number) => String(Math.round(value * 1024 ** 3));
  const scope = (name: string, current: number, peak = current) => {
    mkdirSync(join(directory.path, name));
    writeFileSync(join(directory.path, name, 'memory.current'), gib(current));
    writeFileSync(join(directory.path, name, 'memory.peak'), gib(peak));
  };
  try {
    writeFileSync(join(directory.path, 'memory.max'), gib(28));
    writeFileSync(join(directory.path, 'memory.current'), gib(9.16));
    scope('rezics-worker-check-a.scope', 0.04);
    scope('rezics-worker-check-b.scope', 0.04);
    scope('rezics-worker-check-c.scope', 0.35);
    scope('rezics-worker-active.scope', 2.25, 7.71);
    scope('rezics-worker-unknown.scope', 2.25, 4);

    const identity = (name: string) => workerScopeIncarnation(directory.path, name)!;
    const active = new Map([['rezics-worker-active.scope', identity('rezics-worker-active.scope')]]);
    const parkedScopes = ['rezics-worker-check-a.scope', 'rezics-worker-check-b.scope', 'rezics-worker-check-c.scope'];
    const parkedEvidence = new Map(parkedScopes.map((name) => [name, identity(name)]));
    const baseline = workerHeadroomMiB(1, directory.path, new Map(), active);
    const parked = workerHeadroomMiB(1, directory.path, parkedEvidence, active);
    const contradictoryActive = new Map(active);
    contradictoryActive.set(parkedScopes[0]!, identity(parkedScopes[0]!));
    const contradictory = workerHeadroomMiB(1, directory.path, parkedEvidence, contradictoryActive);

    expect(baseline).toBeCloseTo(0.06 * 1024, 1);
    expect(baseline).toBeLessThan(workerReservationMiB('imports'));
    expect(parked).toBeCloseTo(11.63 * 1024, 1);
    expect(parked).toBeGreaterThan(workerReservationMiB('imports'));
    expect(contradictory).toBeCloseTo(parked - 3.96 * 1024, 1);
  } finally {
    directory.close();
  }
});

test('retirement exemptions bind to one cgroup incarnation and an active same-scope writer keeps its reserve', () => {
  const directory = temporaryDirectory();
  const gib = 1024 ** 3;
  const name = 'rezics-worker-owner-1-retired.scope';
  const scope = join(directory.path, name);
  const put = (path: string, value: number) => writeFileSync(path, String(Math.round(value * gib)));
  try {
    put(join(directory.path, 'memory.max'), 26);
    put(join(directory.path, 'memory.current'), 1);
    mkdirSync(scope);
    put(join(scope, 'memory.current'), 0.25);
    put(join(scope, 'memory.peak'), 5);
    const retiredIncarnation = workerScopeIncarnation(directory.path, name)!;
    const retired = new Map([[name, retiredIncarnation]]);
    const noRetirement = workerHeadroomMiB(0, directory.path, new Map(), new Map());
    const exempted = workerHeadroomMiB(0, directory.path, retired, new Map());
    const replacementWriter = workerHeadroomMiB(0, directory.path, retired, retired);
    expect(exempted - noRetirement).toBeCloseTo(5_120 - 256, 1);
    expect(replacementWriter).toBeCloseTo(noRetirement, 1);

    renameSync(scope, `${scope}.old`);
    mkdirSync(scope);
    put(join(scope, 'memory.current'), 0.25);
    put(join(scope, 'memory.peak'), 5);
    expect(workerScopeIncarnation(directory.path, name)).not.toEqual(retiredIncarnation);
    expect(workerHeadroomMiB(0, directory.path, retired, new Map())).toBeCloseTo(noRetirement, 1);
  } finally {
    directory.close();
  }
});

test('file-cache reclaim is bounded by the deficit, four GiB and clean inactive-file evidence', () => {
  const directory = temporaryDirectory();
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const stat = (inactive: number, dirty: number, writeback = 0) =>
    writeFileSync(
      join(directory.path, 'memory.stat'),
      `inactive_file ${inactive}\nfile_dirty ${dirty}\nfile_writeback ${writeback}\n`,
    );
  try {
    stat(11.5 * gib, 64 * mib, 0);
    writeFileSync(join(directory.path, 'memory.reclaim'), '');
    expect(reclaimableFileMiB(directory.path)).toBe(Math.floor((11.5 * gib - 64 * mib) / mib));
    expect(reclaimCleanFileCache(8192, directory.path)).toBe(4096);
    expect(readFileSync(join(directory.path, 'memory.reclaim'), 'utf8')).toBe(`${4096 * mib} swappiness=0`);

    stat(3 * gib, 1 * gib, 1 * gib);
    writeFileSync(join(directory.path, 'memory.reclaim'), '');
    expect(reclaimCleanFileCache(8192, directory.path)).toBe(1024);
    expect(readFileSync(join(directory.path, 'memory.reclaim'), 'utf8')).toBe(`${1024 * mib} swappiness=0`);
  } finally {
    directory.close();
  }
});

test('reclaim requests retain transient kernel evidence and memory.current is measured directly', () => {
  const directory = temporaryDirectory();
  try {
    const gib = 1024 ** 3;
    writeFileSync(join(directory.path, 'memory.stat'), `inactive_file ${2 * gib}\nfile_dirty 0\n`);
    writeFileSync(join(directory.path, 'memory.reclaim'), '');
    writeFileSync(join(directory.path, 'memory.current'), String(10 * gib));
    expect(workerMemoryCurrentMiB(directory.path)).toBe(10 * 1024);
    const request = reclaimCleanFileCacheEvidence(1024, directory.path, () => {
      throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' });
    });
    expect(request).toEqual({ requestedMiB: 1024, errorCode: 'EAGAIN' });
    expect(readFileSync(join(directory.path, 'memory.reclaim'), 'utf8')).toBe('');
    writeFileSync(join(directory.path, 'memory.current'), 'unknown');
    expect(workerMemoryCurrentMiB(directory.path)).toBeUndefined();
  } finally {
    directory.close();
  }
});

test('unsupported reclaim files and fully dirty inactive pages produce no request', () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory.path, 'memory.stat'), `inactive_file ${1024 ** 3}\nfile_dirty ${1024 ** 3}\n`);
    writeFileSync(join(directory.path, 'memory.reclaim'), '');
    expect(reclaimCleanFileCache(4096, directory.path)).toBe(0);
    expect(readFileSync(join(directory.path, 'memory.reclaim'), 'utf8')).toBe('');
    expect(reclaimCleanFileCache(4096, join(directory.path, 'unsupported'))).toBe(0);
  } finally {
    directory.close();
  }
});
