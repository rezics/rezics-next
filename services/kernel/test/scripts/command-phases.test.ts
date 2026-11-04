import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  KERNEL_COMMAND_PHASES,
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
  expect(KERNEL_COMMAND_PHASES).toEqual(['database-image', 'migrations', 'sql-schema', 'compiler', 'cleanup']);
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
    expect(args).toContain('type=volume,destination=/var/lib/postgresql,volume-label=rezics.kernel.derived.pid=4242');
    expect(args).not.toContain('--tmpfs');
    expect(args).not.toContain('--rm');
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
    .map((line) => line.split('\t')[0]);
  expect(names).toEqual([
    'database-image',
    'database-image',
    'migrations',
    'migrations',
    'compiler',
    'compiler',
    'cleanup',
    'cleanup',
  ]);
});
