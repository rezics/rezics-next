import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { main, runHostTests, runWebHostTests } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/web-host-placement-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

type Route = { file: string; placement: 'auth-lane' | 'raw-host' };

function hostFiles(directory = app): string[] {
  return [...new Set(new Bun.Glob('tests/**/*.host.test.ts').scanSync({ cwd: directory }))].sort();
}

function packageTokens(script: string): string[] {
  return (script.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^(['"])(.*)\1$/, '$2'));
}

test('the host command used by the general Web check routes Auth through its owned database lane', async () => {
  const packageJson = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const routeCounts = new Map<string, Route['placement'][]>();
  const record = (file: string, placement: Route['placement']) => {
    const routes = routeCounts.get(file) ?? [];
    routes.push(placement);
    routeCounts.set(file, routes);
  };
  let placements = 0;
  let commands = 0;

  await runHostTests(
    { GOAL_TASK_ID: 'web-host-placement', WEB_TEST_MARKER: 'preserved' },
    async (run, local, env) => {
      placements += 1;
      expect(env.WEB_TEST_MARKER).toBe('preserved');
      expect(run.command).toEqual(['bun', 'run', 'test:host']);
      return local({ REZICS_STACK_SLOT: '1' });
    },
    async (label, command, args, env) => {
      commands += 1;
      expect([label, command, ...args]).toEqual(['host tests', 'bun', 'run', 'test:host']);
      expect(env).toMatchObject({ WEB_TEST_MARKER: 'preserved', REZICS_STACK_SLOT: '1' });

      const dispatch = packageTokens(packageJson.scripts['test:host']!);
      if (dispatch[0] !== 'bun') throw new Error(`Unsupported test:host command: ${packageJson.scripts['test:host']}`);

      if (dispatch[1] === 'scripts/check.ts' && dispatch[2] === '--host') {
        const check = (await import('../scripts/check.ts')) as unknown as {
          main(
            args: string[],
            runtime: {
              hostTests: {
                directory: string;
                runAuthBinding: () => Promise<void>;
                runNative: (files: string[]) => Promise<void>;
              };
            },
          ): Promise<void>;
        };
        await check.main(dispatch.slice(2), {
          hostTests: {
            directory: app,
            runAuthBinding: async () => record('tests/auth-binding.host.test.ts', 'auth-lane'),
            runNative: async (files) => files.forEach((file) => record(file, 'raw-host')),
          },
        });
        return;
      }

      if (dispatch[1] === 'test') {
        // Model the package runner's test invocation after its shell expands the existing host-file glob.
        for (const file of hostFiles()) record(file, 'raw-host');
        return;
      }

      throw new Error(`Unsupported test:host command: ${packageJson.scripts['test:host']}`);
    },
  );

  const files = hostFiles();
  expect(placements).toBe(1);
  expect(commands).toBe(1);
  expect([...routeCounts.keys()].sort()).toEqual(files);
  for (const file of files) expect(routeCounts.get(file)).toHaveLength(1);
  expect(routeCounts.get('tests/auth-binding.host.test.ts')).toEqual(['auth-lane']);
  expect([...routeCounts].filter(([, routes]) => routes.includes('auth-lane'))).toHaveLength(1);
});

test('discovers a newly added host file and routes every selected file exactly once', async () => {
  const directory = join(temporary, 'discovery');
  const tests = join(directory, 'tests');
  mkdirSync(join(tests, 'native', 'deeper'), { recursive: true });
  mkdirSync(join(directory, 'other'), { recursive: true });
  const selected = [
    'tests/auth-binding.host.test.ts',
    'tests/check-fresh.host.test.ts',
    'tests/native/deeper/stack.host.test.ts',
    'tests/native/native-purchases.host.test.ts',
  ];
  for (const file of selected) writeFileSync(join(directory, file), '');
  writeFileSync(join(tests, 'ordinary.test.ts'), '');
  writeFileSync(join(tests, 'native', 'helper.ts'), '');
  writeFileSync(join(directory, 'other', 'outside.host.test.ts'), '');

  let authRuns = 0;
  const nativeRuns: string[][] = [];
  const nativeEnvironments: Array<string | undefined> = [];
  await runWebHostTests(
    { WEB_TEST_MARKER: 'preserved' },
    {
      directory,
      runAuthBinding: async (env) => {
        authRuns += 1;
        expect(env.WEB_TEST_MARKER).toBe('preserved');
      },
      runNative: async (files, env) => {
        nativeEnvironments.push(env.WEB_TEST_MARKER);
        nativeRuns.push(files);
      },
    },
  );

  expect(authRuns).toBe(1);
  expect(nativeEnvironments).toEqual(['preserved']);
  expect(nativeRuns).toEqual([
    [
      'tests/check-fresh.host.test.ts',
      'tests/native/deeper/stack.host.test.ts',
      'tests/native/native-purchases.host.test.ts',
    ],
  ]);
  expect([...selected].sort()).toEqual(['tests/auth-binding.host.test.ts', ...nativeRuns[0]!].sort());
});

test('the explicit Auth-only entry stays focused and propagates a lane failure', async () => {
  let authRuns = 0;
  await main(['--auth-binding-host'], {
    authBindingHostTest: async () => {
      authRuns += 1;
    },
    hostTests: {
      directory: join(temporary, 'missing'),
      runAuthBinding: async () => {
        throw new Error('general host dispatch must not run');
      },
    },
  });
  expect(authRuns).toBe(1);

  await expect(
    main(['--auth-binding-host'], {
      authBindingHostTest: async () => {
        throw new Error('auth lane failed');
      },
    }),
  ).rejects.toThrow('auth lane failed');
  await expect(main(['--auth-binding-host', 'tests/auth-binding.host.test.ts'])).rejects.toThrow(
    'Usage: bun apps/web/scripts/check.ts --auth-binding-host',
  );
});

test('Auth and native host failures remain nonzero and the Auth lane cleanup runs', async () => {
  const directory = join(temporary, 'failures');
  const tests = join(directory, 'tests');
  mkdirSync(join(tests, 'native'), { recursive: true });
  writeFileSync(join(tests, 'auth-binding.host.test.ts'), '');
  writeFileSync(join(tests, 'native-failure.host.test.ts'), '');
  writeFileSync(join(tests, 'native', 'nested-failure.host.test.ts'), '');
  let cleanup = false;
  let nativeRun = false;

  await expect(
    runWebHostTests(
      { WEB_TEST_MARKER: 'preserved' },
      {
        directory,
        runAuthBinding: async () => {
          try {
            throw new Error('auth lane failed');
          } finally {
            cleanup = true;
          }
        },
        runNative: async (files, env) => {
          nativeRun = true;
          expect(env.WEB_TEST_MARKER).toBe('preserved');
          expect(files).toEqual(['tests/native-failure.host.test.ts', 'tests/native/nested-failure.host.test.ts']);
          throw new Error('native host test failed: tests/native/nested-failure.host.test.ts');
        },
      },
    ),
  ).rejects.toThrow(/auth lane failed[\s\S]*native host test failed: tests\/native\/nested-failure\.host\.test\.ts/);

  expect(cleanup).toBe(true);
  expect(nativeRun).toBe(true);
});
