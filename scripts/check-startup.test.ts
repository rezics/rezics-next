import { expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  AUTH_STARTUP_TESTS,
  STARTUP_UNIT_TESTS,
  checkStartup,
  startupCommands,
  startupPath,
  type StartupCommand,
} from './check-startup.ts';

const repository = resolve(import.meta.dir, '..');
const task = resolve(repository, 'node_modules/.bin/task');

test('startup PATH puts the pinned Go Task ahead of an inherited host PATH', () => {
  expect(startupPath('/usr/bin')).toBe(`${resolve(repository, 'node_modules/.bin')}:/usr/bin`);
  expect(startupPath()).toBe(resolve(repository, 'node_modules/.bin'));
});

test('Auth composition receives a migrated DATABASE_URL, native acceptance does not, and native status 23 is kept', async () => {
  const seen: { phase: string; path: string; database?: string }[] = [];
  let removed = 0;
  const status = await checkStartup(
    true,
    { PATH: '/usr/bin', DATABASE_URL: 'postgres://inherited/compiler' },
    {
      prepareCompilerDatabase: async () => ({
        url: 'postgres://fixture/auth-composition',
        remove: async () => {
          removed += 1;
        },
      }),
      runCommand: async (step: StartupCommand, env: NodeJS.ProcessEnv) => {
        seen.push({ phase: step.phase, path: env.PATH ?? '', database: env.DATABASE_URL });
        return step.phase === 'transport-and-placement' ? 23 : 0;
      },
    },
  );
  expect(status).toBe(23);
  expect(removed).toBe(1);
  expect(seen.map((step) => step.phase)).toEqual(startupCommands(true).map((step) => step.phase));
  for (const step of seen) expect(step.path.startsWith(`${resolve(repository, 'node_modules/.bin')}:`)).toBe(true);
  expect(seen.find((step) => step.phase === 'auth-composition')?.database).toBe('postgres://fixture/auth-composition');
  expect(seen.find((step) => step.phase === 'auth-native-browser')?.database).toBeUndefined();
  expect(seen.find((step) => step.phase === 'home-native-browser')?.database).toBeUndefined();
});

test('owned Auth composition cleanup retains native compiler status 23 beside the cleanup diagnostic', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const status = await checkStartup(
      false,
      { PATH: '/usr/bin' },
      {
        prepareCompilerDatabase: async () => ({
          url: 'postgres://fixture/auth-composition',
          remove: async () => {
            throw new Error('docker rm ETIMEDOUT');
          },
        }),
        runCommand: async (step) => (step.phase === 'auth-composition' ? 23 : 0),
      },
    );
    expect(status).toBe(23);
    const diagnostic = output.mock.calls.flat().join('\n');
    expect(diagnostic).toContain('phase=database-cleanup');
    expect(diagnostic).toContain('Auth composition status 23');
    expect(diagnostic).toContain('docker rm ETIMEDOUT');
  } finally {
    output.mockRestore();
  }
});

test('the combined selection keeps the existing suites and the pinned task binary', () => {
  expect(STARTUP_UNIT_TESTS).toContain('scripts/check-startup.test.ts');
  expect(AUTH_STARTUP_TESTS).toEqual([
    'services/auth/test/dev-stack-config.test.ts',
    'services/auth/scripts/dev-stack.test.ts',
  ]);
  expect(Bun.file(task).size).toBeGreaterThan(0);
});
