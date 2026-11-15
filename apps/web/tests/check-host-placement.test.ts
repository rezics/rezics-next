import { expect, test } from 'bun:test';
import { main as runWebCheck, runHostTests } from '../scripts/check.ts';
import { resolve } from 'node:path';

test('web host tests are placed with stack-run and run locally through its fallback', async () => {
  let placed: Parameters<typeof runHostTests>[1] extends (run: infer R, ...args: never[]) => unknown ? R : never;
  let executed: string[] | undefined;
  const env = { GOAL_TASK_ID: 'worker', WEB_TEST_MARKER: 'kept' };

  await runHostTests(
    env,
    async (run, local, placementEnv) => {
      placed = run;
      expect(placementEnv).toBe(env);
      expect(await local({ REZICS_STACK_SLOT: '1' })).toBe(0);
      return 0;
    },
    async (label, command, args, commandEnv) => {
      executed = [label, command, ...args, commandEnv.WEB_TEST_MARKER ?? ''];
    },
  );

  expect(placed).toMatchObject({
    label: 'web host tests',
    command: ['bun', 'run', 'test:host'],
  });
  expect(executed).toEqual(['host tests', 'bun', 'run', 'test:host', 'kept']);
});

test('host tests are not run locally when stack-run places them remotely', async () => {
  let localRuns = 0;
  await runHostTests(
    { GOAL_TASK_ID: 'worker' },
    async () => 0,
    async () => {
      localRuns += 1;
    },
  );
  expect(localRuns).toBe(0);
});

test('a remote host test failure is returned as a check failure', async () => {
  await expect(
    runHostTests(
      { GOAL_TASK_ID: 'worker' },
      async () => 17,
      async () => {
        throw new Error('must not run locally');
      },
    ),
  ).rejects.toThrow('host tests failed with status 17');
});


test('Web driver return declarations match the selected execution branch', async () => {
  const app = resolve(import.meta.dir, '..');
  const timings = ['apps/web/.cache/check-timings.json'];
  const cases = [
    { args: ['--host', 'tests/native/hosted-book-journey.host.test.ts'], returns: [] },
    { args: ['--personal-host'], returns: [] },
    { args: ['--auth-binding-host'], returns: [] },
    { args: ['--prepare-only'], returns: ['apps/web/.dev.vars'] },
    { args: ['--browser', '--report', '.temp/web-return-contract', 'tests/check-host-placement.test.ts'], returns: ['.temp/web-return-contract'] },
    { args: ['--tests-only', 'tests/check-host-placement.test.ts'], returns: timings },
    { args: ['--tests-only', 'tests/native/hosted-book-journey.host.test.ts'], returns: timings },
    { args: ['--stories'], returns: timings },
    { args: [], returns: timings },
  ];
  const previousExitCode = process.exitCode;
  try {
    for (const selection of cases) {
      let declared: string[] | undefined;
      await runWebCheck(selection.args, {
        invocationDirectory: app,
        route: async (run) => {
          declared = run.returns;
          return 0;
        },
      });
      expect(declared).toEqual(selection.returns);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});
