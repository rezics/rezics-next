import { expect, test } from 'bun:test';
import { isolatedPostgresSocketDir } from '../../../scripts/compiler-database.ts';
import { cleanup, cleanupStale, startPostgresContainer } from './check.ts';

test('the check database keeps its data on a disk-backed volume, not a memory-capped tmpfs', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    return 'postgres-container';
  };

  startPostgresContainer(docker);

  const run = calls[0]!;
  expect(run[0]).toBe('run');
  expect(run).toContain('--rm');
  expect(run).toContain('--mount');
  expect(run).toContain(
    `type=volume,destination=/var/lib/postgresql,volume-label=rezics.kernel.check.pid=${process.pid}`,
  );
  expect(run).not.toContain('--tmpfs');
  expect(run).toContain(`rezics.kernel.check.pid=${process.pid}`);
  expect(run).toContain('fsync=off');
  expect(run).toContain('synchronous_commit=off');
  expect(run).toContain('full_page_writes=off');
});

test('isolated check databases bind a unix socket instead of publishing a port', () => {
  const previous = process.env.REZICS_ISOLATED_STACK_CONTAINER;
  process.env.REZICS_ISOLATED_STACK_CONTAINER = 'pause-stack-1';
  try {
    const calls: string[][] = [];
    startPostgresContainer((args) => {
      calls.push(args);
      return 'postgres-container';
    });
    const run = calls[0]!;
    expect(run).toContain('--network');
    expect(run).toContain('container:pause-stack-1');
    expect(run).toContain(`${isolatedPostgresSocketDir(process.pid)}:/var/run/postgresql`);
    expect(run).not.toContain('-p');
  } finally {
    if (previous === undefined) delete process.env.REZICS_ISOLATED_STACK_CONTAINER;
    else process.env.REZICS_ISOLATED_STACK_CONTAINER = previous;
  }
});

test('removing a check database container removes its volume', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    return '';
  };

  cleanup(['postgres-container'], docker);

  expect(calls).toEqual([['rm', '-f', '-v', 'postgres-container']]);
});

test('stale check database cleanup removes its volume through the injected docker command', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    return args[0] === 'ps' ? 'stale-container 2147483647' : '';
  };

  cleanupStale('check', docker);

  expect(calls[0]).toEqual([
    'ps',
    '-a',
    '--filter',
    'label=rezics.kernel.check.pid',
    '--format',
    '{{.ID}} {{.Label "rezics.kernel.check.pid"}}',
  ]);
  expect(calls[1]).toEqual(['rm', '-f', '-v', 'stale-container']);
});
