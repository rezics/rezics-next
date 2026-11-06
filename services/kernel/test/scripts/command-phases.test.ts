import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  KERNEL_COMMAND_PHASES,
  KERNEL_COMPILER_NESTED_PHASES,
  commandObservation,
  formatCommandObservation,
  parseIoPressure,
  parseMemoryStat,
  withCommandPhase,
} from '../../scripts/command-phases.ts';
import { throwawayDatabaseRunArgs } from '../../scripts/derived.ts';
import { runKernelTypecheck } from '../../scripts/typecheck.ts';

const repository = resolve(import.meta.dir, '../../../..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/kernel-typecheck-phases-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const physicalAdmission = {
  outcome: 'admitted' as const,
  runId: 'fixture',
  scope: 'fixture.scope',
  supervisor: { pid: 1, started: '1', group: 1 },
};

test('Kernel command phases pair without a duration assertion', async () => {
  const file = join(temporaryDirectory(), 'command-phases.tsv');
  let clock = 1_000_000_000n;
  const env = { REZICS_CHECK_PHASES: file };
  await withCommandPhase(
    'compiler',
    () => 0,
    env,
    () => (clock += 1n),
  );
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^compiler\tstart\t\d+$/);
  expect(lines[1]).toMatch(/^compiler\tend\t\d+$/);
  expect(KERNEL_COMMAND_PHASES).toEqual([
    'database-image',
    'migrations',
    'sql-analysis',
    'compiler',
    'sql-schema',
    'cleanup',
  ]);
  expect(KERNEL_COMPILER_NESTED_PHASES).toEqual(['client-emit', 'typecheck', 'tsc', 'construct', 'openapi']);
});

test('slice memory and IO pressure parse without inventing zeros', () => {
  expect(parseMemoryStat('anon 11\nfile 22\ninactive_file 33\n')).toEqual({
    anon: 11,
    file: 22,
    inactive_file: 33,
  });
  expect(parseIoPressure('some avg10=1.25 avg60=0.00 total=0\nfull avg10=0.40 avg60=0.00 total=0\n')).toEqual({
    someAvg10: 1.25,
    fullAvg10: 0.4,
  });
  const text = formatCommandObservation(
    'kernel typecheck',
    commandObservation(['bun', 'scripts/typecheck.ts'], repository, { KERNEL_CHECK_CONCURRENCY: '2' }, '/missing'),
  );
  expect(text).toContain('kernel typecheck observation');
  expect(text).toContain('command=bun scripts/typecheck.ts');
  expect(text).toContain('concurrency=2');
  expect(text).not.toContain('anon=');
});

test('the one-run compiler database stays in the run slice on a labelled volume', () => {
  const previousRemote = process.env.KERNEL_CHECK_ON_REMOTE;
  const previousSlice = process.env.REZICS_CHECK_SLICE;
  process.env.KERNEL_CHECK_ON_REMOTE = '1';
  process.env.REZICS_CHECK_SLICE = 'rezics-check-fixture.slice';
  try {
    const args = throwawayDatabaseRunArgs(4242);
    expect(args).toContain('--cgroup-parent=rezics-check-fixture.slice');
    expect(args).toContain('--mount');
    const mount = args.find((arg) => arg.startsWith('type=volume,'));
    expect(mount).toContain('destination=/var/lib/postgresql');
    expect(mount).toContain('volume-label=rezics.kernel.derived.pid=4242');
    expect(args).not.toContain('--tmpfs');
    expect(args).toContain('--rm');
  } finally {
    if (previousRemote === undefined) delete process.env.KERNEL_CHECK_ON_REMOTE;
    else process.env.KERNEL_CHECK_ON_REMOTE = previousRemote;
    if (previousSlice === undefined) delete process.env.REZICS_CHECK_SLICE;
    else process.env.REZICS_CHECK_SLICE = previousSlice;
  }
});

test('admitted typecheck uses one throwaway database for compiler work and records its phases', async () => {
  const directory = temporaryDirectory();
  const phases = join(directory, 'command-phases.tsv');
  for (const executable of ['tsc', 'bun']) {
    const path = join(directory, executable);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  let databases = 0;
  const status = await runKernelTypecheck(
    {
      PATH: `${directory}:${process.env.PATH}`,
      REZICS_CHECK_PHASES: phases,
    },
    {
      recognize: () => physicalAdmission,
      place: async () => {
        throw new Error('nested placement');
      },
      withThrowawayDatabase: async (work) => {
        databases += 1;
        await withCommandPhase('database-image', () => undefined, { REZICS_CHECK_PHASES: phases });
        await withCommandPhase('migrations', () => undefined, { REZICS_CHECK_PHASES: phases });
        try {
          return await work({
            PATH: `${directory}:${process.env.PATH}`,
            DATABASE_URL: 'postgres://throwaway.test/db',
            REZICS_CHECK_PHASES: phases,
          });
        } finally {
          await withCommandPhase('cleanup', () => undefined, { REZICS_CHECK_PHASES: phases });
        }
      },
    },
  );
  expect(status).toBe(0);
  expect(databases).toBe(1);
  const names = readFileSync(phases, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('\t')[0]!);
  expect(names).toEqual([
    'database-image',
    'database-image',
    'migrations',
    'migrations',
    'sql-analysis',
    'sql-analysis',
    'compiler',
    'typecheck',
    'tsc',
    'tsc',
    'typecheck',
    'construct',
    'construct',
    'compiler',
    'cleanup',
    'cleanup',
  ]);
});

function phaseNames(file: string): string[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.replace(/\t.*$/, ''));
}

function writeExecutable(directory: string, name: string, script: string): void {
  const path = join(directory, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

test('nested compiler markers pair in publication order and skip after a failed tsc', async () => {
  const directory = temporaryDirectory();
  const phases = join(directory, 'command-phases.tsv');
  writeExecutable(directory, 'bun', '#!/bin/sh\nexit 0\n');
  writeExecutable(directory, 'tsc', '#!/bin/sh\nexit 0\n');
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    REZICS_CHECK_PHASES: phases,
    DATABASE_URL: 'postgres://throwaway.test/db',
  };
  const dependencies = {
    recognize: () => physicalAdmission,
    place: async () => {
      throw new Error('nested placement');
    },
    outputTree: async (_root: string, run: () => Promise<number>) => run(),
  };
  expect(await runKernelTypecheck(env, dependencies, ['--emit-client', '--emit-openapi'])).toBe(0);
  expect(phaseNames(phases)).toEqual([
    'sql-analysis',
    'sql-analysis',
    'compiler',
    'client-emit',
    'client-emit',
    'typecheck',
    'tsc',
    'tsc',
    'typecheck',
    'construct',
    'construct',
    'openapi',
    'openapi',
    'compiler',
  ]);
  writeFileSync(phases, '');
  writeExecutable(directory, 'tsc', '#!/bin/sh\nexit 2\n');
  expect(await runKernelTypecheck({ ...env, REZICS_CHECK_PHASES: phases }, dependencies, [])).toBe(2);
  expect(phaseNames(phases)).toEqual([
    'sql-analysis',
    'sql-analysis',
    'compiler',
    'typecheck',
    'tsc',
    'tsc',
    'typecheck',
    'compiler',
  ]);
});
