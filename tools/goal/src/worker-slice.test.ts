import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { WORKER_CPU_WEIGHT, WORKER_IO_WEIGHT, WORKER_SLICE, WorkerSlice } from './worker-slice.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function memoryPolicy(totalKiB: number, memoryMax = String(24 * 1024 ** 3), checkStatus = 0) {
  const calls: { command: string; args: string[] }[] = [];
  const reports: string[] = [];
  let reads = 0;
  const run: NonNullable<ConstructorParameters<typeof WorkerSlice>[0]> = (command, args) => {
    calls.push({ command, args });
    const probe = args[0] === 'show';
    const stdout = Buffer.from(probe ? memoryMax : '');
    const stderr = Buffer.alloc(0);
    return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status: probe ? checkStatus : 0, signal: null };
  };
  const worker = new WorkerSlice(run, () => {
    reads++;
    return `MemTotal: ${totalKiB} kB\nMemFree: 1 kB\n`;
  });
  return {
    calls,
    reports,
    reads: () => reads,
    launch: (env: NodeJS.ProcessEnv = {}) =>
      worker.launch(
        'memory-policy',
        1,
        'true',
        [],
        { env },
        () => false,
        (message) => reports.push(message),
      ),
  };
}

test("configuring the worker slice sets MemoryHigh to total memory minus the local check slice's MemoryMax minus a 14 GiB reserve, never below a quarter of total memory, in the same call as the CPU and IO weights", () => {
  for (const [totalGiB, checkGiB, expectedGiB] of [
    [62, 24, 24],
    [62, 60, 16],
    [8, 24, 2],
  ]) {
    const policy = memoryPolicy(totalGiB! * 1024 ** 2 + 1023, String(checkGiB! * 1024 ** 3));
    policy.launch();
    policy.launch();
    expect(policy.calls.filter(({ command }) => command === 'systemctl')).toEqual([
      { command: 'systemctl', args: ['show', 'rezics-check.slice', '-p', 'MemoryMax', '--value'] },
      {
        command: 'systemctl',
        args: [
          '--user',
          'set-property',
          '--runtime',
          WORKER_SLICE,
          `CPUWeight=${WORKER_CPU_WEIGHT}`,
          `IOWeight=${WORKER_IO_WEIGHT}`,
          `MemoryHigh=${expectedGiB}G`,
        ],
      },
    ]);
    expect(policy.reads()).toBe(1);
    expect(policy.calls.filter(({ command }) => command === 'systemd-run')).toHaveLength(2);
    expect(policy.reports).toEqual([]);
  }
});

test('a host without a local check slice, or whose check slice has no MemoryMax, subtracts only the reserve', () => {
  for (const [value, status] of [
    ['infinity', 0],
    ['', 0],
    ['\n', 0],
    [String(24 * 1024 ** 3), 1],
  ] as const) {
    const policy = memoryPolicy(62 * 1024 ** 2, value, status);
    policy.launch();
    expect(policy.calls[1]!.args.at(-1)).toBe('MemoryHigh=48G');
    expect(policy.reports).toEqual([]);
  }
});

test('REZICS_WORKER_MEMORY_HIGH_GIB overrides the derived value, and a value that is not a positive integer fails configuration with a message naming the variable', () => {
  const override = memoryPolicy(62 * 1024 ** 2);
  override.launch({ REZICS_WORKER_MEMORY_HIGH_GIB: '31' });
  expect(override.calls[0]!.args.at(-1)).toBe('MemoryHigh=31G');
  expect(override.reads()).toBe(0);
  expect(override.reports).toEqual([]);

  for (const value of ['', '0', '-1', '1.5', 'NaN', 'infinity', ' 31 ', '1G', '9007199254740992']) {
    const invalid = memoryPolicy(62 * 1024 ** 2);
    expect(invalid.launch({ REZICS_WORKER_MEMORY_HIGH_GIB: value }).status).toBe(0);
    expect(invalid.calls).toEqual([{ command: 'true', args: [] }]);
    expect(invalid.reads()).toBe(0);
    expect(invalid.reports).toHaveLength(1);
    expect(invalid.reports[0]).toContain('REZICS_WORKER_MEMORY_HIGH_GIB must be a positive integer');
  }
});

function fakeSystemd(options: { systemctl?: string; systemdRun?: string; memoryMax?: string | null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-slice-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const systemctlCalls = join(directory, 'systemctl.args');
  const systemdRunCalls = join(directory, 'systemd-run.args');
  const script = (name: string, record: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${record}'\n${body}\n`);
    chmodSync(path, 0o755);
  };
  script(
    'systemctl',
    systemctlCalls,
    options.systemctl ??
      `if [ "$1" = show ]; then ${options.memoryMax === null ? 'echo unavailable >&2; exit 1' : `printf '%s\\n' '${options.memoryMax ?? `${24 * 1024 ** 3}`}'`}; else exit 0; fi`,
  );
  script('systemd-run', systemdRunCalls, options.systemdRun ?? 'exit 0');
  return {
    directory,
    systemctlCalls,
    systemdRunCalls,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    read: (path: string) => readFileSync(path, 'utf8').trim().split('\n'),
  };
}

describe('worker systemd slice', () => {
  test('starts each attempt in its own transient scope under the user worker slice', () => {
    const fake = fakeSystemd();
    const worker = new WorkerSlice();
    const result = worker.launch('task:one', 3, 'python3', ['-c', 'pass'], { env: fake.env }, () => false);

    expect(result.status).toBe(0);
    expect(fake.read(fake.systemdRunCalls)).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      `--slice=${WORKER_SLICE}`,
      '--unit=rezics-worker-task:one-3.scope',
      'python3',
      '-c',
      'pass',
    ]);
  });

  test('sets CPU, IO and derived memory weights once at runtime', () => {
    const fake = fakeSystemd();
    const worker = new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n');
    worker.launch('first', 1, 'true', [], { env: fake.env }, () => false);
    worker.launch('second', 1, 'true', [], { env: fake.env }, () => false);

    expect(fake.read(fake.systemctlCalls).slice(-7)).toEqual([
      '--user',
      'set-property',
      '--runtime',
      WORKER_SLICE,
      `CPUWeight=${WORKER_CPU_WEIGHT}`,
      `IOWeight=${WORKER_IO_WEIGHT}`,
      'MemoryHigh=24G',
    ]);
    expect(fake.read(fake.systemctlCalls).join(' ')).not.toMatch(/CPUQuota|TasksMax/);
  });

  test('derives MemoryHigh from total memory, check MemoryMax and reserve, with a quarter floor', () => {
    const fake = fakeSystemd({ memoryMax: `${24 * 1024 ** 3}` });
    const worker = new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n');
    worker.launch('task', 1, 'true', [], { env: fake.env }, () => false);
    expect(fake.read(fake.systemctlCalls).slice(-1)).toEqual(['MemoryHigh=24G']);

    const small = fakeSystemd({ memoryMax: `${60 * 1024 ** 3}` });
    new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n').launch(
      'task',
      1,
      'true',
      [],
      { env: small.env },
      () => false,
    );
    expect(small.read(small.systemctlCalls).slice(-1)).toEqual(['MemoryHigh=16G']);
  });

  test('subtracts only the reserve when the check slice is unavailable or has no MemoryMax', () => {
    const noLimit = fakeSystemd({ memoryMax: 'infinity' });
    new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n').launch(
      'task',
      1,
      'true',
      [],
      { env: noLimit.env },
      () => false,
    );
    expect(noLimit.read(noLimit.systemctlCalls).slice(-1)).toEqual(['MemoryHigh=48G']);

    const failed = fakeSystemd({ memoryMax: null });
    new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n').launch(
      'task',
      1,
      'true',
      [],
      { env: failed.env },
      () => false,
    );
    expect(failed.read(failed.systemctlCalls).slice(-1)).toEqual(['MemoryHigh=48G']);
  });

  test('uses a positive integer memory override and rejects invalid values by naming the variable', () => {
    const override = fakeSystemd();
    new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n').launch(
      'task',
      1,
      'true',
      [],
      { env: { ...override.env, REZICS_WORKER_MEMORY_HIGH_GIB: '31' } },
      () => false,
    );
    expect(override.read(override.systemctlCalls).slice(-1)).toEqual(['MemoryHigh=31G']);

    const invalid = fakeSystemd();
    const reports: string[] = [];
    new WorkerSlice(spawnSync, () => 'MemTotal:       65011712 kB\n').launch(
      'task',
      1,
      'true',
      [],
      { env: { ...invalid.env, REZICS_WORKER_MEMORY_HIGH_GIB: '1.5' } },
      () => false,
      (message) => reports.push(message),
    );
    expect(existsSync(invalid.systemctlCalls)).toBe(false);
    expect(reports.join(' ')).toContain('REZICS_WORKER_MEMORY_HIGH_GIB');
  });

  test('falls back when there is no user manager and reports the reason', () => {
    const fake = fakeSystemd({
      systemctl: 'if [ "$2" = set-property ]; then echo "No medium found" >&2; exit 1; fi; echo 0',
    });
    const worker = new WorkerSlice();
    const reports: string[] = [];
    const result = worker.launch(
      'task',
      1,
      'true',
      ['worker-args'],
      { env: fake.env },
      () => false,
      (line) => reports.push(line),
    );

    expect(result.status).toBe(0);
    expect(fake.read(fake.systemctlCalls).slice(-7)).toEqual([
      '--user',
      'set-property',
      '--runtime',
      WORKER_SLICE,
      `CPUWeight=${WORKER_CPU_WEIGHT}`,
      `IOWeight=${WORKER_IO_WEIGHT}`,
      'MemoryHigh=48G',
    ]);
    expect(() => readFileSync(fake.systemdRunCalls, 'utf8')).toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('No medium found');
  });

  test('falls back when systemd-run fails before the wrapper starts', () => {
    const fake = fakeSystemd({ systemdRun: 'echo "scope creation failed" >&2; exit 1' });
    const worker = new WorkerSlice();
    const reports: string[] = [];
    const result = worker.launch(
      'task',
      2,
      'true',
      ['worker-args'],
      { env: fake.env },
      () => false,
      (line) => reports.push(line),
    );

    expect(result.status).toBe(0);
    expect(fake.read(fake.systemdRunCalls)).toContain('--unit=rezics-worker-task-2.scope');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('systemd-run exited with status 1');
  });
});
