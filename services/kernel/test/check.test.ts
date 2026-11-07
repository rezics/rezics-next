import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  KERNEL_CHECK_NONCE_LABEL,
  KERNEL_CHECK_PID_LABEL,
  checkPlan,
  cleanup,
  fileEnvironment,
  ownDiagnostics,
  reportCheckFailure,
  searchCheckRunArgs,
  startPostgresContainer,
} from '../scripts/check.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

/** A temporary module directory holding empty `files`, removed after `use` returns. */
function withModule(files: string[], use: (directory: string) => void): void {
  const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'kernel-check-fixture-'));
  try {
    for (const file of files) {
      mkdirSync(dirname(resolve(directory, file)), { recursive: true });
      writeFileSync(resolve(directory, file), '');
    }
    use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('without arguments the check runs every test file and the whole module', () => {
  withModule(['src/a.ts', 'test/b.test.ts', 'test/search/c.test.ts', 'test/support/d.ts'], (directory) => {
    expect(checkPlan([], directory)).toEqual({ files: null, tests: ['test/b.test.ts', 'test/search/c.test.ts'] });
  });
});

test('every check test process gets a 2000 ms pool acquisition timeout', () => {
  const env = fileEnvironment(
    { KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '100' },
    {
      url: 'postgres://rezics:rezics@127.0.0.1/rezics?',
      database: 'kernel_test_1',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig: '/tmp/reylo.yaml',
    },
  );
  expect(env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS).toBe('2000');
});

test('a focused check runs the named test files and checks only the named files', () => {
  const files = [
    'scripts/check.test.ts',
    'src/search/a.ts',
    'src/search/a.sql',
    'test/search/a.test.ts',
    'test/search/b.test.ts',
  ];
  withModule([...files, 'test/search/support/c.ts'], (directory) => {
    expect(
      checkPlan(
        [
          'test/search/a.test.ts',
          './src/search/a.ts',
          'src/search/a.sql',
          'test/search/support/c.ts',
          'src/search/a.ts',
        ],
        directory,
      ),
    ).toEqual({
      files: ['src/search/a.sql', 'src/search/a.ts', 'test/search/a.test.ts', 'test/search/support/c.ts'],
      tests: ['test/search/a.test.ts'],
    });
    expect(checkPlan(['scripts/check.test.ts'], directory)).toEqual({
      files: ['scripts/check.test.ts'],
      tests: ['scripts/check.test.ts'],
    });
    for (const wrong of ['src/search/missing.ts', '../outside.ts', '/etc/hostname', 'src/search']) {
      expect(() => checkPlan([wrong], directory)).toThrow(wrong);
    }
  });
});

test('a directory selector with no test files is refused rather than silently selecting no checks', () => {
  withModule(
    ['src/search/a.ts', 'src/search/a.sql', 'src/other/a.test.ts', 'test/support/c.ts', 'test/a.test.ts'],
    (directory) => {
      mkdirSync(resolve(directory, 'test/empty'));
      for (const refused of ['test/empty', 'src/search', 'src/other', 'test/support']) {
        expect(() => checkPlan([refused], directory)).toThrow(refused);
        for (const valid of ['src/search/a.ts', 'test/a.test.ts']) {
          expect(() => checkPlan([valid, refused], directory)).toThrow(refused);
          expect(() => checkPlan([refused, valid], directory)).toThrow(refused);
        }
      }
    },
  );
});

test('a test directory selects its real tests without selecting support files', () => {
  withModule(
    [
      'test/other.test.ts',
      'test/search/b.test.ts',
      'test/search/nested/a.test.ts',
      'test/search/support/c.ts',
      'test/search/nested/fixture.sql',
    ],
    (directory) => {
      const tests = ['test/search/b.test.ts', 'test/search/nested/a.test.ts'];
      expect(checkPlan(['test/search'], directory)).toEqual({ files: tests, tests });
      expect(checkPlan(['./test/search', 'test/search/nested', 'test/search/b.test.ts'], directory)).toEqual({
        files: tests,
        tests,
      });
      expect(checkPlan(['test/search/nested'], directory)).toEqual({
        files: ['test/search/nested/a.test.ts'],
        tests: ['test/search/nested/a.test.ts'],
      });
    },
  );
});

test('a focused typecheck reports only diagnostics in the named files', () => {
  const output = [
    "src/search/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/access/other.ts(4,1): error TS2304: Cannot find name 'x'.",
    'test/search/a.test.ts(30,9): error TS2769: No overload matches this call.',
    "  Overload 1 of 2, '(value: number): void', gave the following error.",
    'src/access/other.ts(9,1): error TS2769: No overload matches this call.',
    "  Overload 1 of 2, '(value: number): void', gave the following error.",
    "error TS5083: Cannot read file 'tsconfig.base.json'.",
    'src/search/a.sql(1,1): error reylo1: column "missing" does not exist',
    '  Detail: relation items has columns id, name.',
    'src/access/other.sql(1,1): error reylo14: relation "other" does not exist',
    'error reylo5: CONNECTION_CLOSED at 127.0.0.1:34646/rezics',
    '',
  ].join('\n');
  expect(ownDiagnostics(output, ['src/search/a.ts', 'src/search/a.sql', 'test/search/a.test.ts'])).toEqual([
    "src/search/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "test/search/a.test.ts(30,9): error TS2769: No overload matches this call.\n  Overload 1 of 2, '(value: number): void', gave the following error.",
    "error TS5083: Cannot read file 'tsconfig.base.json'.",
    'src/search/a.sql(1,1): error reylo1: column "missing" does not exist\n  Detail: relation items has columns id, name.',
    'error reylo5: CONNECTION_CLOSED at 127.0.0.1:34646/rezics',
  ]);
  expect(ownDiagnostics(output, null).join('\n')).toContain('src/access/other.sql(1,1): error reylo14');
  const elsewhere = output
    .split('\n')
    .filter((line) => !line.startsWith('error'))
    .join('\n');
  expect(ownDiagnostics(elsewhere, ['src/search/b.ts'])).toEqual([]);
});

test("the check's PostgreSQL container keeps its logs when it exits early and is removed by cleanup", () => {
  const calls: string[][] = [];
  const containers = new Map<string, string>();
  const attemptNonces = new Set<string>();
  const stubDocker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') {
      const nonce = args
        .find((arg) => arg.startsWith(`${KERNEL_CHECK_NONCE_LABEL}=`))
        ?.slice(`${KERNEL_CHECK_NONCE_LABEL}=`.length);
      if (nonce) containers.set(nonce, 'postgres-container');
      return 'postgres-container';
    }
    if (args[0] === 'ps') return containers.get(args.at(-1)!.slice(`label=${KERNEL_CHECK_NONCE_LABEL}=`.length)) ?? '';
    if (args[0] === 'rm') {
      for (const [nonce, id] of containers) if (id === args.at(-1)) containers.delete(nonce);
    }
    if (args[0] === 'inspect')
      throw new Error(`docker inspect ${args.at(-1)} failed with status 1: Error: No such object: ${args.at(-1)}`);
    return '';
  };

  const postgresContainer = startPostgresContainer(stubDocker, { attemptNonces, runId: 'host-run' });

  const run = calls.find((args) => args[0] === 'run')!;
  expect(calls[0]).toEqual([
    'volume',
    'create',
    '--label',
    `${KERNEL_CHECK_PID_LABEL}=${process.pid}`,
    '--label',
    `${KERNEL_CHECK_NONCE_LABEL}=${[...attemptNonces][0]}`,
    '--label',
    'rezics.check.run=host-run',
    `rezics-kernel-pg-${process.pid}-${[...attemptNonces][0]}`,
  ]);
  expect(run).toContain('--rm');
  expect(run).toContain('shared_buffers=32MB');
  expect(run).toContain(
    `type=volume,source=rezics-kernel-pg-${process.pid}-${[...attemptNonces][0]},destination=/var/lib/postgresql`,
  );
  expect(postgresContainer).toBe('postgres-container');

  containers.set('search-nonce', 'search-container');
  attemptNonces.add('search-nonce');
  cleanup(['search-container', postgresContainer], stubDocker, true, attemptNonces);
  expect(calls.filter((args) => args[0] === 'rm')).toEqual([
    ['rm', '-f', '-v', 'postgres-container'],
    ['rm', '-f', '-v', 'search-container'],
  ]);
  expect(
    calls.some(
      (args) =>
        args[0] === 'volume' &&
        args[1] === 'ls' &&
        args.includes(`label=${KERNEL_CHECK_NONCE_LABEL}=${[...attemptNonces][0]}`),
    ),
  ).toBe(true);
});

test('a failed Kernel check reports its exact PostgreSQL container identity', () => {
  const output: string[] = [];
  const result = reportCheckFailure(
    'postgres-container-exact',
    ['first SQL failure: ECONNREFUSED at 127.0.0.1:39201/rezics'],
    () => '',
    (message) => output.push(message),
    'check-host-a',
  );

  expect(result).toBe(1);
  expect(output.join('')).toContain('kernel check database container=postgres-container-exact');
});

test('a failed postgres create reaps the check nonce', () => {
  const calls: string[][] = [];
  let present = true;
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') throw new Error('docker run failed with status 125: daemon error');
    if (args[0] === 'ps') return present ? 'half-pg' : '';
    if (args[0] === 'rm') present = false;
    return '';
  };
  expect(() => startPostgresContainer(docker, { nonce: 'nonce-check' })).toThrow(/status 125/);
  expect(calls[0]).toContain(`${KERNEL_CHECK_PID_LABEL}=${process.pid}`);
  expect(calls[0]).toContain(`${KERNEL_CHECK_NONCE_LABEL}=nonce-check`);
  expect(calls[1]![0]).toBe('run');
  expect(calls[2]).toEqual(['ps', '-aq', '--filter', `label=${KERNEL_CHECK_NONCE_LABEL}=nonce-check`]);
  expect(calls[3]).toEqual(['rm', '-f', '-v', 'half-pg']);
  expect(calls[4]).toEqual(['ps', '-aq', '--filter', `label=${KERNEL_CHECK_NONCE_LABEL}=nonce-check`]);
  expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
});

test('a postgres spawn timeout reaps the nonce, retries once, then keeps the second failure', () => {
  const calls: string[][] = [];
  const present = new Set<string>();
  const attempts = new Set<string>();
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') {
      const nonce = args
        .find((arg) => arg.startsWith(`${KERNEL_CHECK_NONCE_LABEL}=`))
        ?.slice(`${KERNEL_CHECK_NONCE_LABEL}=`.length);
      if (nonce) present.add(nonce);
      throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    if (args[0] === 'ps') {
      const nonce = args.at(-1)?.slice(`label=${KERNEL_CHECK_NONCE_LABEL}=`.length);
      return nonce && present.has(nonce) ? `half-${nonce}` : '';
    }
    if (args[0] === 'rm') {
      for (const nonce of present) if (args.at(-1) === `half-${nonce}`) present.delete(nonce);
    }
    return '';
  };
  expect(() => startPostgresContainer(docker, { nonce: 'nonce-check', attemptNonces: attempts })).toThrow(/ETIMEDOUT/);
  const runs = calls.filter((args) => args[0] === 'run');
  expect(runs).toHaveLength(2);
  expect(runs[0]).toContain(`${KERNEL_CHECK_NONCE_LABEL}=nonce-check`);
  const retryNonce =
    runs[1]!
      .find((arg, index) => runs[1]![index - 1] === '--label' && arg.startsWith(`${KERNEL_CHECK_NONCE_LABEL}=`))
      ?.slice(`${KERNEL_CHECK_NONCE_LABEL}=`.length) ?? '';
  expect(retryNonce).not.toBe('');
  expect(retryNonce).not.toBe('nonce-check');
  expect(calls[2]).toEqual(['ps', '-aq', '--filter', `label=${KERNEL_CHECK_NONCE_LABEL}=nonce-check`]);
  expect(calls).toContainEqual(['rm', '-f', '-v', 'half-nonce-check']);
  expect(calls).toContainEqual(['rm', '-f', '-v', `half-${retryNonce}`]);
  expect(attempts).toEqual(new Set(['nonce-check', retryNonce]));
  expect(present.size).toBe(0);
});

test('OpenSearch check run carries a nonce and cleanup distinguishes requested removal from observed absence', () => {
  const args = searchCheckRunArgs('rezics-search:test', 'search-nonce');
  expect(args[0]).toBe('run');
  expect(args).toContain(`${KERNEL_CHECK_NONCE_LABEL}=search-nonce`);
  const calls: string[][] = [];
  cleanup(
    ['search-only'],
    (command) => {
      calls.push(command);
      if (command[0] === 'rm') throw new Error('docker rm ETIMEDOUT');
      if (command[0] === 'inspect') throw new Error('Error: No such object: search-only');
      return '';
    },
    true,
    new Set(),
  );
  expect(calls[0]).toEqual(['rm', '-f', '-v', 'search-only']);
  expect(calls[1]).toEqual(['inspect', '-f', '{{.Id}}', 'search-only']);

  expect(() =>
    cleanup(
      ['unobserved'],
      (command) => {
        if (command[0] === 'rm') throw new Error('docker rm ETIMEDOUT');
        throw new Error('docker inspect daemon unavailable');
      },
      true,
      new Set(),
    ),
  ).toThrow(/unsettled.*daemon unavailable/);
});
